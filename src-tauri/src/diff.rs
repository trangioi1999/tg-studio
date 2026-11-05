use crate::worktree::{git, Worktree};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub id: String,
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<String>,
    pub added: u32,
    pub removed: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub binary: bool,
    pub patch_header: String,
    pub hunks: Vec<Hunk>,
}

// Git quotes paths using C escapes, including octal UTF-8 bytes.
fn unquote(path: &str) -> String {
    if !path.starts_with('"') { return path.to_string(); }
    let mut out = Vec::new();
    let mut bytes = path.as_bytes()[1..].iter().copied().peekable();
    while let Some(b) = bytes.next() {
        if b == b'"' { break; }
        if b != b'\\' { out.push(b); continue; }
        let Some(b) = bytes.next() else { break };
        if (b'0'..=b'7').contains(&b) {
            let mut n = (b - b'0') as u16;
            for _ in 0..2 {
                match bytes.peek() {
                    Some(b'0'..=b'7') => n = n * 8 + (bytes.next().unwrap() - b'0') as u16,
                    _ => break,
                }
            }
            out.push(n as u8);
        } else {
            out.push(match b { b'n' => b'\n', b't' => b'\t', b'r' => b'\r', b'b' => 8, b'f' => 12, b'v' => 11, b'a' => 7, b => b });
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
fn patch_path(s: &str) -> String {
    let path = unquote(s.split('\t').next().unwrap_or(s));
    path.strip_prefix("a/").or_else(|| path.strip_prefix("b/")).unwrap_or(&path).into()
}
fn range(s: &str) -> Option<(u32, u32)> {
    let s = s.get(1..)?;
    let (start, count) = s.split_once(',').unwrap_or((s, "1"));
    Some((start.parse().ok()?, count.parse().ok()?))
}
fn hunk_id(path: &str, lines: &[String]) -> String {
    // FNV-1a, explicitly specified so IDs stay stable across process/Rust versions.
    let mut hash = 0xcbf29ce484222325u64;
    for b in path.bytes().chain(std::iter::once(0)).chain(lines.iter().flat_map(|s| s.bytes().chain(std::iter::once(b'\n')))) {
        hash = (hash ^ u64::from(b)).wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn parse_unified(text: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    for line in text.split_terminator('\n') {
        if let Some(paths) = line.strip_prefix("diff --git ") {
            let fallback = if paths.starts_with('"') {
                // For quoted paths, find the closing quote while respecting escapes.
                let mut escaped = false;
                let mut end = 0;
                for (i, c) in paths.char_indices().skip(1) {
                    if escaped { escaped = false; }
                    else if c == '\\' { escaped = true; }
                    else if c == '"' { end = i + 1; break; }
                }
                paths.get(end..).unwrap_or("").trim_start()
            } else { paths.rfind(" b/").map(|i| &paths[i + 1..]).unwrap_or(paths) };
            files.push(FileDiff { path: patch_path(fallback), status: "M".into(), binary: false, patch_header: format!("{line}\n"), hunks: vec![] });
            continue;
        }
        let Some(file) = files.last_mut() else { continue };
        if line.starts_with("@@ ") {
            let parts: Vec<_> = line.split_whitespace().collect();
            if let Some(((old_start, old_lines), (new_start, new_lines))) = parts.get(1).and_then(|s| range(s)).zip(parts.get(2).and_then(|s| range(s))) {
                file.hunks.push(Hunk { id: String::new(), header: line.into(), old_start, old_lines, new_start, new_lines, lines: vec![], added: 0, removed: 0 });
            }
        } else if let Some(hunk) = file.hunks.last_mut() {
            if line.starts_with([' ', '+', '-', '\\']) {
                hunk.added += u32::from(line.starts_with('+'));
                hunk.removed += u32::from(line.starts_with('-'));
                hunk.lines.push(line.into());
            }
        } else {
            file.patch_header.push_str(line); file.patch_header.push('\n');
            if line.starts_with("new file mode ") { file.status = "A".into(); }
            if line.starts_with("deleted file mode ") { file.status = "D".into(); }
            if line.starts_with("Binary files ") || line == "GIT binary patch" { file.binary = true; }
            if let Some(path) = line.strip_prefix("--- ").or_else(|| line.strip_prefix("+++ ")) {
                if path != "/dev/null" { file.path = patch_path(path); }
            }
        }
    }
    for file in &mut files {
        for hunk in &mut file.hunks { hunk.id = hunk_id(&file.path, &hunk.lines); }
    }
    files
}

fn accepted_path(wt: &Worktree) -> Result<std::path::PathBuf, String> {
    if wt.is_direct() { return Ok(crate::worktree::direct_files(wt)?.1); }
    let path = git(&wt.path, &["rev-parse", "--git-path", "tg-accepted"], None)?;
    Ok(wt.path.join(path.trim()))
}

/// Git in the run's own index: the worktree's, or a private one for a direct run so the
/// user's index only changes when they keep a change.
fn run_git(wt: &Worktree, args: &[&str], stdin: Option<&[u8]>) -> Result<String, String> {
    if wt.is_direct() {
        let (index, _) = crate::worktree::direct_files(wt)?;
        crate::worktree::git_index(&wt.path, &index, args, stdin)
    } else {
        git(&wt.path, args, stdin)
    }
}

fn save_accepted(wt: &Worktree) -> Result<(), String> {
    let tree = run_git(wt, &["write-tree"], None)?;
    std::fs::write(accepted_path(wt)?, tree)
        .map_err(|e| format!("Không lưu được phần thay đổi đã nhận: {e}"))
}

pub fn pending(wt: &Worktree) -> Result<Vec<FileDiff>, String> {
    if !wt.is_direct() && git(&wt.path, &["rev-parse", "HEAD"], None)?.trim() != wt.base {
        git(&wt.path, &["reset", "--soft", &wt.base], None)?;
    }
    // The agent owns its index too; only this saved tree records user approval.
    let accepted = match std::fs::read_to_string(accepted_path(wt)?) {
        Ok(tree) => tree,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && wt.is_direct() => wt.base.clone(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound =>
            git(&wt.path, &["rev-parse", &format!("{}^{{tree}}", wt.base)], None)?,
        Err(e) => return Err(format!("Không đọc được phần thay đổi đã nhận: {e}")),
    };
    if run_git(wt, &["write-tree"], None).map(|t| t.trim() != accepted.trim()).unwrap_or(true) {
        // Do not use -u: pending agent edits must remain on disk.
        run_git(wt, &["read-tree", accepted.trim()], None)?;
    }
    // Without --ignore-removal, add -N stages deletions before the user approves.
    run_git(wt, &["add", "-N", "--ignore-removal", "--", ".", ":(exclude).tg"], None)?;
    let patch = run_git(wt, &["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3"], None)?;
    Ok(parse_unified(&patch))
}

pub(crate) fn selected_patch(wt: &Worktree, path: &str, id: &str) -> Result<String, String> {
    let files = pending(wt)?;
    let file = files.iter().find(|f| f.path == path).ok_or("Không tìm thấy tệp trong thay đổi đang chờ.")?;
    if file.binary { return Err("Không thể duyệt từng hunk của tệp nhị phân.".into()); }
    let matches: Vec<_> = file.hunks.iter().filter(|h| h.id == id).collect();
    if matches.len() != 1 { return Err("Hunk đã thay đổi, không tồn tại hoặc có nội dung trùng lặp; hãy tải lại diff.".into()); }
    let hunk = matches[0];
    Ok(format!("{}{}\n{}\n", file.patch_header, hunk.header, hunk.lines.join("\n")))
}

pub fn accept_hunk(repo: &Path, wt: &Worktree, path: &str, hunk_id: &str) -> Result<(), String> {
    let patch = selected_patch(wt, path, hunk_id)?;
    if wt.is_direct() {
        // The change is already in the folder: keeping it stages it for the commit box.
        run_git(wt, &["apply", "--check", "--cached", "--recount"], Some(patch.as_bytes()))?;
        git(repo, &["apply", "--cached", "--recount"], Some(patch.as_bytes()))
            .map_err(|e| format!("Không đưa được đoạn này vào commit (có thể bạn đã stage nội dung khác cùng chỗ): {e}"))?;
        run_git(wt, &["apply", "--cached", "--recount"], Some(patch.as_bytes()))?;
        return save_accepted(wt);
    }
    // Check the exact mode used below, including consistency with the user's index.
    git(repo, &["apply", "--check", "--index", "--recount"], Some(patch.as_bytes()))?;
    git(&wt.path, &["apply", "--check", "--cached", "--recount"], Some(patch.as_bytes()))?;
    git(repo, &["apply", "--index", "--recount"], Some(patch.as_bytes()))?;
    if let Err(error) = git(&wt.path, &["apply", "--cached", "--recount"], Some(patch.as_bytes())) {
        // Git has no cross-worktree transaction. Attempt rollback if the second apply fails.
        if let Err(rollback) = git(repo, &["apply", "-R", "--index", "--recount"], Some(patch.as_bytes())) {
            return Err(format!("{error}; Không hoàn tác được thay đổi đã duyệt: {rollback}"));
        }
        return Err(error);
    }
    save_accepted(wt)
}

/// "Use this" in the compare view: every pending change of the run, binary files
/// included, applied to the user's repo in one go. Nothing is applied if any part fails.
pub fn accept_all(repo: &Path, wt: &Worktree) -> Result<usize, String> {
    let files = pending(wt)?;
    if files.is_empty() { return Err("Không còn thay đổi nào để áp dụng.".into()); }
    let patch = run_git(wt, &["diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"], None)?;
    if wt.is_direct() {
        git(repo, &["apply", "--check", "--cached"], Some(patch.as_bytes()))
            .map_err(|e| format!("Không đưa được các thay đổi vào commit (có thể bạn đã stage nội dung khác cùng chỗ): {e}"))?;
        git(repo, &["apply", "--cached"], Some(patch.as_bytes()))?;
        run_git(wt, &["apply", "--cached"], Some(patch.as_bytes()))?;
        save_accepted(wt)?;
        return Ok(files.len());
    }
    git(repo, &["apply", "--check", "--index"], Some(patch.as_bytes()))
        .map_err(|e| format!("Bản này không áp được vào repo (có thể bạn đã sửa cùng chỗ hoặc đã nhận bản khác): {e}"))?;
    git(&wt.path, &["apply", "--check", "--cached"], Some(patch.as_bytes()))?;
    git(repo, &["apply", "--index"], Some(patch.as_bytes()))?;
    if let Err(error) = git(&wt.path, &["apply", "--cached"], Some(patch.as_bytes())) {
        if let Err(rollback) = git(repo, &["apply", "-R", "--index"], Some(patch.as_bytes())) {
            return Err(format!("{error}; Không hoàn tác được thay đổi đã duyệt: {rollback}"));
        }
        return Err(error);
    }
    save_accepted(wt)?;
    Ok(files.len())
}

/// Reject: the hunk goes back to how it was, in the worktree or (direct run) in the user's folder.
pub fn reject_hunk(wt: &Worktree, path: &str, hunk_id: &str) -> Result<(), String> {
    let patch = selected_patch(wt, path, hunk_id)?;
    git(&wt.path, &["apply", "-R", "--recount"], Some(patch.as_bytes()))?;
    if patch.lines().any(|line| line.starts_with("new file mode ")) {
        // Reverse application deletes the file but leaves its intent-to-add entry.
        run_git(wt, &["--literal-pathspecs", "rm", "--cached", "--", path], None)?;
    }
    Ok(())
}

pub fn staged(repo: &Path) -> Result<Vec<String>, String> {
    let names = git(repo, &["diff", "--cached", "--name-only", "--no-renames", "-z"], None)?;
    let mut files: Vec<String> = names.split('\0').filter(|s| !s.is_empty()).map(str::to_owned).collect();
    files.sort();
    Ok(files)
}

pub fn commit(repo: &Path, message: &str) -> Result<String, String> {
    git(repo, &["commit", "-m", message], None)?;
    Ok(git(repo, &["rev-parse", "HEAD"], None)?.trim().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::{tests::Repo, git};
    use std::fs;
    fn change(w: &Worktree) {
        let p = w.path.join("file.txt");
        let s = fs::read_to_string(&p).unwrap().replace("line 2\n", "changed 2\n").replace("line 28\n", "changed 28\n");
        fs::write(p, s).unwrap();
    }

    #[test] fn direct_run_reviews_only_the_agents_changes_in_the_real_folder() {
        let r = Repo::new();
        // The user's own work in progress: an unstaged edit, a staged file, an untracked file.
        r.write("mine.txt", "mine\n");
        git(&r.0, &["add", "mine.txt"], None).unwrap();
        git(&r.0, &["commit", "-m", "mine"], None).unwrap();
        r.write("mine.txt", "mine, edited\n");
        r.write("staged.txt", "staged\n");
        git(&r.0, &["add", "staged.txt"], None).unwrap();
        r.write("notes.txt", "untracked\n");
        let w = crate::worktree::direct(&r.0, "direct-run-1").unwrap();
        assert!(w.is_direct());
        assert_eq!(dunce::canonicalize(&w.path).unwrap(), dunce::canonicalize(&r.0).unwrap());
        assert!(pending(&w).unwrap().is_empty(), "the user's own changes are not the agent's");
        // The agent edits a tracked file, adds one and deletes one, right in the folder.
        change(&w);
        r.write("new.txt", "agent\n");
        r.write("gone.txt", "x\n");
        let staged_before = staged(&r.0).unwrap();
        let files = pending(&w).unwrap();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["file.txt", "gone.txt", "new.txt"]);
        assert_eq!(staged(&r.0).unwrap(), staged_before, "reviewing must not touch the user's index");
        // Keep one hunk: it is staged for the commit and leaves the review.
        let hunk = files[0].hunks[0].id.clone();
        accept_hunk(&r.0, &w, "file.txt", &hunk).unwrap();
        assert!(staged(&r.0).unwrap().contains(&"file.txt".to_string()));
        let left = pending(&w).unwrap();
        assert_eq!(left.iter().find(|f| f.path == "file.txt").unwrap().hunks.len(), 1);
        // Undo the new file: it is gone from the folder and from the review.
        let new = left.iter().find(|f| f.path == "new.txt").unwrap().hunks[0].id.clone();
        reject_hunk(&w, "new.txt", &new).unwrap();
        assert!(!r.0.join("new.txt").exists());
        assert!(!pending(&w).unwrap().iter().any(|f| f.path == "new.txt"));
        // The user's files were never touched.
        assert_eq!(fs::read_to_string(r.0.join("mine.txt")).unwrap(), "mine, edited\n");
        assert_eq!(fs::read_to_string(r.0.join("notes.txt")).unwrap(), "untracked\n");
        // Discarding a direct run removes only the app's bookkeeping.
        crate::worktree::remove(&r.0, &w, true).unwrap();
        assert!(r.0.join("file.txt").exists() && r.0.join("mine.txt").exists());
        assert!(!crate::worktree::direct_files(&w).unwrap().0.exists());
    }

    #[test] fn direct_accept_all_stages_everything_pending() {
        let r = Repo::new();
        let w = crate::worktree::direct(&r.0, "direct-run-2").unwrap();
        change(&w);
        r.write("new.txt", "agent\n");
        assert_eq!(accept_all(&r.0, &w).unwrap(), 2);
        assert!(pending(&w).unwrap().is_empty());
        assert_eq!(staged(&r.0).unwrap(), ["file.txt", "new.txt"]);
    }

    #[test] fn branches_leave_out_the_apps_own() {
        let r = Repo::new();
        let _ = r.wt();
        git(&r.0, &["branch", "feature/x"], None).unwrap();
        let mut b = crate::worktree::branches(&r.0).unwrap();
        b.sort();
        assert!(b.contains(&"feature/x".to_string()));
        assert!(b.iter().all(|x| !x.starts_with("tg/")), "{b:?}");
    }

    #[test] fn agent_staged_changes_stay_pending() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        git(&w.path, &["add", "-A"], None).unwrap();
        let files = pending(&w).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].hunks.len(), 2);
    }

    fn agent_updates_after_accept(commit_changes: bool) {
        let r = Repo::new(); let w = r.wt(); change(&w);
        let files = pending(&w).unwrap();
        assert_eq!(files[0].hunks.len(), 2);
        let accepted = files[0].hunks[0].id.clone();
        let remaining = files[0].hunks[1].id.clone();
        accept_hunk(&r.0, &w, "file.txt", &accepted).unwrap();
        fs::write(w.path.join("extra.txt"), "later change\n").unwrap();
        git(&w.path, &["add", "-A"], None).unwrap();
        if commit_changes {
            git(&w.path, &["commit", "-m", "agent changes"], None).unwrap();
        }
        let left = pending(&w).unwrap();
        let file = left.iter().find(|f| f.path == "file.txt").expect("unaccepted hunk stays pending");
        assert_eq!(file.hunks.len(), 1);
        assert_eq!(file.hunks[0].id, remaining);
        assert!(left.iter().flat_map(|f| &f.hunks).all(|h| h.id != accepted));
        assert!(left.iter().any(|f| f.path == "extra.txt"));
        assert_eq!(git(&w.path, &["rev-parse", "HEAD"], None).unwrap().trim(), w.base);
        assert_eq!(pending(&w).unwrap(), left);
    }

    #[test] fn agent_commit_keeps_accepted_hunks_accepted() {
        agent_updates_after_accept(true);
    }

    #[test] fn agent_stage_after_accept_does_not_reopen_accepted() {
        agent_updates_after_accept(false);
    }

    #[test] fn accept_all_includes_agent_staged_changes() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        fs::write(w.path.join("new.txt"), "new\n").unwrap();
        git(&w.path, &["add", "-A"], None).unwrap();
        assert_eq!(accept_all(&r.0, &w).unwrap(), 2);
        assert_eq!(fs::read(r.0.join("file.txt")).unwrap(), fs::read(w.path.join("file.txt")).unwrap());
        assert_eq!(fs::read_to_string(r.0.join("new.txt")).unwrap(), "new\n");
        assert!(pending(&w).unwrap().is_empty());
    }

    #[test] fn staged_lists_every_staged_file_of_repo() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        r.write("a user.txt", "user staged\n");
        // Windows forbids newlines in filenames; Unix also exercises NUL separation.
        let special = if cfg!(windows) { "tệp x.txt" } else { "tệp\nx.txt" };
        r.write(special, "user staged\n");
        git(&r.0, &["add", "a user.txt", special], None).unwrap();
        r.write("unstaged.txt", "not staged\n");
        let files = pending(&w).unwrap();
        accept_hunk(&r.0, &w, "file.txt", &files[0].hunks[0].id).unwrap();
        assert_eq!(staged(&r.0).unwrap(), vec!["a user.txt", "file.txt", special]);
    }

    #[test] fn accept_all_applies_text_new_deleted_and_binary_files() {
        let r = Repo::new();
        r.write("gone.txt", "bye\n");
        git(&r.0, &["add", "."], None).unwrap();
        git(&r.0, &["commit", "-m", "gone"], None).unwrap();
        let w = r.wt();
        change(&w);
        fs::create_dir_all(w.path.join("thư mục")).unwrap();
        fs::write(w.path.join("thư mục/mới.txt"), "mới\n").unwrap();
        fs::write(w.path.join("img.bin"), [0u8, 1, 2, 255]).unwrap();
        fs::remove_file(w.path.join("gone.txt")).unwrap();
        assert_eq!(accept_all(&r.0, &w).unwrap(), 4);
        assert!(pending(&w).unwrap().is_empty());
        assert!(fs::read_to_string(r.0.join("file.txt")).unwrap().contains("changed 28\n"));
        assert_eq!(fs::read_to_string(r.0.join("thư mục/mới.txt")).unwrap(), "mới\n");
        assert_eq!(fs::read(r.0.join("img.bin")).unwrap(), vec![0u8, 1, 2, 255]);
        assert!(!r.0.join("gone.txt").exists());
        commit(&r.0, "use this").unwrap();
        assert!(git(&r.0, &["status", "--porcelain"], None).unwrap().is_empty());
        assert!(accept_all(&r.0, &w).unwrap_err().contains("Không còn"));
    }

    #[test] fn accept_all_conflict_changes_nothing() {
        let r = Repo::new();
        let w = r.wt();
        change(&w);
        fs::write(w.path.join("new.txt"), "x\n").unwrap();
        // The user (or another agent's accepted run) changed line 28 too.
        let p = r.0.join("file.txt");
        fs::write(&p, fs::read_to_string(&p).unwrap().replace("line 28\n", "user 28\n")).unwrap();
        let before = git(&r.0, &["status", "--porcelain"], None).unwrap();
        assert!(accept_all(&r.0, &w).is_err());
        assert_eq!(git(&r.0, &["status", "--porcelain"], None).unwrap(), before);
        assert!(!r.0.join("new.txt").exists());
        assert_eq!(pending(&w).unwrap().len(), 2);
    }

    #[test] fn hunk_id_ignores_line_numbers() {
        let a = parse_unified("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
        let b = parse_unified("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -20 +30 @@\n-a\n+b\n");
        assert_eq!(a[0].hunks[0].id, b[0].hunks[0].id);
    }
    #[test] fn binary_path_keeps_directory_named_b() {
        let files = parse_unified("diff --git a/b/image b/b/image\nBinary files a/b/image and b/b/image differ\n");
        assert_eq!(files[0].path, "b/image");
    }
    #[test] fn quoted_octal_paths_are_decoded() {
        let f = parse_unified("diff --git \"a/\\303\\251.txt\" \"b/\\303\\251.txt\"\n--- \"a/\\303\\251.txt\"\n+++ \"b/\\303\\251.txt\"\n@@ -1 +1 @@\n-a\n+b\n");
        assert_eq!(f[0].path, "é.txt");
    }
    #[test] fn binary_and_missing_hunk_return_errors() {
        let r = Repo::new(); let w = r.wt();
        fs::write(w.path.join("binary"), [0, 1, 2]).unwrap();
        let f = pending(&w).unwrap();
        assert!(f[0].binary);
        assert!(accept_hunk(&r.0, &w, "binary", "unknown").unwrap_err().contains("nhị phân"));
        assert!(reject_hunk(&w, "missing", "unknown").is_err());
    }
    #[test] fn no_newline_accept_and_reject() {
        for accept in [true, false] {
            let r = Repo::new(); let w = r.wt();
            fs::write(w.path.join("new.txt"), "no newline").unwrap();
            let f = pending(&w).unwrap();
            if accept {
                accept_hunk(&r.0, &w, "new.txt", &f[0].hunks[0].id).unwrap();
                assert_eq!(fs::read_to_string(r.0.join("new.txt")).unwrap(), "no newline");
            } else { reject_hunk(&w, "new.txt", &f[0].hunks[0].id).unwrap(); }
            assert!(pending(&w).unwrap().is_empty());
        }
    }
    #[test] fn index_mismatch_leaves_both_indexes_untouched() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        let f = pending(&w).unwrap();
        let original = fs::read(r.0.join("file.txt")).unwrap();
        r.write("file.txt", "staged user change\n");
        git(&r.0, &["add", "file.txt"], None).unwrap();
        fs::write(r.0.join("file.txt"), &original).unwrap();
        let before = git(&r.0, &["diff", "--cached"], None).unwrap();
        let wt_before = git(&w.path, &["diff", "--cached"], None).unwrap();
        assert!(accept_hunk(&r.0, &w, "file.txt", &f[0].hunks[0].id).is_err());
        assert_eq!(before, git(&r.0, &["diff", "--cached"], None).unwrap());
        assert_eq!(wt_before, git(&w.path, &["diff", "--cached"], None).unwrap());
        assert_eq!(fs::read(r.0.join("file.txt")).unwrap(), original);
    }
    #[test] fn parse_quoted_and_unicode_paths() {
        let f = parse_unified("diff --git \"a/a b\" \"b/a b\"\n--- \"a/a b\"\n+++ \"b/a b\"\n@@ -1 +1 @@\n-a\n+b\n");
        assert_eq!(f[0].path, "a b");
        let r = Repo::new(); let w = r.wt();
        fs::write(w.path.join("tệp.txt"), "hello\n").unwrap();
        assert_eq!(pending(&w).unwrap()[0].path, "tệp.txt");
    }
    #[test] fn parse_new_deleted_and_binary() {
        let f = parse_unified("diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+x\ndiff --git a/y b/y\ndeleted file mode 100644\nBinary files a/y and /dev/null differ\n");
        assert_eq!(f[0].status, "A"); assert_eq!(f[1].status, "D"); assert!(f[1].binary);
    }
    #[test] fn parse_no_newline_marker() {
        let f = parse_unified("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n");
        assert_eq!(f[0].hunks[0].lines.last().unwrap(), "\\ No newline at end of file");
        assert_eq!(f[0].hunks[0].added, 1);
    }
    // core.autocrlf=true is Git for Windows' default: files on disk are CRLF, blobs are LF.
    #[test] fn review_flow_works_with_autocrlf() {
        let r = Repo::new();
        git(&r.0, &["config", "core.autocrlf", "true"], None).unwrap();
        fs::remove_file(r.0.join("file.txt")).unwrap();
        git(&r.0, &["checkout", "--", "file.txt"], None).unwrap();
        let w = r.wt();
        let original = fs::read_to_string(w.path.join("file.txt")).unwrap();
        assert!(original.contains("line 2\r\n"), "the worktree must start with CRLF");

        // An agent may keep the CRLF ending or write a bare LF line.
        let edited = original
            .replace("line 2\r\n", "two\r\n")
            .replace("line 25\r\n", "twenty five\n");
        fs::write(w.path.join("file.txt"), edited).unwrap();

        let files = pending(&w).unwrap();
        assert_eq!(files[0].hunks.len(), 2);
        let first = files[0].hunks.iter().find(|h| h.lines.iter().any(|l| l.contains("two"))).unwrap();
        accept_hunk(&r.0, &w, "file.txt", &first.id).unwrap();

        let repo_file = fs::read_to_string(r.0.join("file.txt")).unwrap();
        assert!(repo_file.contains("two\r\n"));
        assert!(repo_file.contains("line 25\r\n"), "the other hunk must not be applied");
        assert!(!repo_file.replace("\r\n", "").contains('\n'), "line endings must stay CRLF");

        let left = pending(&w).unwrap();
        assert_eq!(left[0].hunks.len(), 1);
        reject_hunk(&w, "file.txt", &left[0].hunks[0].id).unwrap();
        assert!(pending(&w).unwrap().is_empty());
        assert!(fs::read_to_string(w.path.join("file.txt")).unwrap().contains("line 25"));

        commit(&r.0, "fix").unwrap();
        let committed = git(&r.0, &["show", "HEAD:file.txt"], None).unwrap();
        assert!(committed.contains("two\n") && !committed.contains('\r'), "blobs stay LF");
    }

    #[test] fn accept_one_of_two_hunks_applies_only_that_hunk() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        let f = pending(&w).unwrap(); assert_eq!(f[0].hunks.len(), 2);
        let remaining = f[0].hunks[1].id.clone();
        accept_hunk(&r.0, &w, "file.txt", &f[0].hunks[0].id).unwrap();
        assert_eq!(pending(&w).unwrap()[0].hunks[0].id, remaining);
        let s = fs::read_to_string(r.0.join("file.txt")).unwrap();
        assert!(s.contains("changed 2\n")); assert!(s.contains("line 28\n"));
    }
    #[test] fn reject_removes_hunk_from_worktree() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        let f = pending(&w).unwrap();
        reject_hunk(&w, "file.txt", &f[0].hunks[0].id).unwrap();
        assert_eq!(pending(&w).unwrap()[0].hunks.len(), 1);
    }
    #[test] fn new_file_accept_and_reject() {
        for accept in [true, false] {
            let r = Repo::new(); let w = r.wt();
            fs::write(w.path.join("new.txt"), "new\n").unwrap();
            let f = pending(&w).unwrap();
            if accept { accept_hunk(&r.0, &w, "new.txt", &f[0].hunks[0].id).unwrap(); }
            else { reject_hunk(&w, "new.txt", &f[0].hunks[0].id).unwrap(); }
            assert!(pending(&w).unwrap().is_empty());
            assert_eq!(r.0.join("new.txt").exists(), accept);
        }
    }
    #[test] fn deleted_file_accept() {
        let r = Repo::new(); let w = r.wt(); fs::remove_file(w.path.join("file.txt")).unwrap();
        let f = pending(&w).unwrap();
        accept_hunk(&r.0, &w, "file.txt", &f[0].hunks[0].id).unwrap();
        assert!(!r.0.join("file.txt").exists()); assert!(pending(&w).unwrap().is_empty());
    }
    #[test] fn path_with_space_and_unicode_accepts() {
        let r = Repo::new(); let w = r.wt(); let path = "thư mục có dấu cách/tệp mới.txt";
        fs::create_dir_all(w.path.join("thư mục có dấu cách")).unwrap();
        fs::write(w.path.join(path), "hello\n").unwrap();
        let f = pending(&w).unwrap();
        assert_eq!(f[0].path, path);
        accept_hunk(&r.0, &w, path, &f[0].hunks[0].id).unwrap();
        assert_eq!(fs::read_to_string(r.0.join(path)).unwrap(), "hello\n");
    }
    #[test] fn accept_conflict_leaves_both_sides_untouched() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        let f = pending(&w).unwrap(); r.write("file.txt", "user edit\n");
        let before = [git(&r.0, &["status", "--porcelain"], None).unwrap(), git(&w.path, &["status", "--porcelain"], None).unwrap()];
        let content = fs::read(w.path.join("file.txt")).unwrap();
        assert!(accept_hunk(&r.0, &w, "file.txt", &f[0].hunks[0].id).is_err());
        assert_eq!(before, [git(&r.0, &["status", "--porcelain"], None).unwrap(), git(&w.path, &["status", "--porcelain"], None).unwrap()]);
        assert_eq!(fs::read(w.path.join("file.txt")).unwrap(), content);
        assert_eq!(fs::read_to_string(r.0.join("file.txt")).unwrap(), "user edit\n");
    }
    #[test] fn agent_commit_still_appears_in_pending() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        git(&w.path, &["add", "."], None).unwrap();
        git(&w.path, &["commit", "-m", "agent"], None).unwrap();
        assert_eq!(pending(&w).unwrap()[0].hunks.len(), 2);
        assert_eq!(crate::worktree::list(&r.0).unwrap()[0].base, w.base);
    }
    #[test] fn commit_only_contains_accepted_hunks() {
        let r = Repo::new(); let w = r.wt(); change(&w);
        let f = pending(&w).unwrap();
        accept_hunk(&r.0, &w, "file.txt", &f[0].hunks[0].id).unwrap();
        r.write("untracked.txt", "keep");
        let hash = commit(&r.0, "accepted").unwrap();
        let s = git(&r.0, &["show", &format!("{hash}:file.txt")], None).unwrap();
        assert!(s.contains("changed 2\n")); assert!(s.contains("line 28\n"));
        assert!(git(&r.0, &["show", &format!("{hash}:untracked.txt")], None).is_err());
    }
}
