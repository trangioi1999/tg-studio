//! Throwing a draft away and deleting conversations.

use super::*;

#[tauri::command]
pub async fn discard_worktree(store: State<'_, Store>, tasks: State<'_, TaskRuns>, runs: State<'_, Runs>, run_id: String) -> Result<(), String> {
    let mut sharing = store.runs_sharing_worktree(&run_id).map_err(|e| format!("Không đọc được lịch sử: {e}"))?;
    sharing.push(run_id.clone());
    for id in &sharing {
        if tasks.busy(id)? {
            return Err("Hãy dừng agent đang dùng bản nháp này trước khi xóa.".into());
        }
    }
    // Sessions waiting for a next message have no more to do here. Windows cannot
    // delete a folder a process runs in, so wait until they are gone.
    let open = |id: &String| tasks.0.lock().map(|live| live.contains_key(id)).unwrap_or(false);
    for id in sharing.iter().filter(|id| open(id)) {
        if let Some(stop) = runs.0.lock().map_err(|e| e.to_string())?.remove(id) { let _ = stop.send(()); }
    }
    for _ in 0..50 {
        if !sharing.iter().any(|id| open(id)) { break; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let (repo, wt) = stored_worktree(&store, &run_id)?;
    worktree::remove(&repo, &wt, true)?;
    store.clear_run_worktree(&run_id).map_err(|e| format!("Đã xóa bản nháp nhưng không cập nhật được lịch sử: {e}"))
}

#[tauri::command]
pub async fn delete_runs(store: State<'_, Store>, tasks: State<'_, TaskRuns>, runs: State<'_, Runs>, run_ids: Vec<String>) -> Result<(), String> {
    delete_runs_inner(&store, &tasks, &runs, &run_ids).await
}

pub(super) async fn delete_runs_inner(store: &Store, tasks: &TaskRuns, runs: &Runs, run_ids: &[String]) -> Result<(), String> {
    for id in run_ids {
        if tasks.busy(id)? {
            return Err("Hãy dừng agent trước khi xoá cuộc trò chuyện.".into());
        }
    }
    // Also stop read-only sessions, which are not present in TaskRuns.
    {
        let mut live = runs.0.lock().map_err(|_| "Không đọc được phiên agent.")?;
        for id in run_ids {
            if let Some(stop) = live.remove(id) { let _ = stop.send(()); }
        }
    }
    for _ in 0..50 {
        let open = {
            let live = tasks.0.lock().map_err(|_| "Không đọc được phiên ACP.")?;
            run_ids.iter().any(|id| live.contains_key(id))
        };
        if !open { break; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut seen = std::collections::HashSet::new();
    let mut errors = Vec::new();
    for id in run_ids {
        let (repo, wt) = match store.run_worktree(id) {
            Ok(wt) => wt,
            Err(rusqlite::Error::QueryReturnedNoRows) => continue,
            Err(e) => return Err(format!("Không đọc được lịch sử: {e}")),
        };
        // One owner per worktree (direct runs all share the repo's path, not its bookkeeping).
        if !seen.insert(wt.run_id.clone()) { continue; }
        let sharing = store.runs_sharing_worktree(id).map_err(|e| format!("Không đọc được lịch sử: {e}"))?;
        if sharing.iter().any(|other| !run_ids.contains(other)) { continue; }
        if let Err(e) = worktree::remove(&repo, &wt, true) { errors.push(e); }
    }
    store.delete_runs(run_ids, crate::system::clock::now_ms()).map_err(|e| format!("Không xoá được cuộc trò chuyện: {e}"))?;
    if errors.is_empty() { Ok(()) }
    else { Err(format!("Đã xoá cuộc trò chuyện, nhưng chưa dọn được bản nháp: {}", errors.join("; "))) }
}
