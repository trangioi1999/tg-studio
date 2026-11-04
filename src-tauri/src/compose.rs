//! Composite worktrees: hunks picked from several runs of one parallel group, applied
//! on top of their shared base, so the mix can be tested before it reaches the repo.

use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio, sync::Mutex, time::{Duration, Instant}};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::process::Command;

use crate::{diff::{self, FileDiff}, env, store::Store, worktree::{self, Worktree}};

const CHECK_TIMEOUT: Duration = Duration::from_secs(600);
const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub run_id: String,
    pub path: String,
    pub hunk_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Composite {
    pub id: String,
    pub files: Vec<FileDiff>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// None: killed (timeout) or ended by a signal.
    pub code: Option<i32>,
    pub output: String,
    pub truncated: bool,
    pub duration_ms: u64,
}

/// Live composites by id. They are scratch space: not kept across restarts.
#[derive(Default)]
pub struct Composites(Mutex<HashMap<String, (PathBuf, Worktree)>>);

/// Applies each picked hunk, in order, to a new worktree at the sources' common base.
/// Any hunk that does not apply removes the composite and names the hunk.
pub fn compose(repo: &Path, id: &str, sources: &HashMap<String, Worktree>, picks: &[Pick]) -> Result<Worktree, String> {
    if picks.is_empty() { return Err("Hãy chọn ít nhất một thay đổi để ghép.".into()); }
    let mut bases = sources.values().map(|w| w.base.as_str());
    let base = bases.next().ok_or("Không có bản nào để ghép.")?;
    if bases.any(|b| b != base) { return Err("Các bản không cùng commit gốc nên không ghép được.".into()); }
    // Read every patch first: a missing hunk should not leave a half-built worktree behind.
    let patches = picks.iter().map(|p| {
        let wt = sources.get(&p.run_id).ok_or_else(|| format!("Không tìm thấy lượt chạy {}.", p.run_id))?;
        diff::selected_patch(wt, &p.path, &p.hunk_id).map(|patch| (p, patch))
    }).collect::<Result<Vec<_>, String>>()?;
    let wt = worktree::create_at(repo, "mix", "ban-ghep", id, Some(base))?;
    for (pick, patch) in patches {
        if let Err(e) = worktree::git(&wt.path, &["apply", "--recount"], Some(patch.as_bytes())) {
            let _ = worktree::remove(repo, &wt, true);
            return Err(format!("Thay đổi ở {} không ghép được với các thay đổi đã chọn trước đó (trùng chỗ sửa). {e}", pick.path));
        }
    }
    Ok(wt)
}

/// Runs the user's own command (e.g. `npm test`) through the system shell in `cwd`.
pub async fn run_check(cwd: &Path, command: &str) -> Result<CheckResult, String> {
    if command.trim().is_empty() { return Err("Hãy nhập lệnh kiểm tra, ví dụ npm test.".into()); }
    #[cfg(windows)]
    let mut cmd = { let mut c = Command::new("cmd"); c.args(["/C", command]); c };
    #[cfg(not(windows))]
    let mut cmd = { let mut c = Command::new("sh"); c.args(["-c", command]); c };
    cmd.current_dir(cwd).env("PATH", env::login_path()).stdin(Stdio::null())
        .stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let started = Instant::now();
    let child = cmd.spawn().map_err(|e| format!("Không chạy được lệnh: {e}"))?;
    let (code, mut text) = match tokio::time::timeout(CHECK_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.is_empty() {
                if !text.is_empty() && !text.ends_with('\n') { text.push('\n'); }
                text.push_str(&err);
            }
            (out.status.code(), text)
        }
        Ok(Err(e)) => return Err(format!("Lệnh lỗi khi chạy: {e}")),
        Err(_) => (None, format!("Đã dừng lệnh sau {} phút.", CHECK_TIMEOUT.as_secs() / 60)),
    };
    let truncated = text.len() > OUTPUT_LIMIT;
    if truncated {
        // Keep the end, where test summaries are, on a character boundary.
        let mut cut = text.len() - OUTPUT_LIMIT;
        while !text.is_char_boundary(cut) { cut += 1; }
        text = text[cut..].to_string();
    }
    Ok(CheckResult { code, output: text, truncated, duration_ms: started.elapsed().as_millis() as u64 })
}

fn get(state: &Composites, id: &str) -> Result<(PathBuf, Worktree), String> {
    state.0.lock().map_err(|_| "Không đọc được bản ghép.")?.get(id).cloned().ok_or_else(|| "Bản ghép không còn. Hãy tạo lại.".into())
}

#[tauri::command]
pub fn compose_runs(store: State<'_, Store>, state: State<'_, Composites>, picks: Vec<Pick>) -> Result<Composite, String> {
    let mut repo: Option<PathBuf> = None;
    let mut sources = HashMap::new();
    for pick in &picks {
        if sources.contains_key(&pick.run_id) { continue; }
        let (r, wt) = store.run_worktree(&pick.run_id).map_err(|e| format!("Không tìm thấy worktree của lượt chạy: {e}"))?;
        if repo.as_ref().is_some_and(|known| known != &r) { return Err("Các bản thuộc những repo khác nhau.".into()); }
        repo = Some(r);
        sources.insert(pick.run_id.clone(), wt);
    }
    let repo = repo.ok_or("Hãy chọn ít nhất một thay đổi để ghép.")?;
    let id = uuid::Uuid::new_v4().to_string();
    let wt = compose(&repo, &id, &sources, &picks)?;
    let files = diff::pending(&wt)?;
    state.0.lock().map_err(|_| "Không lưu được bản ghép.")?.insert(id.clone(), (repo, wt));
    Ok(Composite { id, files })
}

#[tauri::command]
pub async fn check_composite(state: State<'_, Composites>, id: String, command: String) -> Result<CheckResult, String> {
    let (_, wt) = get(&state, &id)?;
    run_check(&wt.path, &command).await
}

#[tauri::command]
pub fn apply_composite(state: State<'_, Composites>, id: String) -> Result<usize, String> {
    let (repo, wt) = get(&state, &id)?;
    diff::accept_all(&repo, &wt)
}

#[tauri::command]
pub fn commit_composite(state: State<'_, Composites>, id: String, message: String) -> Result<String, String> {
    let (repo, _) = get(&state, &id)?;
    diff::commit(&repo, &message)
}

#[tauri::command]
pub fn discard_composite(state: State<'_, Composites>, id: String) -> Result<(), String> {
    let (repo, wt) = get(&state, &id)?;
    worktree::remove(&repo, &wt, true)?;
    state.0.lock().map_err(|_| "Không cập nhật được bản ghép.")?.remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::tests::Repo;
    use std::fs;

    fn edit(wt: &Worktree, from: &str, to: &str) {
        let p = wt.path.join("file.txt");
        fs::write(&p, fs::read_to_string(&p).unwrap().replace(from, to)).unwrap();
    }
    fn two_runs(r: &Repo) -> (Worktree, Worktree) {
        let a = worktree::create(&r.0, "claude", "t", "aaaaaaaa-1").unwrap();
        let b = worktree::create(&r.0, "codex", "t", "bbbbbbbb-2").unwrap();
        // Each run changes the top and the bottom of the file.
        edit(&a, "line 2\n", "A top\n"); edit(&a, "line 28\n", "A bottom\n");
        edit(&b, "line 2\n", "B top\n"); edit(&b, "line 28\n", "B bottom\n");
        (a, b)
    }
    fn hunk(wt: &Worktree, text: &str) -> Pick {
        let h = diff::pending(wt).unwrap().remove(0).hunks.into_iter().find(|h| h.lines.iter().any(|l| l.contains(text))).unwrap();
        Pick { run_id: wt.run_id.clone(), path: "file.txt".into(), hunk_id: h.id }
    }

    #[test]
    fn mixes_hunks_from_two_runs_then_applies_and_commits() {
        let r = Repo::new();
        let (a, b) = two_runs(&r);
        let sources = HashMap::from([(a.run_id.clone(), a.clone()), (b.run_id.clone(), b.clone())]);
        let mix = compose(&r.0, "mix-1", &sources, &[hunk(&a, "A top"), hunk(&b, "B bottom")]).unwrap();
        let text = fs::read_to_string(mix.path.join("file.txt")).unwrap();
        assert!(text.contains("A top\n") && text.contains("B bottom\n") && !text.contains("B top") && !text.contains("A bottom"));
        // Nothing in the repo or the source runs changed.
        assert!(fs::read_to_string(r.0.join("file.txt")).unwrap().contains("line 2\n"));
        assert_eq!(diff::pending(&a).unwrap()[0].hunks.len(), 2);
        assert_eq!(diff::accept_all(&r.0, &mix).unwrap(), 1);
        diff::commit(&r.0, "ghép").unwrap();
        let text = fs::read_to_string(r.0.join("file.txt")).unwrap();
        assert!(text.contains("A top\n") && text.contains("B bottom\n"));
        worktree::remove(&r.0, &mix, true).unwrap();
    }

    #[test]
    fn overlapping_picks_fail_and_leave_no_worktree() {
        let r = Repo::new();
        let (a, b) = two_runs(&r);
        let sources = HashMap::from([(a.run_id.clone(), a.clone()), (b.run_id.clone(), b.clone())]);
        let err = compose(&r.0, "mix-2", &sources, &[hunk(&a, "A top"), hunk(&b, "B top")]).unwrap_err();
        assert!(err.contains("file.txt"), "{err}");
        assert_eq!(worktree::list(&r.0).unwrap().len(), 2);
        assert!(compose(&r.0, "mix-3", &sources, &[]).is_err());
        let missing = Pick { run_id: a.run_id.clone(), path: "file.txt".into(), hunk_id: "nope".into() };
        assert!(compose(&r.0, "mix-4", &sources, &[missing]).is_err());
        assert_eq!(worktree::list(&r.0).unwrap().len(), 2);
    }

    #[test]
    fn runs_from_different_bases_are_refused() {
        let r = Repo::new();
        let a = worktree::create(&r.0, "claude", "t", "aaaaaaaa-1").unwrap();
        r.write("other.txt", "x\n");
        worktree::git(&r.0, &["add", "."], None).unwrap();
        worktree::git(&r.0, &["commit", "-m", "moved"], None).unwrap();
        let b = worktree::create(&r.0, "codex", "t", "bbbbbbbb-2").unwrap();
        edit(&a, "line 2\n", "A\n");
        let sources = HashMap::from([(a.run_id.clone(), a.clone()), (b.run_id.clone(), b)]);
        assert!(compose(&r.0, "mix", &sources, &[hunk(&a, "A")]).unwrap_err().contains("gốc"));
    }

    #[tokio::test]
    async fn check_reports_exit_code_and_both_streams() {
        let dir = std::env::temp_dir();
        #[cfg(not(windows))]
        let (ok, bad) = ("echo xin chào", "echo out; echo err 1>&2; exit 3");
        #[cfg(windows)]
        let (ok, bad) = ("echo xin chao", "echo out & echo err 1>&2 & exit /b 3");
        let r = run_check(&dir, ok).await.unwrap();
        assert_eq!(r.code, Some(0));
        assert!(r.output.contains("xin ch"));
        let r = run_check(&dir, bad).await.unwrap();
        assert_eq!(r.code, Some(3));
        assert!(r.output.contains("out") && r.output.contains("err"));
        assert!(run_check(&dir, "  ").await.is_err());
    }
}
