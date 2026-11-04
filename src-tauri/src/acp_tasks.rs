//! Tauri boundary and process lifetime for ACP tasks. Session routing stays UI-independent.

use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio, sync::{Arc, Mutex}, time::Duration};
use serde_json::json;
use tauri::{AppHandle, Manager, State};
use tokio::{io::{AsyncBufReadExt, BufReader}, process::{Child, Command}, sync::oneshot};
use crate::{acp::client::AcpClient, acp_runner::{TaskSession, EventSink, RuleMemory}, adapters::AgentKind, diff::{self, FileDiff}, env, runner::{self, AgentEvent, Runs}, store::{NewRun, Store}, workspace, worktree::{self, Worktree}};

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
/// `reuse`: run in an existing worktree (a later pipeline step); it is never removed here.
async fn prepare(store: &Store, agent: AgentKind, prompt: &str, repo: &Path, command: (PathBuf, Vec<String>), group: Option<&str>, reuse: Option<Worktree>) -> Result<(Worktree, Child), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let agent_name = serde_json::to_value(agent).unwrap();
    let shared = reuse.is_some();
    let wt = match reuse {
        Some(wt) => wt,
        None => worktree::create(repo, agent_name.as_str().unwrap(), prompt, &id)?,
    };
    let cleanup = |wt: &Worktree| if shared { Ok(()) } else { worktree::remove(repo, wt, true) };
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
            let cleanup = cleanup(&wt);
            return Err(format!("Không chạy được adapter {}: {e}{}", command.0.display(), cleanup.err().map(|e| format!("; {e}")).unwrap_or_default()));
        }
    };
    let saved = store.insert_run_with_worktree(&NewRun { id: &id, agent, prompt, cwd: &wt.path.to_string_lossy(), started_at: runner::now_ms() }, &repo.to_string_lossy(), &wt, group);
    if let Err(e) = saved {
        let pid = child.id();
        terminate_adapter(&mut child, pid).await;
        let cleanup = cleanup(&wt);
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
    let turn = client.prompt_turn(&session_id, prompt);
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
            Ok(result) => { session.turn_finished(&result); ("done", None) }
            Err(e) => ("failed", Some(format!("Phiên ACP thất bại: {e}"))),
        },
        _ = &mut dead => ("failed", Some("Adapter đã dừng trước khi hoàn tất yêu cầu.".into())),
    };
    session.finish().await;
    result
}

#[tauri::command]
pub async fn start_task(app: AppHandle, agent: AgentKind, prompt: String, repo: String, group: Option<String>, reuse: Option<String>) -> Result<String, String> {
    if group.as_deref().is_some_and(|g| g.is_empty() || g.len() > 64 || !g.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) {
        return Err("Mã nhóm lượt chạy không hợp lệ.".into());
    }
    // Normalize the repository identity, including callers selecting a subdirectory.
    let root = worktree::git(Path::new(&repo), &["rev-parse", "--show-toplevel"], None)
        .map_err(|e| format!("Thư mục không phải kho Git. {e}"))?;
    let repo = dunce::canonicalize(root.trim()).map_err(|e| format!("Không mở được kho Git: {e}"))?;
    let command = agent.acp_command(env::which).ok_or_else(|| format!("Không tìm thấy adapter cho {} hoặc npx trong PATH.", agent.display_name()))?;
    // A later pipeline step continues in the worktree of a finished earlier step.
    let reuse = match reuse {
        None => None,
        Some(previous) => {
            if app.state::<TaskRuns>().0.lock().map_err(|_| "Không đọc được phiên ACP.")?.contains_key(&previous) {
                return Err("Bước trước vẫn đang chạy.".into());
            }
            let (stored, wt) = app.state::<Store>().run_worktree(&previous).map_err(|e| format!("Không tìm thấy worktree của bước trước: {e}"))?;
            if stored != repo { return Err("Bước trước thuộc repo khác.".into()); }
            Some(wt)
        }
    };
    let (wt, mut child) = prepare(&app.state::<Store>(), agent, &prompt, &repo, command, group.as_deref(), reuse).await?;
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
pub fn accept_all(store: State<'_, Store>, tasks: State<'_, TaskRuns>, run_id: String) -> Result<usize, String> {
    if tasks.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.contains_key(&run_id) {
        return Err("Agent vẫn đang chạy. Hãy chờ agent xong rồi mới dùng bản này.".into());
    }
    let (repo, wt) = stored_worktree(&store, &run_id)?;
    diff::accept_all(&repo, &wt)
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
pub fn list_worktree_files(store: State<'_, Store>, run_id: String) -> Result<Vec<String>, String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    workspace::list_files(&wt)
}
#[tauri::command]
pub fn read_worktree_file(store: State<'_, Store>, run_id: String, path: String) -> Result<String, String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    workspace::read_file(&wt, &path)
}
#[tauri::command]
pub fn write_worktree_file(store: State<'_, Store>, tasks: State<'_, TaskRuns>, run_id: String, path: String, content: String) -> Result<(), String> {
    // The agent may be writing the same file; edits wait until it is done.
    if tasks.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.contains_key(&run_id) {
        return Err("Agent đang chạy. Hãy chờ agent xong rồi mới sửa tệp.".into());
    }
    let (_, wt) = stored_worktree(&store, &run_id)?;
    workspace::write_file(&wt, &path, &content)
}
#[tauri::command]
pub fn discard_worktree(store: State<'_, Store>, tasks: State<'_, TaskRuns>, run_id: String) -> Result<(), String> {
    let sharing = store.runs_sharing_worktree(&run_id).map_err(|e| format!("Không đọc được lịch sử: {e}"))?;
    let live = tasks.0.lock().map_err(|_| "Không đọc được phiên ACP.")?;
    if live.contains_key(&run_id) || sharing.iter().any(|id| live.contains_key(id)) {
        return Err("Hãy dừng lượt chạy (hoặc bước pipeline) đang dùng worktree này trước khi xóa.".into());
    }
    drop(live);
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
            store.insert_run_with_worktree(&NewRun { id: &wt.run_id, agent: AgentKind::Codex, prompt: "p", cwd: wt.path.to_str().unwrap(), started_at: 1 }, repo.0.to_str().unwrap(), &wt, None).unwrap();
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
        let result = prepare(&store, AgentKind::Codex, "task", &repo.0, (missing, vec![]), None, None).await;
        assert!(result.err().unwrap().contains("Không chạy được"));
        assert!(store.list_runs(10).unwrap().is_empty());
        assert!(worktree::list(&repo.0).unwrap().is_empty());
        assert!(worktree::git(&repo.0, &["branch", "--list", "tg/*"], None).unwrap().is_empty());
    }

    // Copies each JSON-RPC line between the client and a real adapter into `log`.
    fn tee<R, W>(from: R, mut to: W, dir: &'static str, log: Arc<Mutex<Vec<serde_json::Value>>>) -> tokio::task::JoinHandle<()>
    where R: tokio::io::AsyncRead + Unpin + Send + 'static, W: tokio::io::AsyncWrite + Unpin + Send + 'static {
        use tokio::io::AsyncWriteExt;
        tokio::spawn(async move {
            let mut lines = BufReader::new(from).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    log.lock().unwrap().push(json!({"dir": dir, "msg": value}));
                }
                if to.write_all(format!("{line}\n").as_bytes()).await.is_err() { break; }
                let _ = to.flush().await;
            }
            let _ = to.shutdown().await;
        })
    }

    struct LiveRun { wt: Worktree, status: &'static str, error: Option<String>, events: Vec<AgentEvent>, asked: Vec<serde_json::Value>, traffic: Vec<serde_json::Value> }

    /// Spawns the real Claude adapter for one task and plays the user: every card is allowed once.
    async fn run_live(store: &Store, repo: &Path, prompt: &str, group: Option<&str>) -> LiveRun {
        let command = AgentKind::Claude.acp_command(env::which).expect("claude-agent-acp hoặc npx");
        let (wt, mut child) = prepare(store, AgentKind::Claude, prompt, repo, command, group, None).await.unwrap();
        let pid = child.id();
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new(&wt.run_id, AgentKind::Claude, &wt.path, sink.clone(), Arc::new(Rules)).unwrap());
        let traffic = Arc::new(Mutex::new(Vec::new()));
        let (client_in, tee_out) = tokio::io::duplex(1 << 20);
        let (tee_in, client_out) = tokio::io::duplex(1 << 20);
        let _down = tee(child.stdout.take().unwrap(), tee_out, "agent", traffic.clone());
        let _up = tee(client_out, child.stdin.take().unwrap(), "client", traffic.clone());
        let stderr = child.stderr.take().unwrap();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await { eprintln!("[adapter] {line}"); }
        });
        let client = AcpClient::start(client_in, tee_in, session.clone());
        // Plays the user: allow every card once and remember which tools asked.
        let approver = {
            let (sink, session) = (sink.clone(), session.clone());
            tokio::spawn(async move {
                let mut seen = std::collections::HashSet::new();
                let mut asked = Vec::new();
                loop {
                    let cards: Vec<_> = sink.0.lock().unwrap().iter().filter(|e| e.kind == "permission").filter_map(|e| e.data.clone()).collect();
                    for card in cards {
                        let id = card["requestId"].as_str().unwrap().to_string();
                        if !seen.insert(id.clone()) { continue; }
                        let option = card["options"].as_array().unwrap().iter()
                            .find(|o| o["kind"] == "allow_once").or_else(|| card["options"].as_array().unwrap().iter().find(|o| o["kind"] == "allow_always"))
                            .expect("thẻ duyệt không có lựa chọn cho phép")["optionId"].as_str().unwrap().to_string();
                        eprintln!("[duyệt] {} → {option}", card["toolCall"]["title"]);
                        asked.push(card["toolCall"].clone());
                        session.respond_permission(&id, &option, false).unwrap();
                    }
                    if seen.len() > 20 { break asked; }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    if sink.0.lock().unwrap().iter().any(|e| e.kind == "exit") { break asked; }
                }
            })
        };
        let (_tx, rx) = oneshot::channel();
        let (status, error) = tokio::time::timeout(Duration::from_secs(300), drive(&client, &session, &wt.path, prompt, rx, async { std::future::pending::<()>().await })).await.expect("quá 5 phút");
        client.close();
        terminate_adapter(&mut child, pid).await;
        sink.emit(AgentEvent::new(&wt.run_id, AgentKind::Claude, "exit"));
        let asked = approver.await.unwrap();
        let events = sink.0.lock().unwrap().clone();
        let traffic = traffic.lock().unwrap().clone();
        LiveRun { wt, status, error, events, asked, traffic }
    }

    fn message_of(events: &[AgentEvent]) -> String {
        events.iter().filter(|e| e.kind == "message").filter_map(|e| e.data.as_ref()?["text"].as_str().map(String::from)).collect()
    }

    /// Phase 1 acceptance against the real Claude adapter (needs network and a logged-in `claude`):
    /// `TG_LIVE_ACP=1 cargo test live_claude -- --ignored --nocapture`.
    /// Set `TG_ACP_FIXTURE=<path>` to save the JSON-RPC traffic.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_claude_edit_permission_diff_accept_commit() {
        if std::env::var("TG_LIVE_ACP").is_err() { return; }
        let repo = Repo::new();
        repo.write("hello.txt", "Hello world\n");
        worktree::git(&repo.0, &["add", "."], None).unwrap();
        worktree::git(&repo.0, &["commit", "-m", "hello"], None).unwrap();
        let store = Store::open_in_memory().unwrap();
        let prompt = "Edit hello.txt so that its only line reads exactly `Hello ACP` (keep the trailing newline). Then run the shell command `echo checked > checked.txt` with your terminal tool, and finally tell me the exact contents of hello.txt. Do not commit.";
        let LiveRun { wt, status, error, events, asked, traffic } = run_live(&store, &repo.0, prompt, None).await;
        if let Ok(path) = std::env::var("TG_ACP_FIXTURE") {
            let text: String = traffic.iter().map(|v| format!("{v}\n")).collect();
            std::fs::write(path, text).unwrap();
        }
        let message = message_of(&events);
        eprintln!("status={status} error={error:?}\nmessage={message}\nkinds={:?}", events.iter().map(|e| e.kind).collect::<Vec<_>>());
        assert_eq!(status, "done", "{error:?}");
        assert!(events.iter().any(|e| e.kind == "tool"), "không có tool update");
        assert!(asked.iter().any(|t| t["kind"] == "execute"), "lệnh shell phải qua thẻ duyệt: {asked:?}");
        assert!(message.contains("Hello ACP"), "agent không báo lại output: {message}");
        assert!(asked.iter().any(|t| t["kind"] == "execute" && t["rawInput"]["command"].as_str().is_some_and(|c| c.contains("checked.txt"))), "thẻ duyệt lệnh phải có rawInput.command");
        let usage = events.iter().rev().find_map(|e| e.usage.clone()).expect("phải có usage");
        assert!(usage.output_tokens > 0 && usage.cost_usd.is_some(), "{usage:?}");
        // Nothing reaches the user's repo before review.
        assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello world\n");
        let pending = diff::pending(&wt).unwrap();
        assert!(pending.iter().any(|f| f.path == "hello.txt"), "diff phải có hello.txt: {pending:?}");
        assert!(pending.iter().any(|f| f.path == "checked.txt" && f.status == "A"), "diff phải có checked.txt: {pending:?}");
        for file in &pending { for hunk in &file.hunks { diff::accept_hunk(&repo.0, &wt, &file.path, &hunk.id).unwrap(); } }
        assert!(diff::pending(&wt).unwrap().is_empty());
        let hash = diff::commit(&repo.0, "Đổi lời chào").unwrap();
        assert!(!hash.is_empty());
        assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello ACP\n");
        assert_eq!(std::fs::read_to_string(repo.0.join("checked.txt")).unwrap().trim(), "checked");
        worktree::remove(&repo.0, &wt, true).unwrap();
    }

    /// Phase 2: two Claude runs on one prompt at once, in one group. Each works in its own
    /// worktree; "Use this" takes one whole, and the other no longer applies cleanly.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_claude_parallel_group_use_one() {
        if std::env::var("TG_LIVE_ACP").is_err() { return; }
        let repo = Repo::new();
        repo.write("hello.txt", "Hello world\n");
        worktree::git(&repo.0, &["add", "."], None).unwrap();
        worktree::git(&repo.0, &["commit", "-m", "hello"], None).unwrap();
        let store = Store::open_in_memory().unwrap();
        let prompt = |word: &str| format!("Edit hello.txt so that its only line reads exactly `Hello {word}` (keep the trailing newline). Do not run any other command and do not commit.");
        let (prompt_a, prompt_b) = (prompt("A"), prompt("B"));
        let (a, b) = tokio::join!(run_live(&store, &repo.0, &prompt_a, Some("group-live")), run_live(&store, &repo.0, &prompt_b, Some("group-live")));
        for run in [&a, &b] { assert_eq!(run.status, "done", "{:?} {}", run.error, message_of(&run.events)); }
        assert_ne!(a.wt.path, b.wt.path);
        assert_ne!(a.wt.branch, b.wt.branch);
        let runs = store.list_runs(10).unwrap();
        assert_eq!(runs.len(), 2);
        assert!(runs.iter().all(|r| r.group.as_deref() == Some("group-live")));
        assert_eq!(std::fs::read_to_string(a.wt.path.join("hello.txt")).unwrap(), "Hello A\n");
        assert_eq!(std::fs::read_to_string(b.wt.path.join("hello.txt")).unwrap(), "Hello B\n");
        assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello world\n");
        assert_eq!(diff::accept_all(&repo.0, &b.wt).unwrap(), 1);
        diff::commit(&repo.0, "Dùng bản B").unwrap();
        assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello B\n");
        // The losing run touched the same line, so it cannot be applied on top any more.
        assert!(diff::accept_all(&repo.0, &a.wt).is_err());
        assert!(worktree::git(&repo.0, &["status", "--porcelain"], None).unwrap().is_empty());
        for run in [a, b] { worktree::remove(&repo.0, &run.wt, true).unwrap(); }
        assert!(worktree::list(&repo.0).unwrap().is_empty());
    }

    #[tokio::test]
    async fn reused_worktree_survives_a_failed_spawn_and_is_shared() {
        let repo = Repo::new();
        let store = Store::open_in_memory().unwrap();
        let wt = repo.wt();
        store.insert_run_with_worktree(&NewRun { id: &wt.run_id, agent: AgentKind::Claude, prompt: "plan", cwd: wt.path.to_str().unwrap(), started_at: 1 }, repo.0.to_str().unwrap(), &wt, None).unwrap();
        let missing = repo.0.join("missing-adapter");
        assert!(prepare(&store, AgentKind::Codex, "build", &repo.0, (missing, vec![]), None, Some(wt.clone())).await.is_err());
        assert!(wt.path.exists(), "a failed later step must not delete the shared worktree");
        assert_eq!(store.list_runs(10).unwrap().len(), 1);
        let (_, mut child) = prepare(&store, AgentKind::Codex, "build", &repo.0, (PathBuf::from(if cfg!(windows) { "cmd" } else { "true" }), vec![]), None, Some(wt.clone())).await.unwrap();
        let _ = child.wait().await;
        let runs = store.list_runs(10).unwrap();
        assert_eq!(runs.len(), 2);
        assert!(runs.iter().all(|r| r.worktree.as_deref() == wt.path.to_str()));
        let later = runs.iter().find(|r| r.id != wt.run_id).unwrap();
        let (root, shared) = store.run_worktree(&later.id).unwrap();
        worktree::remove(&root, &shared, true).unwrap();
        store.clear_run_worktree(&later.id).unwrap();
        assert!(store.run_worktree(&wt.run_id).is_err());
    }

    #[tokio::test]
    async fn invalid_and_uncommitted_repos_never_create_runs() {
        let path = std::env::temp_dir().join(format!("tg-invalid-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let store = Store::open_in_memory().unwrap();
        let missing = path.join("missing");
        let error = prepare(&store, AgentKind::Codex, "task", &path, (missing.clone(), vec![]), None, None).await.err().unwrap();
        assert!(error.contains("Git"));
        worktree::git(&path, &["init"], None).unwrap();
        let error = prepare(&store, AgentKind::Codex, "task", &path, (missing, vec![]), None, None).await.err().unwrap();
        assert!(error.contains("commit"));
        assert!(store.list_runs(10).unwrap().is_empty());
        assert!(!path.join(".tg").exists());
        std::fs::remove_dir_all(path).unwrap();
    }
}
