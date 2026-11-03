//! Tauri boundary and process lifetime for ACP tasks. Session routing stays UI-independent.

use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio, sync::{Arc, Mutex}, time::Duration};
use serde_json::json;
use tauri::{AppHandle, Manager, State};
use tokio::{io::{AsyncBufReadExt, BufReader}, process::{Child, Command}, sync::oneshot};
use crate::{acp::client::AcpClient, acp_runner::{TaskSession, EventSink, RuleMemory}, adapters::AgentKind, diff::{self, FileDiff}, env, runner::{self, AgentEvent, Runs}, store::{NewRun, Store}, worktree::{self, Worktree}};

#[derive(Default)]
pub struct TaskRuns(Mutex<HashMap<String, Arc<TaskSession>>>);

struct AppSink(AppHandle);
impl EventSink for AppSink {
    fn emit(&self, ev: AgentEvent) { runner::publish(&self.0, ev); }
}
struct RepoRules { app: AppHandle, repo: String, agent: AgentKind }
impl RuleMemory for RepoRules {
    fn rules(&self) -> Result<Vec<String>, String> {
        self.app.state::<Store>().rules_for(&self.repo, self.agent).map_err(|e| format!("Không đọc được quy tắc: {e}"))
    }
    fn add(&self, rule: &str) -> Result<(), String> {
        self.app.state::<Store>().add_rule(&self.repo, self.agent, rule).map_err(|e| format!("Không lưu được quy tắc: {e}"))
    }
}

// Validate and spawn before inserting anything. A failed spawn leaves no run or worktree.
async fn prepare(store: &Store, agent: AgentKind, prompt: &str, repo: &Path, command: (PathBuf, Vec<String>)) -> Result<(Worktree, Child), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let agent_name = serde_json::to_value(agent).unwrap();
    let wt = worktree::create(repo, agent_name.as_str().unwrap(), prompt, &id)?;
    let mut process = Command::new(&command.0);
    process.args(&command.1).current_dir(&wt.path)
        .env("PATH", env::login_path()).stdin(Stdio::piped()).stdout(Stdio::piped())
        .stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        process.as_std_mut().process_group(0);
    }
    let spawned = process.spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            let cleanup = worktree::remove(repo, &wt, true);
            return Err(format!("Không chạy được adapter {}: {e}{}", command.0.display(), cleanup.err().map(|e| format!("; {e}")).unwrap_or_default()));
        }
    };
    let saved = store.insert_run_with_worktree(&NewRun { id: &id, agent, prompt, cwd: &wt.path.to_string_lossy(), started_at: runner::now_ms() }, &repo.to_string_lossy(), &wt);
    if let Err(e) = saved {
        let pid = child.id();
        terminate_adapter(&mut child, pid).await;
        let cleanup = worktree::remove(repo, &wt, true);
        return Err(format!("Không lưu được lượt chạy: {e}{}", cleanup.err().map(|e| format!("; {e}")).unwrap_or_default()));
    }
    Ok((wt, child))
}

// npx is a wrapper: its adapter descendants must stop along with the run.
async fn terminate_adapter(child: &mut Child, pid: Option<u32>) {
    if let Some(pid) = pid {
        #[cfg(unix)] {
            let mut kill = Command::new("kill");
            kill.args(["-KILL", "--", &format!("-{pid}")]).env("PATH", env::login_path())
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
            let _ = tokio::time::timeout(Duration::from_secs(2), kill.status()).await;
        }
        #[cfg(windows)] {
            let mut kill = Command::new("taskkill");
            kill.args(["/PID", &pid.to_string(), "/T", "/F"]).env("PATH", env::login_path())
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
            let _ = tokio::time::timeout(Duration::from_secs(2), kill.status()).await;
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

// No AppHandle or real adapter required to exercise cancellation and failure status.
async fn drive(client: &AcpClient, session: &TaskSession, cwd: &Path, prompt: &str, mut stop: oneshot::Receiver<()>, dead: impl std::future::Future<Output = ()>) -> (&'static str, Option<String>) {
    tokio::pin!(dead);
    let setup = async {
        client.initialize().await?;
        client.new_session(cwd, json!([])).await
    };
    let session_id = tokio::select! {
        biased;
        _ = &mut stop => { session.finish().await; return ("stopped", None); }
        _ = &mut dead => { session.finish().await; return ("failed", Some("Adapter đã dừng khi đang khởi tạo.".into())); }
        result = setup => match result {
            Ok(id) => id,
            Err(e) => { session.finish().await; return ("failed", Some(e)); }
        }
    };
    let turn = client.prompt(&session_id, prompt);
    tokio::pin!(turn);
    let result = tokio::select! {
        biased;
        _ = &mut stop => {
            session.cancel_pending();
            let _ = client.cancel(&session_id);
            let _ = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::select! { _ = &mut turn => {}, _ = &mut dead => {} }
            }).await;
            ("stopped", None)
        }
        result = &mut turn => match result {
            Ok(_) => ("done", None),
            Err(e) => ("failed", Some(format!("Phiên ACP thất bại: {e}"))),
        },
        _ = &mut dead => ("failed", Some("Adapter đã dừng trước khi hoàn tất yêu cầu.".into())),
    };
    session.finish().await;
    result
}

#[tauri::command]
pub async fn start_task(app: AppHandle, agent: AgentKind, prompt: String, repo: String) -> Result<String, String> {
    // Normalize the repository identity, including callers selecting a subdirectory.
    let root = worktree::git(Path::new(&repo), &["rev-parse", "--show-toplevel"], None)
        .map_err(|e| format!("Thư mục không phải kho Git. {e}"))?;
    let repo = std::fs::canonicalize(root.trim()).map_err(|e| format!("Không mở được kho Git: {e}"))?;
    let command = agent.acp_command(env::which).ok_or_else(|| format!("Không tìm thấy adapter cho {} hoặc npx trong PATH.", agent.display_name()))?;
    let (wt, mut child) = prepare(&app.state::<Store>(), agent, &prompt, &repo, command).await?;
    let id = wt.run_id.clone();
    let pid = child.id();
    let sink = Arc::new(AppSink(app.clone()));
    let rules = Arc::new(RepoRules { app: app.clone(), repo: repo.to_string_lossy().into_owned(), agent });
    let session = match TaskSession::new(&id, agent, &wt.path, sink.clone(), rules) {
        Ok(session) => Arc::new(session),
        Err(e) => {
            terminate_adapter(&mut child, pid).await;
            let _ = app.state::<Store>().finish_run(&id, "failed", None, runner::now_ms());
            return Err(e);
        }
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let stdin = child.stdin.take().expect("piped stdin");
    let stderr = child.stderr.take().expect("piped stderr");
    let client = AcpClient::start(stdout, stdin, session.clone());
    let (tx, rx) = oneshot::channel();
    app.state::<Runs>().0.lock().unwrap().insert(id.clone(), tx);
    app.state::<TaskRuns>().0.lock().unwrap().insert(id.clone(), session.clone());
    let mut started = AgentEvent::new(&id, agent, "started");
    started.line = Some(format!("{} · {}", agent.display_name(), wt.path.display()));
    sink.emit(started);
    let stderr_sink = sink.clone();
    let stderr_id = id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut event = AgentEvent::new(&stderr_id, agent, "stderr");
            event.line = Some(line);
            stderr_sink.emit(event);
        }
    });
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let (status, error) = drive(&client, &session, &wt.path, &prompt, rx, async { let _ = child.wait().await; }).await;
        client.close();
        terminate_adapter(&mut child, pid).await;
        // Descendants may keep stderr open; do not leave an unbounded log task behind.
        stderr_task.abort();
        let _ = stderr_task.await;
        if let Some(error) = error {
            let mut event = AgentEvent::new(&task_id, agent, "stderr");
            event.line = Some(error);
            sink.emit(event);
        }
        let code = if status == "done" { Some(0) } else { None };
        if let Err(e) = app.state::<Store>().finish_run(&task_id, status, code, runner::now_ms()) {
            eprintln!("Không lưu được trạng thái lượt chạy: {e}");
        }
        app.state::<TaskRuns>().0.lock().unwrap().remove(&task_id);
        app.state::<Runs>().0.lock().unwrap().remove(&task_id);
        let mut event = AgentEvent::new(&task_id, agent, "exit");
        event.code = code;
        event.data = Some(json!({"status":status}));
        sink.emit(event);
    });
    Ok(id)
}

#[tauri::command]
pub fn respond_permission(tasks: State<'_, TaskRuns>, run_id: String, request_id: String, option_id: String, always: bool) -> Result<(), String> {
    let session = tasks.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.get(&run_id).cloned().ok_or("Lượt chạy này đã kết thúc.")?;
    session.respond_permission(&request_id, &option_id, always)
}
fn stored_worktree(store: &Store, id: &str) -> Result<(PathBuf, Worktree), String> {
    store.run_worktree(id).map_err(|e| format!("Không tìm thấy worktree của lượt chạy: {e}"))
}
#[tauri::command]
pub fn get_diff(store: State<'_, Store>, run_id: String) -> Result<Vec<FileDiff>, String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    diff::pending(&wt)
}
#[tauri::command]
pub fn accept_hunk(store: State<'_, Store>, run_id: String, path: String, hunk_id: String) -> Result<(), String> {
    let (repo, wt) = stored_worktree(&store, &run_id)?;
    diff::accept_hunk(&repo, &wt, &path, &hunk_id)
}
#[tauri::command]
pub fn reject_hunk(store: State<'_, Store>, run_id: String, path: String, hunk_id: String) -> Result<(), String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    diff::reject_hunk(&wt, &path, &hunk_id)
}
#[tauri::command]
pub fn commit_accepted(store: State<'_, Store>, run_id: String, message: String) -> Result<String, String> {
    let (repo, _) = stored_worktree(&store, &run_id)?;
    diff::commit(&repo, &message)
}
#[tauri::command]
pub fn discard_worktree(store: State<'_, Store>, tasks: State<'_, TaskRuns>, run_id: String) -> Result<(), String> {
    if tasks.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.contains_key(&run_id) {
        return Err("Hãy dừng lượt chạy trước khi xóa worktree.".into());
    }
    let (repo, wt) = stored_worktree(&store, &run_id)?;
    worktree::remove(&repo, &wt, true)?;
    store.clear_run_worktree(&run_id).map_err(|e| format!("Đã xóa worktree nhưng không cập nhật được lịch sử: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::tests::Repo;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<AgentEvent>>);
    impl EventSink for Recorder { fn emit(&self, event: AgentEvent) { self.0.lock().unwrap().push(event); } }
    struct Rules;
    impl RuleMemory for Rules {
        fn rules(&self) -> Result<Vec<String>, String> { Ok(vec![]) }
        fn add(&self, _: &str) -> Result<(), String> { Ok(()) }
    }
    async fn wait_permission(sink: &Recorder) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if sink.0.lock().unwrap().iter().any(|e| e.kind == "permission") { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
    }
    #[tokio::test]
    async fn fake_prompt_completion_and_crash_have_distinct_statuses() {
        use crate::acp::fake::{self, Step};
        for (steps, status) in [(vec![Step::End("end_turn")], "done"), (vec![Step::AskPermission, Step::Crash], "failed")] {
            let sink = Arc::new(Recorder::default());
            let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
            let (reader, writer, _) = fake::spawn(steps);
            let client = AcpClient::start(reader, writer, session.clone());
            let (_tx, rx) = oneshot::channel();
            let result = tokio::time::timeout(Duration::from_secs(2), drive(&client, &session, &std::env::temp_dir(), "p", rx, std::future::pending())).await.unwrap();
            assert_eq!(result.0, status);
            if status == "failed" {
                let events = sink.0.lock().unwrap();
                assert_eq!(events.iter().filter(|e| e.kind == "permission").count(), 1);
                assert_eq!(events.iter().filter(|e| e.kind == "permission_resolved").count(), 1);
            }
        }
    }
    #[tokio::test]
    async fn user_stop_sends_cancel_resolves_cards_and_reports_stopped() {
        use crate::acp::fake::{self, Step};
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
        let (reader, writer, log) = fake::spawn(vec![Step::AskPermission, Step::WaitForCancel, Step::End("cancelled")]);
        let client = AcpClient::start(reader, writer, session.clone());
        let (tx, rx) = oneshot::channel();
        let request_stop = async { wait_permission(&sink).await; tx.send(()).unwrap(); };
        let cwd = std::env::temp_dir();
        let (result, _) = tokio::join!(drive(&client, &session, &cwd, "p", rx, std::future::pending()), request_stop);
        assert_eq!(result.0, "stopped");
        assert!(log.lock().unwrap().iter().any(|v| v["method"] == "session/cancel"));
        assert!(sink.0.lock().unwrap().iter().any(|e| e.kind == "permission_resolved" && e.data.as_ref().unwrap()["outcome"]["outcome"] == "cancelled"));
    }
    #[tokio::test]
    async fn process_death_with_open_stdio_does_not_hang() {
        use crate::acp::fake::{self, Step};
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
        let (reader, writer, _) = fake::spawn(vec![Step::AskPermission, Step::WaitForPermissionReply]);
        let client = AcpClient::start(reader, writer, session.clone());
        let (_tx, rx) = oneshot::channel();
        let dead = async { wait_permission(&sink).await; };
        let result = drive(&client, &session, &std::env::temp_dir(), "p", rx, dead).await;
        assert_eq!(result.0, "failed");
        assert!(sink.0.lock().unwrap().iter().any(|e| e.kind == "permission_resolved"));
    }
    #[tokio::test]
    async fn unresponsive_agent_gets_five_seconds_after_cancel() {
        use crate::acp::fake::{self, Step};
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
        let (reader, writer, _) = fake::spawn(vec![Step::AskPermission, Step::WaitForCancel]);
        let client = AcpClient::start(reader, writer, session.clone());
        let (tx, rx) = oneshot::channel();
        let request_stop = async {
            wait_permission(&sink).await;
            tx.send(()).unwrap();
            std::time::Instant::now()
        };
        let cwd = std::env::temp_dir();
        let (result, requested_at) = tokio::time::timeout(Duration::from_secs(8), async {
            tokio::join!(drive(&client, &session, &cwd, "p", rx, std::future::pending()), request_stop)
        }).await.unwrap();
        assert_eq!(result.0, "stopped");
        assert!(requested_at.elapsed() >= Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn adapter_cleanup_kills_descendants_holding_stdio() {
        use std::os::unix::process::CommandExt;
        use tokio::io::AsyncReadExt;
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 & wait"]).env("PATH", env::login_path())
            .stdout(Stdio::piped()).kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        let mut stdout = child.stdout.take().unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        terminate_adapter(&mut child, pid).await;
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), stdout.read_to_end(&mut bytes)).await.unwrap().unwrap();
    }

    #[test]
    fn reopened_store_supports_diff_accept_reject_and_commit() {
        let repo = Repo::new();
        let wt = repo.wt();
        let db = repo.0.join("history.db");
        {
            let store = Store::open(&db).unwrap();
            store.insert_run_with_worktree(&NewRun { id: &wt.run_id, agent: AgentKind::Codex, prompt: "p", cwd: wt.path.to_str().unwrap(), started_at: 1 }, repo.0.to_str().unwrap(), &wt).unwrap();
        }
        std::fs::write(wt.path.join("new.txt"), "accepted\n").unwrap();
        std::fs::write(wt.path.join("reject.txt"), "rejected\n").unwrap();
        let store = Store::open(&db).unwrap();
        let (root, restored) = stored_worktree(&store, &wt.run_id).unwrap();
        let pending = diff::pending(&restored).unwrap();
        for file in pending {
            if file.path == "new.txt" { diff::accept_hunk(&root, &restored, &file.path, &file.hunks[0].id).unwrap(); }
            if file.path == "reject.txt" { diff::reject_hunk(&restored, &file.path, &file.hunks[0].id).unwrap(); }
        }
        assert!(diff::pending(&restored).unwrap().is_empty());
        let hash = diff::commit(&root, "accepted only").unwrap();
        assert!(!hash.is_empty());
        assert_eq!(std::fs::read_to_string(repo.0.join("new.txt")).unwrap(), "accepted\n");
        assert!(!repo.0.join("reject.txt").exists());
        worktree::remove(&root, &restored, true).unwrap();
        assert!(!restored.path.exists());
    }

    #[tokio::test]
    async fn failed_spawn_removes_worktree_branch_and_does_not_insert_run() {
        let repo = Repo::new();
        let store = Store::open_in_memory().unwrap();
        let missing = repo.0.join("missing-adapter");
        let result = prepare(&store, AgentKind::Codex, "task", &repo.0, (missing, vec![])).await;
        assert!(result.err().unwrap().contains("Không chạy được"));
        assert!(store.list_runs(10).unwrap().is_empty());
        assert!(worktree::list(&repo.0).unwrap().is_empty());
        assert!(worktree::git(&repo.0, &["branch", "--list", "tg/*"], None).unwrap().is_empty());
    }

    #[tokio::test]
    async fn invalid_and_uncommitted_repos_never_create_runs() {
        let path = std::env::temp_dir().join(format!("tg-invalid-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let store = Store::open_in_memory().unwrap();
        let missing = path.join("missing");
        let error = prepare(&store, AgentKind::Codex, "task", &path, (missing.clone(), vec![])).await.err().unwrap();
        assert!(error.contains("Git"));
        worktree::git(&path, &["init"], None).unwrap();
        let error = prepare(&store, AgentKind::Codex, "task", &path, (missing, vec![])).await.err().unwrap();
        assert!(error.contains("commit"));
        assert!(store.list_runs(10).unwrap().is_empty());
        assert!(!path.join(".tg").exists());
        std::fs::remove_dir_all(path).unwrap();
    }
}
