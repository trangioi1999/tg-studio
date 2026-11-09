//! An agent handing part of its task to another agent (tg-bridge `delegate`,
//! `docs/superpowers/specs/2026-11-09-subagents-and-git-changes-design.md` §3).
//!
//! The child works in its own draft, made from a snapshot of the parent's folder, so two
//! agents never write the same file at once. When it finishes, its files come back into
//! the parent's folder one by one with a three-way merge; a file both changed differently
//! is a conflict, left for the parent to settle.

use std::{collections::HashMap, path::{Path, PathBuf}, sync::Mutex, time::Duration};

use serde::Serialize;
use serde_json::Value;

use crate::{adapters::AgentKind, worktree::{git, Worktree}};

/// Children one parent may have running at once.
pub const MAX_RUNNING: usize = 3;
/// Longest single wait in `wait_delegated`, under the CLIs' MCP tool timeouts.
pub const MAX_WAIT: Duration = Duration::from_secs(50);
/// Longest summary handed back to the parent.
pub const MAX_SUMMARY: usize = 4_000;

/// Commits the folder as it is now (tracked, staged and untracked files, minus what
/// `.gitignore` ignores) on top of HEAD, without touching any branch or the user's index.
pub fn snapshot(dir: &Path) -> Result<String, String> {
    let git_path = |p: &str| git(dir, &["rev-parse", "--git-path", p], None).map(|out| dir.join(out.trim()));
    let index = git_path(&format!("tg-snapshot-{}.index", uuid::Uuid::new_v4().simple()))?;
    let real = git_path("index")?;
    let made = (|| {
        if real.exists() { std::fs::copy(&real, &index).map_err(|e| format!("Không chụp được thư mục: {e}"))?; }
        // Not `:(exclude).tg`: git refuses any pathspec naming an ignored path, and the
        // first child's draft makes `.tg/` and ignores it. Add everything, then drop `.tg/`.
        crate::worktree::git_index(dir, &index, &["add", "-A", "--", "."], None)?;
        crate::worktree::git_index(dir, &index, &["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".tg"], None)?;
        let tree = crate::worktree::git_index(dir, &index, &["write-tree"], None)?;
        let head = git(dir, &["rev-parse", "HEAD"], None)?;
        // An internal commit only: its own identity, so a repo without user.name still works.
        let commit = git(dir, &["-c", "user.name=TG Studio", "-c", "user.email=noreply@tg-studio.local",
            "commit-tree", tree.trim(), "-p", head.trim(), "-m", "TG Studio: ảnh chụp thư mục cho agent con"], None)?;
        Ok(commit.trim().to_owned())
    })();
    let _ = std::fs::remove_file(&index);
    made
}

/// What came back into the parent's folder.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Merged {
    pub applied: Vec<String>,
    pub conflicts: Vec<String>,
}

/// Raw output of a git command, or `None` when it fails (a path missing from a tree).
fn git_bytes(cwd: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = crate::env::std_command("git").current_dir(cwd).env("PATH", crate::env::login_path())
        .args(args).stdin(std::process::Stdio::null()).output().ok()?;
    out.status.success().then_some(out.stdout)
}

fn read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Không đọc được {}: {e}", path.display())),
    }
}

fn write(path: &Path, bytes: Option<&[u8]>) -> Result<(), String> {
    match bytes {
        Some(bytes) => {
            if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| format!("Không tạo được thư mục: {e}"))?; }
            std::fs::write(path, bytes).map_err(|e| format!("Không ghi được {}: {e}", path.display()))
        }
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Không xoá được {}: {e}", path.display())),
            _ => Ok(()),
        },
    }
}

/// Three-way merge of one text file; `None` when both sides changed the same lines.
fn merge_text(dir: &Path, ours: &[u8], base: &[u8], theirs: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let tmp = std::env::temp_dir().join(format!("tg-merge-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let files = [("ours", ours), ("base", base), ("theirs", theirs)];
    let result = (|| {
        for (name, bytes) in files { std::fs::write(tmp.join(name), bytes).map_err(|e| e.to_string())?; }
        let out = crate::env::std_command("git").current_dir(dir).env("PATH", crate::env::login_path())
            .arg("merge-file").arg("-p").arg(tmp.join("ours")).arg(tmp.join("base")).arg(tmp.join("theirs"))
            .stdin(std::process::Stdio::null()).output().map_err(|e| format!("Không chạy được Git: {e}"))?;
        // The exit code is the number of conflicts; negative (as unsigned, large) is an error.
        match out.status.code() {
            Some(0) => Ok(Some(out.stdout)),
            Some(n) if (1..=127).contains(&n) => Ok(None),
            _ => Err(format!("Git không gộp được tệp: {}", String::from_utf8_lossy(&out.stderr).trim())),
        }
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Brings the child's changes (against `base`, the snapshot it started from) into `dest`,
/// the parent's folder. A file the parent left as it was takes the child's version; a file
/// both changed is merged line by line, and stays as the parent has it if that conflicts.
pub fn merge_back(dest: &Path, child: &Worktree, base: &str) -> Result<Merged, String> {
    let mut merged = Merged::default();
    for file in crate::diff::pending(child)? {
        let path = file.path;
        let target = crate::workspace::resolve(dest, &path)?;
        let ours = read(&target)?;
        let theirs = read(&crate::workspace::resolve(&child.path, &path)?)?;
        let original = git_bytes(&child.path, &["cat-file", "blob", &format!("{base}:{path}")]);
        if ours == theirs {
            merged.applied.push(path);
        } else if ours == original {
            write(&target, theirs.as_deref())?;
            merged.applied.push(path);
        } else {
            let text = |b: &Option<Vec<u8>>| b.as_ref().is_some_and(|b| !b.contains(&0));
            let result = match (&ours, &original, &theirs) {
                (Some(o), Some(b), Some(t)) if text(&ours) && text(&original) && text(&theirs) => merge_text(dest, o, b, t)?,
                _ => None,
            };
            match result {
                Some(bytes) => { write(&target, Some(&bytes))?; merged.applied.push(path); }
                None => merged.conflicts.push(path),
            }
        }
    }
    Ok(merged)
}

/// One piece of work an agent handed to another, as the parent and the UI see it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delegation {
    pub id: String,
    pub parent: String,
    pub child: Option<String>,
    pub agent: AgentKind,
    pub task: String,
    /// waiting_approval, running, done, failed, stopped, refused, conflict.
    pub status: String,
    pub summary: Option<String>,
    pub files_changed: Vec<String>,
    pub conflicts: Vec<String>,
    /// Where the child worked, while it still exists (kept on a conflict).
    pub worktree: Option<PathBuf>,
    #[serde(skip)]
    pub child_wt: Option<Worktree>,
}

impl Delegation {
    pub fn active(&self) -> bool { matches!(self.status.as_str(), "waiting_approval" | "running") }
    /// What `delegate` and `wait_delegated` return to the parent agent.
    pub fn report(&self) -> Value {
        let mut v = serde_json::json!({ "id": self.id, "agent": self.agent, "task": self.task, "status": self.status });
        if let Some(s) = &self.summary { v["summary"] = s.clone().into(); }
        if !self.files_changed.is_empty() { v["files_changed"] = self.files_changed.clone().into(); }
        if !self.conflicts.is_empty() {
            v["conflicts"] = self.conflicts.clone().into();
            if let Some(w) = &self.worktree { v["child_worktree"] = w.to_string_lossy().into_owned().into(); }
        }
        v
    }
}

/// Every delegation of this app session. Waiting parents are woken on each change.
#[derive(Default)]
pub struct Delegations {
    map: Mutex<HashMap<String, Delegation>>,
    changed: tokio::sync::Notify,
}

impl Delegations {
    pub fn insert(&self, d: Delegation) {
        self.map.lock().unwrap().insert(d.id.clone(), d);
        self.changed.notify_waiters();
    }

    /// Changes one delegation; returns it as it now is.
    pub fn update(&self, id: &str, f: impl FnOnce(&mut Delegation)) -> Option<Delegation> {
        let out = self.map.lock().unwrap().get_mut(id).map(|d| { f(d); d.clone() });
        self.changed.notify_waiters();
        out
    }

    pub fn get(&self, id: &str) -> Option<Delegation> { self.map.lock().unwrap().get(id).cloned() }

    pub fn of_parent(&self, parent: &str) -> Vec<Delegation> {
        let mut list: Vec<_> = self.map.lock().unwrap().values().filter(|d| d.parent == parent).cloned().collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    pub fn running(&self, parent: &str) -> usize {
        self.map.lock().unwrap().values().filter(|d| d.parent == parent && d.active()).count()
    }

    /// The parent's delegations (only `ids` if given) once none of them is still going,
    /// or as they are after `timeout`.
    pub async fn wait(&self, parent: &str, ids: &[String], timeout: Duration) -> Vec<Delegation> {
        let deadline = tokio::time::Instant::now() + timeout.min(MAX_WAIT);
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let list: Vec<_> = self.of_parent(parent).into_iter().filter(|d| ids.is_empty() || ids.contains(&d.id)).collect();
            if !list.iter().any(Delegation::active) { return list; }
            if tokio::time::timeout_at(deadline, notified).await.is_err() { return list; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::tests::Repo;
    use std::fs;

    fn child_of(r: &Repo, base: &str, id: &str) -> Worktree {
        crate::worktree::create_at(&r.0, "codex", "child", id, Some(base)).unwrap()
    }

    #[test] fn snapshot_includes_uncommitted_work_and_changes_nothing() {
        let r = Repo::new();
        r.write("file.txt", "edited by parent\n");
        r.write("new.txt", "untracked\n");
        let head = git(&r.0, &["rev-parse", "HEAD"], None).unwrap();
        let status = git(&r.0, &["status", "--porcelain"], None).unwrap();
        let snap = snapshot(&r.0).unwrap();
        assert_eq!(git(&r.0, &["show", &format!("{snap}:new.txt")], None).unwrap(), "untracked\n");
        assert_eq!(git(&r.0, &["show", &format!("{snap}:file.txt")], None).unwrap(), "edited by parent\n");
        assert_eq!(git(&r.0, &["rev-parse", &format!("{snap}^")], None).unwrap(), head);
        assert_eq!(git(&r.0, &["rev-parse", "HEAD"], None).unwrap(), head, "no branch moves");
        assert_eq!(git(&r.0, &["status", "--porcelain"], None).unwrap(), status, "the user's index is untouched");
    }

    #[test] fn snapshot_works_while_another_child_has_a_draft() {
        // The first child's draft makes `.tg/` and ignores it; a second delegate must still snapshot.
        let r = Repo::new();
        let first = snapshot(&r.0).unwrap();
        child_of(&r, &first, "first");
        assert!(r.0.join(".tg").exists());
        r.write("new.txt", "untracked\n");
        let snap = snapshot(&r.0).unwrap();
        assert_eq!(git(&r.0, &["show", &format!("{snap}:new.txt")], None).unwrap(), "untracked\n");
        assert!(git(&r.0, &["ls-tree", "-r", "--name-only", &snap], None).unwrap().lines().all(|p| !p.starts_with(".tg/")));
    }

    #[test] fn snapshot_leaves_out_tg_even_when_it_is_not_ignored() {
        let r = Repo::new();
        r.write(".tg/worktrees/x/file.txt", "draft\n");
        let snap = snapshot(&r.0).unwrap();
        assert!(git(&r.0, &["ls-tree", "-r", "--name-only", &snap], None).unwrap().lines().all(|p| !p.starts_with(".tg/")));
    }

    #[test] fn merge_back_takes_the_childs_files_merges_and_reports_conflicts() {
        let r = Repo::new();
        r.write("both.txt", "a\nb\nc\nd\ne\nf\ng\n");
        r.write("clash.txt", "one\n");
        r.write("gone.txt", "x\n");
        let base = snapshot(&r.0).unwrap();
        let child = child_of(&r, &base, "child-1");
        // The child: new file, edit, line edit far from the parent's, clashing edit, deletion.
        fs::write(child.path.join("new.txt"), "from child\n").unwrap();
        fs::write(child.path.join("file.txt"), fs::read_to_string(child.path.join("file.txt")).unwrap().replace("line 3\n", "child 3\n")).unwrap();
        fs::write(child.path.join("both.txt"), "a\nb\nc\nd\ne\nf\nchild g\n").unwrap();
        fs::write(child.path.join("clash.txt"), "child\n").unwrap();
        fs::remove_file(child.path.join("gone.txt")).unwrap();
        // Meanwhile the parent edits two of the same files.
        r.write("both.txt", "parent a\nb\nc\nd\ne\nf\ng\n");
        r.write("clash.txt", "parent\n");
        let merged = merge_back(&r.0, &child, &base).unwrap();
        assert_eq!(merged.applied, ["both.txt", "file.txt", "gone.txt", "new.txt"]);
        assert_eq!(merged.conflicts, ["clash.txt"]);
        assert_eq!(fs::read_to_string(r.0.join("new.txt")).unwrap(), "from child\n");
        assert!(fs::read_to_string(r.0.join("file.txt")).unwrap().contains("child 3\n"));
        assert_eq!(fs::read_to_string(r.0.join("both.txt")).unwrap(), "parent a\nb\nc\nd\ne\nf\nchild g\n");
        assert_eq!(fs::read_to_string(r.0.join("clash.txt")).unwrap(), "parent\n", "a conflict keeps the parent's version");
        assert!(!r.0.join("gone.txt").exists());
    }

    #[test] fn merge_back_binary_file_only_when_parent_left_it() {
        let r = Repo::new();
        fs::write(r.0.join("img.bin"), [0u8, 1, 2]).unwrap();
        let base = snapshot(&r.0).unwrap();
        let child = child_of(&r, &base, "child-2");
        fs::write(child.path.join("img.bin"), [0u8, 9, 9]).unwrap();
        assert_eq!(merge_back(&r.0, &child, &base).unwrap().applied, ["img.bin"]);
        assert_eq!(fs::read(r.0.join("img.bin")).unwrap(), [0u8, 9, 9]);
        fs::write(child.path.join("img.bin"), [0u8, 7]).unwrap();
        fs::write(r.0.join("img.bin"), [0u8, 5]).unwrap();
        assert_eq!(merge_back(&r.0, &child, &base).unwrap().conflicts, ["img.bin"]);
    }

    fn d(id: &str, parent: &str, status: &str) -> Delegation {
        Delegation { id: id.into(), parent: parent.into(), child: None, agent: AgentKind::Codex, task: "t".into(), status: status.into(),
            summary: None, files_changed: vec![], conflicts: vec![], worktree: None, child_wt: None }
    }

    #[tokio::test] async fn wait_returns_when_done_or_after_the_timeout() {
        let all = std::sync::Arc::new(Delegations::default());
        all.insert(d("a", "p", "running"));
        all.insert(d("b", "other", "running"));
        assert_eq!(all.running("p"), 1);
        let waiter = { let all = all.clone(); tokio::spawn(async move { all.wait("p", &[], Duration::from_secs(5)).await }) };
        tokio::time::sleep(Duration::from_millis(50)).await;
        all.update("a", |x| { x.status = "done".into(); x.summary = Some("xong".into()); });
        let list = waiter.await.unwrap();
        assert_eq!((list.len(), list[0].status.as_str()), (1, "done"));
        assert_eq!(list[0].report()["summary"], "xong");
        let start = std::time::Instant::now();
        let list = all.wait("other", &[], Duration::from_millis(100)).await;
        assert!(start.elapsed() >= Duration::from_millis(100) && list[0].active());
    }
}
