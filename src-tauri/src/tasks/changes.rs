//! A run's changes and files: diff, keep or drop, revert, commit, read and write. None of them while an agent writes in the same folder.

use super::*;

/// Shown when another agent writes in the user's repo.
pub(crate) const BUSY_REPO: &str = "Một agent đang sửa trong thư mục của bạn. Hãy chờ nó xong rồi làm tiếp.";

pub(super) fn stored_worktree(store: &Store, id: &str) -> Result<(PathBuf, Worktree), String> {
    store.run_worktree(id).map_err(|e| format!("Không tìm thấy bản nháp của lượt chạy: {e}"))
}
#[tauri::command(async)]
pub fn get_diff(store: State<'_, Store>, run_id: String) -> Result<Vec<FileDiff>, String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    diff::exclusive(&wt, || diff::pending(&wt))
}
#[tauri::command(async)]
pub fn accept_all(store: State<'_, Store>, tasks: State<'_, TaskRuns>, run_id: String) -> Result<usize, String> {
    let (repo, wt) = stored_worktree(&store, &run_id)?;
    // Applying writes into the user's folder: not while an agent works there.
    let running = "Agent vẫn đang chạy. Hãy chờ agent xong rồi mới dùng bản này.";
    tasks.quiet_in(Some((&run_id, running)), &[(&wt.path, Some(running)), (&repo, Some(BUSY_REPO))], || diff::accept_all(&repo, &wt))
}
#[tauri::command(async)]
pub fn commit_accepted(store: State<'_, Store>, tasks: State<'_, TaskRuns>, run_id: String, message: String) -> Result<String, String> {
    let (repo, wt) = stored_worktree(&store, &run_id)?;
    // The commit takes what is in the repo now: not while an agent writes there. The draft's
    // own agent may go on working in its draft.
    tasks.quiet_in(None, &[(&wt.path, None), (&repo, Some(BUSY_REPO))], || diff::commit(&repo, &message))
}
/// Whether the run works in the user's folder, and the uncommitted files there it did not change.
#[tauri::command(async)]
pub fn own_changes(store: State<'_, Store>, run_id: String) -> Result<diff::OwnChanges, String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    diff::exclusive(&wt, || diff::own_changes(&wt))
}
#[tauri::command(async)]
pub fn revert_files(store: State<'_, Store>, tasks: State<'_, TaskRuns>, run_id: String, paths: Vec<String>) -> Result<(), String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    let busy = "Agent đang sửa. Hãy dừng hoặc chờ agent xong rồi mới hoàn tác.";
    tasks.quiet_in(Some((&run_id, busy)), &[(&wt.path, Some(busy))], || diff::revert_files(&wt, &paths))
}
/// Commits the chosen files from the user's folder. Every direct run of the repository then
/// counts them as done, so they leave its list of changes.
#[tauri::command(async)]
pub fn commit_files(store: State<'_, Store>, tasks: State<'_, TaskRuns>, run_id: String, paths: Vec<String>, message: String) -> Result<String, String> {
    let (repo, wt) = stored_worktree(&store, &run_id)?;
    // Files are committed from the repo, whatever the run: a writer there would slip its edits
    // in (for a direct run that is its own agent too). The repo's lock also covers every direct
    // run's bookkeeping, as they all work in the repo.
    let busy = if wt.is_direct() { "Agent đang sửa. Hãy dừng hoặc chờ agent xong rồi mới commit." } else { BUSY_REPO };
    tasks.quiet_in(None, &[(&wt.path, None), (&repo, Some(busy))], || {
        let hash = diff::commit_files(&repo, &paths, &message)?;
        let runs = store.direct_worktrees(&repo.to_string_lossy()).map_err(|e| format!("Đã commit {} nhưng không đọc được lịch sử: {e}", &hash[..7.min(hash.len())]))?;
        for wt in runs {
            if let Err(e) = diff::mark_committed(&wt, &paths) { eprintln!("Không cập nhật được thay đổi của {}: {e}", wt.run_id); }
        }
        Ok(hash)
    })
}
#[tauri::command(async)]
pub fn list_worktree_files(store: State<'_, Store>, run_id: String) -> Result<Vec<String>, String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    files::list_files(&wt)
}
#[tauri::command(async)]
pub fn read_worktree_file(store: State<'_, Store>, run_id: String, path: String) -> Result<String, String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    files::read_file(&wt, &path)
}
#[tauri::command(async)]
pub fn write_worktree_file(store: State<'_, Store>, tasks: State<'_, TaskRuns>, run_id: String, path: String, content: String) -> Result<(), String> {
    // The agent may be writing the same file; edits wait until it is done.
    let (_, wt) = stored_worktree(&store, &run_id)?;
    let busy = "Agent đang chạy. Hãy chờ agent xong rồi mới sửa tệp.";
    // Under the folder's lock: a draft applied to the same repo, or a commit, may be running.
    tasks.quiet_in(Some((&run_id, busy)), &[(&wt.path, Some(busy))], || files::write_file(&wt, &path, &content))
}

/// Where the run's agent works: its draft, or the user's folder with the conversation's subfolder.
#[tauri::command(async)]
pub fn run_dir(store: State<'_, Store>, run_id: String) -> Result<String, String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    let scope = store.live_run_scope(&run_id).map_err(|e| format!("Không đọc được lượt chạy: {e}"))?.flatten();
    Ok(crate::system::env::scoped_dir(&wt.path, scope.as_deref())?.to_string_lossy().into_owned())
}
