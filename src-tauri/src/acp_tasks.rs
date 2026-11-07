//! Tauri boundary and process lifetime for ACP tasks. Session routing stays UI-independent.

use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio, sync::{Arc, Mutex}, time::Duration};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::{io::{AsyncBufReadExt, BufReader}, process::Child, sync::oneshot};
use crate::{acp::client::AcpClient, acp_runner::{Approval, TaskSession, EventSink, RuleMemory}, adapters::{AgentKind, setup_timeout}, diff::{self, FileDiff}, env, bridge::{self, BridgeHub, ToolEnv}, mcp::{self, McpServer}, options::{self, SessionPrefs}, runner::{self, AgentEvent, Runs}, store::{NewRun, Store}, workspace, worktree::{self, Worktree}};

#[derive(Default)]
pub struct TaskRuns(Mutex<HashMap<String, Arc<TaskSession>>>);

impl TaskRuns {
    /// The agent is working on a turn, not just waiting for the next message.
    fn busy(&self, run_id: &str) -> Result<bool, String> {
        Ok(self.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.get(run_id).is_some_and(|s| s.is_busy()))
    }
}

/// Where the next message of each open session goes.
#[derive(Default)]
pub struct SessionInboxes(Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<String>>>);

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

/// What tg-bridge tools can reach for one task run.
struct TaskEnv {
    app: AppHandle,
    run_id: String,
    agent: AgentKind,
    /// Notes are shared by the runs of one task: a parallel group or a pipeline's worktree.
    scope: String,
    prompt: String,
    group: Option<String>,
    wt: Worktree,
    sink: Arc<dyn EventSink>,
    session: Arc<TaskSession>,
}

impl ToolEnv for TaskEnv {
    fn emit(&self, data: serde_json::Value, line: String) {
        let mut event = AgentEvent::new(&self.run_id, self.agent, "bridge");
        event.data = Some(data);
        event.line = Some(line);
        self.sink.emit(event);
    }
    fn add_note(&self, topic: &str, text: &str) -> Result<(), String> {
        self.app.state::<Store>().add_note(&self.scope, topic, text, &self.run_id, self.agent, runner::now_ms()).map_err(|e| format!("Không lưu được ghi chú: {e}"))
    }
    fn notes(&self, topic: Option<&str>) -> Result<Vec<(String, String, u64, String)>, String> {
        self.app.state::<Store>().notes(&self.scope, topic).map_err(|e| format!("Không đọc được ghi chú: {e}"))
    }
    fn approve(&self, action: String, reason: String) -> bridge::BoxFuture<bool> {
        self.session.ask(action, reason)
    }
    fn context(&self) -> serde_json::Value {
        let changed: Vec<String> = diff::pending(&self.wt).map(|files| files.into_iter().map(|f| format!("{} {}", f.status, f.path)).collect()).unwrap_or_default();
        json!({
            "task": self.prompt, "agent": self.agent, "runId": self.run_id, "worktree": self.wt.path,
            "parallelGroup": self.group, "sharedWithPipelineStepsOf": (self.wt.run_id != self.run_id).then_some(&self.wt.run_id),
            "changedFiles": changed,
            "rules": "Chỉ sửa tệp trong worktree. Không push hay merge. Chuyển việc và việc ngoài phạm vi phải qua người dùng (handoff_to, request_approval).",
        })
    }
}

/// tg-bridge is on unless the user turned it off in Integrations.
pub(crate) fn bridge_enabled(store: &Store) -> bool {
    store.setting("bridge").ok().flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v["enabled"].as_bool()).unwrap_or(true)
}

// Validate and spawn before inserting anything. A failed spawn leaves no run or worktree.
/// `reuse`: run in an existing worktree (a later pipeline step); it is never removed here.
/// Where a new task works: the user's folder, or a draft (worktree) from a branch (`None`: HEAD).
#[derive(Debug, Clone, PartialEq)]
pub enum Place { Direct, Draft(Option<String>) }

/// The ACP adapter process, with piped stdio, started in `dir`.
pub(crate) fn spawn_adapter(command: &(PathBuf, Vec<String>), dir: &Path) -> Result<Child, String> {
    let mut process = env::command(&command.0);
    process.args(&command.1).current_dir(dir)
        .env("PATH", env::login_path()).stdin(Stdio::piped()).stdout(Stdio::piped())
        .stderr(Stdio::piped()).kill_on_drop(true);
    env::isolate(&mut process);
    process.spawn().map_err(|e| format!("Không chạy được adapter {}: {e}", command.0.display()))
}

/// The tg-bridge MCP server entry of one session.
pub(crate) fn bridge_server(agent: AgentKind, exe: String, addr: String, token: String) -> McpServer {
    McpServer {
        id: bridge::SERVER_NAME.into(), name: bridge::SERVER_NAME.into(), transport: "stdio".into(),
        command: Some(exe), args: vec![bridge::FLAG.into()],
        env: vec![mcp::NameValue { name: "TG_BRIDGE_ADDR".into(), value: addr }, mcp::NameValue { name: "TG_BRIDGE_TOKEN".into(), value: token }],
        url: None, headers: vec![], agents: vec![agent],
    }
}

/// How a task gets its adapter: start one, or take a session opened ahead of time.
/// `Warm` keeps the command: an adapter that died while waiting is replaced by a fresh one.
enum Adapter { Spawn((PathBuf, Vec<String>)), Warm(Box<crate::warm::Warm>, (PathBuf, Vec<String>)) }

async fn prepare(store: &Store, agent: AgentKind, prompt: &str, repo: &Path, adapter: Adapter, group: Option<&str>, reuse: Option<Worktree>, place: Place) -> Result<(String, Worktree, Child, Option<crate::warm::Claimed>), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let agent_name = serde_json::to_value(agent).unwrap();
    let shared = reuse.is_some();
    let made = (|| match (reuse, place) {
        (Some(wt), _) => Ok(wt),
        (None, Place::Direct) => worktree::direct(repo, &id),
        (None, Place::Draft(base)) => {
            if let Some(b) = &base {
                if !worktree::branches(repo)?.iter().any(|x| x == b) { return Err(format!("Không tìm thấy nhánh {b}.")); }
            }
            worktree::create_at(repo, agent_name.as_str().unwrap(), prompt, &id, base.as_deref())
        }
    })();
    let wt = match made {
        Ok(wt) => wt,
        Err(e) => {
            if let Adapter::Warm(warm, _) = adapter { warm.close_later(); }
            return Err(e);
        }
    };
    let cleanup = |wt: &Worktree| if shared { Ok(()) } else { worktree::remove(repo, wt, true) };
    let adapter = match adapter {
        Adapter::Warm(warm, command) => {
            let (mut child, claimed) = warm.into_parts();
            if !claimed.late.is_closed() && matches!(child.try_wait(), Ok(None)) {
                Ok((child, claimed))
            } else {
                // It died while the run was being prepared: this run opens its own.
                terminate_adapter(&mut child, claimed.pid).await;
                claimed.release();
                Err(command)
            }
        }
        Adapter::Spawn(command) => Err(command),
    };
    let (mut child, warm) = match adapter {
        Ok((child, claimed)) => (child, Some(claimed)),
        Err(command) => match spawn_adapter(&command, &wt.path) {
            Ok(child) => (child, None),
            Err(e) => {
                let cleanup = cleanup(&wt);
                return Err(format!("{e}{}", cleanup.err().map(|e| format!("; {e}")).unwrap_or_default()));
            }
        },
    };
    let saved = store.insert_run_with_worktree(&NewRun { id: &id, agent, prompt, cwd: &wt.path.to_string_lossy(), started_at: runner::now_ms() }, &repo.to_string_lossy(), &wt, group);
    if let Err(e) = saved {
        let pid = warm.as_ref().and_then(|w| w.pid).or(child.id());
        terminate_adapter(&mut child, pid).await;
        if let Some(warm) = warm { warm.release(); }
        let cleanup = cleanup(&wt);
        return Err(format!("Không lưu được lượt chạy: {e}{}", cleanup.err().map(|e| format!("; {e}")).unwrap_or_default()));
    }
    Ok((id, wt, child, warm))
}

// npx is a wrapper: its adapter descendants must stop along with the run.
pub(crate) async fn terminate_adapter(child: &mut Child, pid: Option<u32>) {
    if let Some(pid) = pid { env::kill_tree(pid).await; }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn turn_outcome(result: &Value) -> (&'static str, Option<String>) {
    match result["stopReason"].as_str() {
        Some("cancelled") => ("stopped", None),
        Some("max_tokens") => ("failed", Some("Agent dừng vì đã hết giới hạn độ dài trả lời.".into())),
        Some("max_turn_requests") => ("failed", Some("Agent dừng vì đã đạt giới hạn số bước trong một lượt.".into())),
        Some("refusal") => ("failed", Some("Agent từ chối thực hiện yêu cầu này.".into())),
        _ => ("done", None),
    }
}

/// How one agent session runs: its first prompt, and more if it stays open.
struct SessionPlan<'a> {
    cwd: &'a Path,
    prompt: String,
    /// Sent before the first prompt unless `resume` reopens the session.
    recap: Option<String>,
    servers: &'a [McpServer],
    resume: Option<String>,
    /// A session already opened ahead of time (`warm.rs`): no initialize or session/new.
    opened: Option<String>,
    /// `None`: the session ends after one turn (a pipeline step).
    next: Option<tokio::sync::mpsc::UnboundedReceiver<String>>,
    idle_limit: Duration,
    /// Model and effort picked in the composer, applied once the session is open.
    prefs: SessionPrefs,
}

const IDLE_LIMIT: Duration = Duration::from_secs(30 * 60);

struct TurnEnd { status: &'static str, error: Option<String>, alive: bool }

async fn run_turn(client: &AcpClient, session: &TaskSession, id: &str, prompt: &str, stop: &mut oneshot::Receiver<()>, dead: &mut std::pin::Pin<&mut impl std::future::Future<Output = ()>>) -> TurnEnd {
    let turn = client.prompt_turn(id, prompt);
    tokio::pin!(turn);
    tokio::select! {
        biased;
        _ = &mut *stop => {
            session.cancel_pending();
            let _ = client.cancel(id);
            let answered = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::select! { result = &mut turn => Some(result), _ = dead.as_mut() => None }
            }).await;
            match answered {
                Ok(Some(Ok(result))) => { session.turn_finished(&result); TurnEnd { status: "stopped", error: None, alive: true } }
                _ => TurnEnd { status: "stopped", error: None, alive: false },
            }
        }
        result = &mut turn => match result {
            Ok(result) => {
                session.turn_finished(&result);
                let (status, error) = turn_outcome(&result);
                TurnEnd { status, error, alive: true }
            }
            Err(e) => TurnEnd { status: "failed", error: Some(format!("Phiên ACP thất bại: {e}")), alive: true },
        },
        _ = dead.as_mut() => TurnEnd { status: "failed", error: Some("Adapter đã dừng trước khi hoàn tất yêu cầu.".into()), alive: false },
    }
}

/// One agent session from setup to the end. `next_stop` arms the stop signal for each
/// phase, since a stop during a turn only ends that turn. `on_opened` gets the session id,
/// `on_turn` each finished turn of a session that stays open.
async fn drive_session(client: &AcpClient, session: &TaskSession, mut plan: SessionPlan<'_>, mut next_stop: impl FnMut() -> oneshot::Receiver<()>, mut on_opened: impl FnMut(&str), mut on_turn: impl FnMut(&TurnEnd), dead: impl std::future::Future<Output = ()>) -> (&'static str, Option<String>) {
    tokio::pin!(dead);
    let mut stop = next_stop();
    session.set_busy(true);
    let opened = plan.opened.take();
    let setup = async {
        if let Some(id) = opened { return Ok::<_, String>((id, false)); }
        let init = client.initialize().await?;
        let (mcp, skipped) = mcp::for_acp(plan.servers, session.agent(), &init);
        if !skipped.is_empty() {
            session.note(format!("Bỏ qua MCP server {} vì agent không báo hỗ trợ kết nối http.", skipped.join(", ")));
        }
        if let Some(previous) = plan.resume.as_deref().filter(|_| init["agentCapabilities"]["loadSession"] == true) {
            session.set_muted(true);
            let loaded = client.load_session(previous, plan.cwd, mcp.clone()).await;
            session.set_muted(false);
            match loaded {
                Ok(()) => return Ok::<_, String>((previous.to_string(), true)),
                Err(e) => session.note(format!("{e} Mở phiên mới và gửi kèm tóm tắt.")),
            }
        }
        client.new_session(plan.cwd, mcp).await.map(|id| (id, false))
    };
    let (session_id, loaded) = tokio::select! {
        biased;
        _ = &mut stop => { session.finish().await; return ("stopped", None); }
        _ = dead.as_mut() => { session.finish().await; return ("failed", Some("Adapter đã dừng khi đang khởi tạo.".into())); }
        result = setup => match result {
            Ok(opened) => opened,
            Err(e) => { session.finish().await; return ("failed", Some(e)); }
        }
    };
    on_opened(&session_id);
    if !plan.prefs.is_empty() {
        for note in options::apply(client, &session_id, &plan.prefs).await { session.note(note); }
    }
    let mut prompt = match plan.recap.take().filter(|_| !loaded) {
        Some(recap) => format!("{recap}\n\n{}", plan.prompt),
        None => std::mem::take(&mut plan.prompt),
    };
    loop {
        let end = run_turn(client, session, &session_id, &prompt, &mut stop, &mut dead).await;
        session.set_busy(false);
        let Some(next) = plan.next.as_mut().filter(|_| end.alive) else {
            session.finish().await;
            return (end.status, end.error);
        };
        on_turn(&end);
        stop = next_stop();
        // The session has finished its work, so closing it now is a normal end.
        let closed = if end.status == "failed" { "failed" } else { "done" };
        prompt = tokio::select! {
            biased;
            _ = &mut stop => { session.finish().await; return (closed, None); }
            _ = dead.as_mut() => { session.finish().await; return (closed, None); }
            message = next.recv() => match message {
                Some(message) => message,
                None => { session.finish().await; return (closed, None); }
            },
            _ = tokio::time::sleep(plan.idle_limit) => { session.finish().await; return (closed, None); }
        };
        stop = next_stop();
    }
}

// No AppHandle or real adapter required to exercise cancellation and failure status.
#[cfg(test)]
async fn drive(client: &AcpClient, session: &TaskSession, cwd: &Path, prompt: &str, servers: &[McpServer], stop: oneshot::Receiver<()>, dead: impl std::future::Future<Output = ()>) -> (&'static str, Option<String>) {
    let mut stop = Some(stop);
    let plan = SessionPlan { cwd, prompt: prompt.into(), recap: None, servers, resume: None, opened: None, next: None, idle_limit: IDLE_LIMIT, prefs: SessionPrefs::default() };
    drive_session(client, session, plan, || stop.take().expect("một lượt chỉ có một tín hiệu dừng"), |_| {}, |_| {}, dead).await
}

#[tauri::command]
pub async fn start_task(app: AppHandle, agent: AgentKind, prompt: String, repo: String, group: Option<String>, reuse: Option<String>, single_turn: Option<bool>, recap: Option<String>, thread: Option<String>, scope: Option<String>, prefs: Option<SessionPrefs>, place: Option<String>, base: Option<String>, approval: Option<Approval>) -> Result<String, String> {
    let approval = approval.unwrap_or_default();
    // A question to an agent without a read-only CLI flag runs in a throwaway draft.
    let place = match (approval, place.as_deref()) {
        (Approval::Deny, _) => Place::Draft(None),
        (_, Some("draft")) => Place::Draft(base.filter(|b| !b.is_empty())),
        (_, Some("direct")) => Place::Direct,
        (_, None) => Place::Draft(None),
        (_, Some(other)) => return Err(format!("Nơi làm việc không hợp lệ: {other}")),
    };
    if group.as_deref().is_some_and(|g| g.is_empty() || g.len() > 64 || !g.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) {
        return Err("Mã nhóm lượt chạy không hợp lệ.".into());
    }
    // Normalize the repository identity, including callers selecting a subdirectory.
    let root = worktree::git(Path::new(&repo), &["rev-parse", "--show-toplevel"], None)
        .map_err(|e| format!("Thư mục không phải kho Git. {e}"))?;
    let repo = dunce::canonicalize(root.trim()).map_err(|e| format!("Không mở được kho Git: {e}"))?;
    let command = agent.acp_command(env::which).ok_or_else(|| format!("Không tìm thấy adapter cho {} hoặc npx trong PATH.", agent.display_name()))?;
    let previous_run = reuse.clone();
    // A later pipeline step continues in the worktree of a finished earlier step.
    let reuse = match reuse {
        None => None,
        Some(previous) => {
            if app.state::<TaskRuns>().busy(&previous)? {
                return Err("Bước trước vẫn đang chạy.".into());
            }
            let (stored, wt) = app.state::<Store>().run_worktree(&previous).map_err(|e| format!("Không tìm thấy worktree của bước trước: {e}"))?;
            if stored != repo { return Err("Bước trước thuộc repo khác.".into()); }
            Some(wt)
        }
    };
    let timeout = setup_timeout(&command.0);
    // Back to the same agent: reopen its session instead of starting over.
    let resumed = match previous_run.as_deref() {
        Some(previous) => {
            let (owner, session, cost) = app.state::<Store>().session_of(previous).map_err(|e| format!("Không đọc được phiên cũ: {e}"))?;
            let same = serde_json::to_value(agent).ok().and_then(|v| v.as_str().map(|s| s == owner)).unwrap_or(false);
            session.filter(|_| same).map(|s| (s, cost.unwrap_or(0.0)))
        }
        None => None,
    };
    let throwaway = approval == Approval::Deny && reuse.is_none();
    // A new conversation in the user's folder may find its session already open.
    let adapter = match (&place, &reuse, &resumed, env::scoped_dir(&repo, scope.as_deref())) {
        (Place::Direct, None, None, Ok(cwd)) => {
            let key = crate::warm::key_for(&app.state::<Store>(), agent, &cwd);
            match app.state::<crate::warm::WarmPool>().take(&key).await {
                Some(warm) => Adapter::Warm(Box::new(warm), command),
                None => Adapter::Spawn(command),
            }
        }
        _ => Adapter::Spawn(command),
    };
    let (id, wt, mut child, warm) = prepare(&app.state::<Store>(), agent, &prompt, &repo, adapter, group.as_deref(), reuse, place).await?;
    let pid = warm.as_ref().and_then(|w| w.pid).or(child.id());
    if let Some(thread) = &thread {
        if let Err(e) = app.state::<Store>().set_run_thread(&id, thread, scope.as_deref()) { eprintln!("Không lưu được cuộc trò chuyện: {e}"); }
    }
    let start_dir = match env::scoped_dir(&wt.path, scope.as_deref()) {
        Ok(dir) => dir,
        Err(e) => {
            terminate_adapter(&mut child, pid).await;
            if let Some(warm) = warm { warm.release(); }
            let _ = app.state::<Store>().finish_run(&id, "failed", None, runner::now_ms());
            return Err(e);
        }
    };
    let sink = Arc::new(AppSink(app.clone()));
    let rules = Arc::new(RepoRules { app: app.clone(), repo: repo.to_string_lossy().into_owned(), agent });
    let session = match TaskSession::new(&id, agent, &wt.path, sink.clone(), rules) {
        Ok(session) => { session.set_approval(approval); Arc::new(session) }
        Err(e) => {
            terminate_adapter(&mut child, pid).await;
            if let Some(warm) = warm { warm.release(); }
            let _ = app.state::<Store>().finish_run(&id, "failed", None, runner::now_ms());
            return Err(e);
        }
    };
    let sink_dyn: Arc<dyn EventSink> = sink.clone();
    let (client, stderr, opened) = match warm {
        Some(warm) => {
            if let Err(e) = warm.late.attach(session.clone()) { eprintln!("Không gắn được phiên mở sẵn: {e}"); }
            warm.relay_to(sink_dyn.clone(), &id, agent);
            (warm.client, Err(warm.stderr_task), Some((warm.session_id, warm.token, warm.notes)))
        }
        None => {
            let stdout = child.stdout.take().expect("piped stdout");
            let stdin = child.stdin.take().expect("piped stdin");
            (AcpClient::start_with_timeout(stdout, stdin, session.clone(), timeout), Ok(child.stderr.take().expect("piped stderr")), None)
        }
    };
    app.state::<TaskRuns>().0.lock().unwrap().insert(id.clone(), session.clone());
    let next = if single_turn.unwrap_or(false) { None } else {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        app.state::<SessionInboxes>().0.lock().unwrap().insert(id.clone(), tx);
        Some(rx)
    };
    let mut started = AgentEvent::new(&id, agent, "started");
    started.line = Some(format!("{} · {}", agent.display_name(), wt.path.display()));
    sink.emit(started);
    if opened.is_none() && timeout == Duration::from_secs(300) {
        session.note("Đang chuẩn bị adapter. Lần đầu có thể mất vài phút để tải.".into());
    }
    let stderr_sink = sink.clone();
    let stderr_id = id.clone();
    let stderr_task = match stderr {
        Err(relay) => relay,
        Ok(stderr) => tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut event = AgentEvent::new(&stderr_id, agent, "stderr");
                event.line = Some(line);
                stderr_sink.emit(event);
            }
        }),
    };
    let task_id = id.clone();
    let (cleanup_repo, cleanup_wt) = (repo.clone(), wt.clone());
    let scope = group.clone().unwrap_or_else(|| wt.run_id.clone());
    let env = TaskEnv { app: app.clone(), run_id: id.clone(), agent, scope, prompt: prompt.clone(), group: group.clone(), wt: wt.clone(), sink: sink.clone(), session: session.clone() };
    tauri::async_runtime::spawn(async move {
        let mut servers: Vec<McpServer> = crate::warm::user_servers(&app.state::<Store>());
        let hub = app.state::<Arc<BridgeHub>>().inner().clone();
        let mut token = None;
        let mut opened_id = None;
        if let Some((session_id, reserved, notes)) = opened {
            for note in notes { session.note(note); }
            if let Some(t) = reserved {
                if let Err(e) = hub.bind(&t, Arc::new(env)) { session.note(format!("tg-bridge không bật được: {e}")); }
                token = Some(t);
            }
            opened_id = Some(session_id);
        } else if bridge_enabled(&app.state::<Store>()) {
            match (hub.address().await, bridge::executable()) {
                (Ok(addr), Some(exe)) => {
                    let t = hub.register(Arc::new(env));
                    servers.push(bridge_server(agent, exe, addr, t.clone()));
                    token = Some(t);
                }
                (Err(e), _) => session.note(format!("tg-bridge không bật được: {e}")),
                (_, None) => session.note("tg-bridge không bật được: không xác định được đường dẫn của app.".into()),
            }
        }
        let (resume, base) = resumed.map_or((None, 0.0), |(s, c)| (Some(s), c));
        session.set_cost_base(base);
        let plan = SessionPlan { cwd: &start_dir, prompt: prompt.clone(), recap, servers: &servers, resume, opened: opened_id, next, idle_limit: IDLE_LIMIT, prefs: prefs.unwrap_or_default() };
        let next_stop = || {
            let (tx, rx) = oneshot::channel();
            if let Ok(mut runs) = app.state::<Runs>().0.lock() { runs.insert(task_id.clone(), tx); }
            rx
        };
        let on_opened = |sid: &str| {
            if let Err(e) = app.state::<Store>().set_acp_session(&task_id, sid) { eprintln!("Không lưu được phiên ACP: {e}"); }
        };
        let on_turn = |end: &TurnEnd| {
            if let Some(error) = &end.error {
                let mut event = AgentEvent::new(&task_id, agent, "stderr");
                event.line = Some(error.clone());
                sink.emit(event);
            }
            if let Err(e) = app.state::<Store>().set_run_status(&task_id, "idle") { eprintln!("Không lưu được trạng thái: {e}"); }
            let mut event = AgentEvent::new(&task_id, agent, "turn_end");
            event.data = Some(json!({"status": end.status}));
            sink.emit(event);
        };
        let (status, error) = drive_session(&client, &session, plan, next_stop, on_opened, on_turn, async { let _ = child.wait().await; }).await;
        app.state::<SessionInboxes>().0.lock().unwrap().remove(&task_id);
        client.close();
        if let Some(t) = token { hub.unregister(&t); }
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
        if throwaway {
            // Nothing of a question is kept: its draft goes away with the session.
            if let Err(e) = worktree::remove(&cleanup_repo, &cleanup_wt, true) { eprintln!("Không dọn được bản nháp tạm: {e}"); }
        }
        let mut event = AgentEvent::new(&task_id, agent, "exit");
        event.code = code;
        event.data = Some(json!({"status":status}));
        sink.emit(event);
    });
    Ok(id)
}

/// Changes how an open session answers permission requests (Hỏi trước, Tự động, Chỉ hỏi).
#[tauri::command(async)]
pub fn set_approval(tasks: State<'_, TaskRuns>, run_id: String, approval: Approval) -> Result<(), String> {
    let session = tasks.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.get(&run_id).cloned();
    session.ok_or("Phiên này đã đóng.")?.set_approval(approval);
    Ok(())
}

/// Branches a draft can start from.
#[tauri::command(async)]
pub fn list_branches(repo: String) -> Result<Vec<String>, String> {
    worktree::branches(Path::new(&repo))
}

#[tauri::command(async)]
pub fn send_message(app: AppHandle, tasks: State<'_, TaskRuns>, inboxes: State<'_, SessionInboxes>, store: State<'_, Store>, run_id: String, prompt: String) -> Result<(), String> {
    if prompt.trim().is_empty() { return Err("Hãy nhập nội dung tin nhắn.".into()); }
    if let Some(sent) = runner::send_headless(&app, &run_id, &prompt) { return sent; }
    let inbox = inboxes.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.get(&run_id).cloned();
    let session = tasks.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.get(&run_id).cloned();
    let (Some(inbox), Some(session)) = (inbox, session) else { return Err("Phiên này đã đóng.".into()); };
    if !session.claim_turn() { return Err("Agent đang chạy. Hãy chờ hoặc dừng trước.".into()); }
    if let Err(e) = store.set_run_status(&run_id, "running") { eprintln!("Không lưu được trạng thái: {e}"); }
    let mut event = AgentEvent::new(&run_id, session.agent(), "user");
    event.line = Some(prompt.clone());
    AppSink(app).emit(event);
    inbox.send(prompt).map_err(|_| {
        session.set_busy(false);
        "Phiên này đã đóng.".to_string()
    })
}

#[tauri::command(async)]
pub fn respond_permission(tasks: State<'_, TaskRuns>, run_id: String, request_id: String, option_id: String, always: bool) -> Result<(), String> {
    let session = tasks.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.get(&run_id).cloned().ok_or("Lượt chạy này đã kết thúc.")?;
    session.respond_permission(&request_id, &option_id, always)
}
fn stored_worktree(store: &Store, id: &str) -> Result<(PathBuf, Worktree), String> {
    store.run_worktree(id).map_err(|e| format!("Không tìm thấy bản nháp của lượt chạy: {e}"))
}
#[tauri::command(async)]
pub fn get_diff(store: State<'_, Store>, run_id: String) -> Result<Vec<FileDiff>, String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    diff::pending(&wt)
}
#[tauri::command(async)]
pub fn accept_hunk(store: State<'_, Store>, run_id: String, path: String, hunk_id: String) -> Result<(), String> {
    let (repo, wt) = stored_worktree(&store, &run_id)?;
    diff::accept_hunk(&repo, &wt, &path, &hunk_id)
}
#[tauri::command(async)]
pub fn accept_all(store: State<'_, Store>, tasks: State<'_, TaskRuns>, run_id: String) -> Result<usize, String> {
    if tasks.busy(&run_id)? {
        return Err("Agent vẫn đang chạy. Hãy chờ agent xong rồi mới dùng bản này.".into());
    }
    let (repo, wt) = stored_worktree(&store, &run_id)?;
    diff::accept_all(&repo, &wt)
}
#[tauri::command(async)]
pub fn reject_hunk(store: State<'_, Store>, run_id: String, path: String, hunk_id: String) -> Result<(), String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    diff::reject_hunk(&wt, &path, &hunk_id)
}
#[tauri::command(async)]
pub fn staged_files(store: State<'_, Store>, run_id: String) -> Result<Vec<String>, String> {
    let (repo, _) = stored_worktree(&store, &run_id)?;
    diff::staged(&repo)
}
#[tauri::command(async)]
pub fn commit_accepted(store: State<'_, Store>, run_id: String, message: String) -> Result<String, String> {
    let (repo, _) = stored_worktree(&store, &run_id)?;
    diff::commit(&repo, &message)
}
#[tauri::command(async)]
pub fn list_worktree_files(store: State<'_, Store>, run_id: String) -> Result<Vec<String>, String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    workspace::list_files(&wt)
}
#[tauri::command(async)]
pub fn read_worktree_file(store: State<'_, Store>, run_id: String, path: String) -> Result<String, String> {
    let (_, wt) = stored_worktree(&store, &run_id)?;
    workspace::read_file(&wt, &path)
}
#[tauri::command(async)]
pub fn write_worktree_file(store: State<'_, Store>, tasks: State<'_, TaskRuns>, run_id: String, path: String, content: String) -> Result<(), String> {
    // The agent may be writing the same file; edits wait until it is done.
    if tasks.busy(&run_id)? {
        return Err("Agent đang chạy. Hãy chờ agent xong rồi mới sửa tệp.".into());
    }
    let (_, wt) = stored_worktree(&store, &run_id)?;
    workspace::write_file(&wt, &path, &content)
}
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

async fn delete_runs_inner(store: &Store, tasks: &TaskRuns, runs: &Runs, run_ids: &[String]) -> Result<(), String> {
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
        if !seen.insert(wt.path.clone()) { continue; }
        let sharing = store.runs_sharing_worktree(id).map_err(|e| format!("Không đọc được lịch sử: {e}"))?;
        if sharing.iter().any(|other| !run_ids.contains(other)) { continue; }
        if let Err(e) = worktree::remove(&repo, &wt, true) { errors.push(e); }
    }
    store.delete_runs(run_ids, runner::now_ms()).map_err(|e| format!("Không xoá được cuộc trò chuyện: {e}"))?;
    if errors.is_empty() { Ok(()) }
    else { Err(format!("Đã xoá cuộc trò chuyện, nhưng chưa dọn được bản nháp: {}", errors.join("; "))) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::tests::Repo;

    fn save_draft(store: &Store, repo: &Repo, wt: &Worktree, id: &str) {
        store.insert_run_with_worktree(&NewRun { id, agent: AgentKind::Codex, prompt: "p", cwd: wt.path.to_str().unwrap(), started_at: 1 }, repo.0.to_str().unwrap(), wt, None).unwrap();
    }

    #[tokio::test]
    async fn delete_draft_removes_branch_without_changing_repo() {
        let repo = Repo::new();
        let wt = repo.wt();
        let store = Store::open_in_memory().unwrap();
        save_draft(&store, &repo, &wt, &wt.run_id);
        let original = std::fs::read(repo.0.join("file.txt")).unwrap();
        let head = worktree::git(&repo.0, &["rev-parse", "HEAD"], None).unwrap();
        std::fs::write(wt.path.join("file.txt"), "draft").unwrap();
        delete_runs_inner(&store, &TaskRuns::default(), &Runs::default(), &[wt.run_id.clone(), wt.run_id.clone()]).await.unwrap();
        assert!(!wt.path.exists());
        assert!(worktree::git(&repo.0, &["show-ref", "--verify", &format!("refs/heads/{}", wt.branch)], None).is_err());
        assert_eq!(std::fs::read(repo.0.join("file.txt")).unwrap(), original);
        assert_eq!(worktree::git(&repo.0, &["rev-parse", "HEAD"], None).unwrap(), head);
        assert!(store.list_runs(10).unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_direct_keeps_user_files_and_stops_read_only_session() {
        let repo = Repo::new();
        let wt = worktree::direct(&repo.0, "direct").unwrap();
        let store = Store::open_in_memory().unwrap();
        save_draft(&store, &repo, &wt, &wt.run_id);
        repo.write("file.txt", "user changes");
        repo.write("untracked.txt", "keep");
        let runs = Runs::default();
        let (tx, rx) = oneshot::channel();
        runs.0.lock().unwrap().insert(wt.run_id.clone(), tx);
        delete_runs_inner(&store, &TaskRuns::default(), &runs, &[wt.run_id.clone()]).await.unwrap();
        rx.await.unwrap();
        assert_eq!(std::fs::read_to_string(repo.0.join("file.txt")).unwrap(), "user changes");
        assert_eq!(std::fs::read_to_string(repo.0.join("untracked.txt")).unwrap(), "keep");
        for path in [worktree::direct_files(&wt).unwrap().0, worktree::direct_files(&wt).unwrap().1] { assert!(!path.exists()); }
    }

    #[tokio::test]
    async fn delete_busy_batch_changes_nothing() {
        let repo = Repo::new();
        let wt = repo.wt();
        let store = Store::open_in_memory().unwrap();
        save_draft(&store, &repo, &wt, &wt.run_id);
        save_draft(&store, &repo, &wt, "busy");
        let tasks = TaskRuns::default();
        let session = Arc::new(TaskSession::new("busy", AgentKind::Codex, &wt.path, Arc::new(Recorder::default()), Arc::new(Rules)).unwrap());
        session.set_busy(true);
        tasks.0.lock().unwrap().insert("busy".into(), session);
        let runs = Runs::default();
        let (tx, mut rx) = oneshot::channel();
        runs.0.lock().unwrap().insert(wt.run_id.clone(), tx);
        let before = store.list_runs(10).unwrap();
        assert_eq!(delete_runs_inner(&store, &tasks, &runs, &[wt.run_id.clone(), "busy".into()]).await.unwrap_err(), "Hãy dừng agent trước khi xoá cuộc trò chuyện.");
        assert_eq!(store.list_runs(10).unwrap(), before);
        assert!(wt.path.exists());
        assert_eq!(rx.try_recv(), Err(oneshot::error::TryRecvError::Empty));
    }

    #[tokio::test]
    async fn delete_waits_for_idle_acp_session_to_close() {
        let repo = Repo::new();
        let wt = repo.wt();
        let store = Store::open_in_memory().unwrap();
        save_draft(&store, &repo, &wt, &wt.run_id);
        let tasks = TaskRuns::default();
        let session = Arc::new(TaskSession::new(&wt.run_id, AgentKind::Codex, &wt.path, Arc::new(Recorder::default()), Arc::new(Rules)).unwrap());
        session.set_busy(false);
        tasks.0.lock().unwrap().insert(wt.run_id.clone(), session);
        let runs = Runs::default();
        let (tx, rx) = oneshot::channel();
        runs.0.lock().unwrap().insert(wt.run_id.clone(), tx);
        let ids = [wt.run_id.clone()];
        let close = async {
            rx.await.unwrap();
            assert!(wt.path.exists());
            assert_eq!(store.list_runs(10).unwrap().len(), 1);
            tasks.0.lock().unwrap().remove(&wt.run_id);
        };
        let (result, ()) = tokio::join!(delete_runs_inner(&store, &tasks, &runs, &ids), close);
        result.unwrap();
        assert!(!wt.path.exists());
    }

    #[tokio::test]
    async fn delete_shared_draft_waits_until_last_run_is_deleted() {
        let repo = Repo::new();
        let wt = repo.wt();
        let store = Store::open_in_memory().unwrap();
        save_draft(&store, &repo, &wt, &wt.run_id);
        save_draft(&store, &repo, &wt, "other");
        delete_runs_inner(&store, &TaskRuns::default(), &Runs::default(), &[wt.run_id.clone()]).await.unwrap();
        assert!(wt.path.exists());
        assert_eq!(store.list_runs(10).unwrap()[0].id, "other");
        delete_runs_inner(&store, &TaskRuns::default(), &Runs::default(), &["other".into()]).await.unwrap();
        assert!(!wt.path.exists());
    }

    #[tokio::test]
    async fn delete_cleanup_failure_still_hides_history() {
        let repo = Repo::new();
        let mut wt = repo.wt();
        wt.base = "invalid".into();
        let store = Store::open_in_memory().unwrap();
        save_draft(&store, &repo, &wt, &wt.run_id);
        let error = delete_runs_inner(&store, &TaskRuns::default(), &Runs::default(), &[wt.run_id.clone()]).await.unwrap_err();
        assert!(error.starts_with("Đã xoá cuộc trò chuyện, nhưng chưa dọn được bản nháp: "));
        assert!(store.list_runs(10).unwrap().is_empty());
        assert!(store.run_worktree(&wt.run_id).is_err());
    }

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
    /// Runs a session, feeding `messages` one per finished turn, then closes it.
    async fn session_with(client: &AcpClient, session: &TaskSession, resume: Option<String>, recap: Option<String>, messages: Vec<&'static str>, stop_each_turn: bool) -> (&'static str, Vec<&'static str>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let cwd = std::env::temp_dir();
        let plan = SessionPlan { cwd: &cwd, prompt: "đầu".into(), recap, servers: &[], resume, opened: None, next: Some(rx), idle_limit: Duration::from_millis(100), prefs: SessionPrefs::default() };
        let stops = Mutex::new(Vec::new());
        let turns = Mutex::new(Vec::new());
        let remaining = Mutex::new(messages.into_iter());
        let next_stop = || {
            let (stop, rx) = oneshot::channel();
            let mut all = stops.lock().unwrap();
            if stop_each_turn && !all.is_empty() { let _ = stop.send(()); } else { all.push(stop); }
            rx
        };
        let on_turn = |end: &TurnEnd| {
            turns.lock().unwrap().push(end.status);
            // With nothing left to send, the session ends through its idle limit.
            if let Some(message) = remaining.lock().unwrap().next() { tx.send(message.to_string()).unwrap(); }
        };
        let (status, _) = tokio::time::timeout(Duration::from_secs(5), drive_session(client, session, plan, next_stop, |_| {}, on_turn, std::future::pending())).await.unwrap();
        (status, turns.into_inner().unwrap())
    }

    fn fixture(steps: Vec<crate::acp::fake::Step>, loadable: bool) -> (AcpClient, Arc<TaskSession>, crate::acp::fake::Log, Arc<Recorder>) {
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new("r", AgentKind::Claude, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
        let (reader, writer, log) = if loadable { crate::acp::fake::spawn_loadable(steps) } else { crate::acp::fake::spawn(steps) };
        (AcpClient::start(reader, writer, session.clone()), session, log, sink)
    }

    fn prompts(log: &crate::acp::fake::Log) -> Vec<String> {
        log.lock().unwrap().iter().filter(|v| v["method"] == "session/prompt").map(|v| v["params"]["prompt"][0]["text"].as_str().unwrap().to_string()).collect()
    }

    fn count(log: &crate::acp::fake::Log, method: &str) -> usize {
        log.lock().unwrap().iter().filter(|v| v["method"] == method).count()
    }

    #[tokio::test]
    async fn messages_stay_in_one_session_and_closing_is_a_normal_end() {
        use crate::acp::fake::Step;
        let (client, session, log, _) = fixture(vec![Step::Message("xin chào"), Step::End("end_turn")], false);
        let (status, turns) = session_with(&client, &session, None, None, vec!["hai", "ba"], false).await;
        assert_eq!(status, "done");
        assert_eq!(turns, vec!["done", "done", "done"]);
        assert_eq!(count(&log, "session/new"), 1, "gửi thêm câu không được mở phiên mới");
        assert_eq!(prompts(&log), vec!["đầu", "hai", "ba"]);
        assert!(!session.is_busy());
    }

    #[tokio::test]
    async fn a_warm_session_goes_straight_to_the_prompt() {
        use crate::acp::fake::Step;
        let (client, session, log, _) = fixture(vec![Step::Message("xin chào"), Step::End("end_turn")], false);
        client.initialize().await.unwrap();
        let id = client.new_session(&std::env::temp_dir(), json!([])).await.unwrap();
        let cwd = std::env::temp_dir();
        let plan = SessionPlan { cwd: &cwd, prompt: "đầu".into(), recap: Some("TÓM TẮT".into()), servers: &[], resume: None, opened: Some(id.clone()), next: None, idle_limit: IDLE_LIMIT, prefs: SessionPrefs::default() };
        let (_keep, rx) = oneshot::channel();
        let mut stop = Some(rx);
        let opened = Mutex::new(None);
        let (status, _) = tokio::time::timeout(Duration::from_secs(5), drive_session(&client, &session, plan, || stop.take().unwrap(), |sid| *opened.lock().unwrap() = Some(sid.to_string()), |_| {}, std::future::pending())).await.unwrap();
        assert_eq!(status, "done");
        assert_eq!((count(&log, "initialize"), count(&log, "session/new")), (1, 1), "phiên đã mở sẵn không được mở lại");
        assert_eq!(opened.into_inner().unwrap(), Some(id));
        assert_eq!(prompts(&log), vec!["TÓM TẮT\n\nđầu"]);
    }

    #[tokio::test]
    async fn a_refused_turn_is_reported_and_the_session_stays_open() {
        use crate::acp::fake::Step;
        let (client, session, log, _) = fixture(vec![Step::End("refusal")], false);
        let (status, turns) = session_with(&client, &session, None, None, vec!["hai"], false).await;
        assert_eq!(turns, vec!["failed", "failed"]);
        assert_eq!(status, "failed");
        assert_eq!(prompts(&log).len(), 2);
    }

    #[tokio::test]
    async fn only_one_turn_can_be_claimed() {
        let (_, session, _, _) = fixture(vec![], false);
        assert!(session.claim_turn());
        assert!(!session.claim_turn());
        session.set_busy(false);
        assert!(session.claim_turn());
    }

    #[tokio::test]
    async fn a_reopened_session_needs_no_recap() {
        use crate::acp::fake::Step;
        let (client, session, log, _) = fixture(vec![Step::End("end_turn")], true);
        session_with(&client, &session, Some("cũ".into()), Some("TÓM TẮT".into()), vec![], false).await;
        assert_eq!(count(&log, "session/load"), 1);
        assert_eq!(count(&log, "session/new"), 0);
        assert_eq!(prompts(&log), vec!["đầu"]);
    }

    #[tokio::test]
    async fn an_agent_that_cannot_reopen_gets_the_recap() {
        use crate::acp::fake::Step;
        let (client, session, log, _) = fixture(vec![Step::End("end_turn")], false);
        session_with(&client, &session, Some("cũ".into()), Some("TÓM TẮT".into()), vec![], false).await;
        assert_eq!(count(&log, "session/load"), 0);
        assert_eq!(prompts(&log), vec!["TÓM TẮT\n\nđầu"]);
    }

    #[tokio::test]
    async fn tokens_add_up_across_turns_while_cost_is_the_session_total() {
        let (_, session, _, sink) = fixture(vec![], false);
        use crate::acp::client::ClientHandler;
        let cost = |amount: f64| json!({"update":{"sessionUpdate":"usage_update","used":1,"size":2,"cost":{"amount":amount,"currency":"USD"}}});
        session.on_notification("session/update", cost(0.1));
        session.turn_finished(&json!({"usage":{"inputTokens":2,"cachedWriteTokens":10,"cachedReadTokens":100,"outputTokens":4}}));
        session.on_notification("session/update", cost(0.25));
        session.turn_finished(&json!({"usage":{"inputTokens":3,"cachedWriteTokens":5,"cachedReadTokens":200,"outputTokens":6}}));
        let events = sink.0.lock().unwrap();
        let last = events.iter().rev().find_map(|e| e.usage.clone()).unwrap();
        assert_eq!((last.input_tokens, last.cached_input_tokens, last.output_tokens), (20, 300, 10));
        assert_eq!(last.cost_usd, Some(0.25));
        assert!(last.cumulative);
        assert!(events.iter().filter_map(|e| e.usage.as_ref()).all(|u| u.cumulative));
    }

    #[tokio::test]
    async fn a_reopened_session_counts_only_new_cost_and_mutes_its_replay() {
        let (_, session, _, sink) = fixture(vec![], false);
        use crate::acp::client::ClientHandler;
        session.set_cost_base(0.2);
        session.set_muted(true);
        session.on_notification("session/update", json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"cũ"}}}));
        session.set_muted(false);
        session.on_notification("session/update", json!({"update":{"sessionUpdate":"usage_update","used":1,"size":2,"cost":{"amount":0.25,"currency":"USD"}}}));
        let events = sink.0.lock().unwrap();
        assert!(!events.iter().any(|e| e.kind == "message"));
        let cost = events.iter().rev().find_map(|e| e.usage.as_ref()?.cost_usd).unwrap();
        assert!((cost - 0.05).abs() < 1e-9, "{cost}");
    }

    #[test]
    fn turn_outcome_maps_stop_reasons() {
        for (result, status, message) in [
            (json!({"stopReason": "end_turn"}), "done", None),
            (json!({}), "done", None),
            (json!({"stopReason": "unknown"}), "done", None),
            (json!({"stopReason": "cancelled"}), "stopped", None),
            (json!({"stopReason": "max_tokens"}), "failed", Some("Agent dừng vì đã hết giới hạn độ dài trả lời.")),
            (json!({"stopReason": "max_turn_requests"}), "failed", Some("Agent dừng vì đã đạt giới hạn số bước trong một lượt.")),
            (json!({"stopReason": "refusal"}), "failed", Some("Agent từ chối thực hiện yêu cầu này.")),
        ] {
            assert_eq!(turn_outcome(&result), (status, message.map(str::to_string)), "{result}");
        }
    }

    #[tokio::test]
    async fn refusal_turn_is_failed_in_drive() {
        use crate::acp::fake::{self, Step};
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink, Arc::new(Rules)).unwrap());
        let (reader, writer, _) = fake::spawn(vec![Step::End("refusal")]);
        let client = AcpClient::start(reader, writer, session.clone());
        let (_tx, rx) = oneshot::channel();
        let result = drive(&client, &session, &std::env::temp_dir(), "p", &[], rx, std::future::pending()).await;
        assert_eq!(result, ("failed", Some("Agent từ chối thực hiện yêu cầu này.".into())));
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
            let result = tokio::time::timeout(Duration::from_secs(2), drive(&client, &session, &std::env::temp_dir(), "p", &[], rx, std::future::pending())).await.unwrap();
            assert_eq!(result.0, status);
            if status == "failed" {
                let events = sink.0.lock().unwrap();
                assert_eq!(events.iter().filter(|e| e.kind == "permission").count(), 1);
                assert_eq!(events.iter().filter(|e| e.kind == "permission_resolved").count(), 1);
            }
        }
    }
    #[tokio::test]
    async fn session_new_carries_enabled_mcp_servers() {
        use crate::acp::fake::{self, Step};
        use crate::mcp::{McpServer, NameValue};
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
        let (reader, writer, log) = fake::spawn(vec![Step::End("end_turn")]);
        let client = AcpClient::start(reader, writer, session.clone());
        let servers = [
            McpServer { id: "1".into(), name: "docs".into(), transport: "stdio".into(), command: Some("docs-mcp".into()), args: vec![], env: vec![NameValue { name: "K".into(), value: "v".into() }], url: None, headers: vec![], agents: vec![AgentKind::Codex] },
            McpServer { id: "2".into(), name: "web".into(), transport: "http".into(), command: None, args: vec![], env: vec![], url: Some("https://x".into()), headers: vec![], agents: vec![AgentKind::Codex] },
        ];
        let (_tx, rx) = oneshot::channel();
        let result = drive(&client, &session, &std::env::temp_dir(), "p", &servers, rx, std::future::pending()).await;
        assert_eq!(result.0, "done");
        let sent = log.lock().unwrap().iter().find(|v| v["method"] == "session/new").cloned().unwrap();
        assert_eq!(sent["params"]["mcpServers"], json!([{"name":"docs","command":"docs-mcp","args":[],"env":[{"name":"K","value":"v"}]}]));
        // The fake agent does not offer http, so the user is told why "web" is missing.
        assert!(sink.0.lock().unwrap().iter().any(|e| e.kind == "stderr" && e.line.as_deref().unwrap().contains("web")));
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
        let (result, _) = tokio::join!(drive(&client, &session, &cwd, "p", &[], rx, std::future::pending()), request_stop);
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
        let result = drive(&client, &session, &std::env::temp_dir(), "p", &[], rx, dead).await;
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
            tokio::join!(drive(&client, &session, &cwd, "p", &[], rx, std::future::pending()), request_stop)
        }).await.unwrap();
        assert_eq!(result.0, "stopped");
        assert!(requested_at.elapsed() >= Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn adapter_cleanup_kills_descendants_holding_stdio() {
        use std::os::unix::process::CommandExt;
        use tokio::io::AsyncReadExt;
        let mut command = env::command("sh");
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
        let result = prepare(&store, AgentKind::Codex, "task", &repo.0, Adapter::Spawn((missing, vec![])), None, None, Place::Draft(None)).await;
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
        run_live_with(store, repo, prompt, group, &[]).await
    }

    async fn run_live_with(store: &Store, repo: &Path, prompt: &str, group: Option<&str>, servers: &[McpServer]) -> LiveRun {
        run_live_agent(AgentKind::Claude, store, repo, prompt, group, servers).await
    }

    async fn run_live_agent(agent: AgentKind, store: &Store, repo: &Path, prompt: &str, group: Option<&str>, servers: &[McpServer]) -> LiveRun {
        let command = agent.acp_command(env::which).expect("adapter ACP hoặc npx");
        let timeout = setup_timeout(&command.0);
        let (id, wt, mut child, _) = prepare(store, agent, prompt, repo, Adapter::Spawn(command), group, None, Place::Draft(None)).await.unwrap();
        let pid = child.id();
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new(&id, agent, &wt.path, sink.clone(), Arc::new(Rules)).unwrap());
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
        let client = AcpClient::start_with_timeout(client_in, tee_in, session.clone(), timeout);
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
        let (status, error) = tokio::time::timeout(Duration::from_secs(300), drive(&client, &session, &wt.path, prompt, servers, rx, async { std::future::pending::<()>().await })).await.expect("quá 5 phút");
        client.close();
        terminate_adapter(&mut child, pid).await;
        sink.emit(AgentEvent::new(&id, agent, "exit"));
        let asked = approver.await.unwrap();
        let events = sink.0.lock().unwrap().clone();
        let traffic = traffic.lock().unwrap().clone();
        LiveRun { wt, status, error, events, asked, traffic }
    }

    fn message_of(events: &[AgentEvent]) -> String {
        events.iter().filter(|e| e.kind == "message").filter_map(|e| e.data.as_ref()?["text"].as_str().map(String::from)).collect()
    }

    /// Phase 1 acceptance against the real Claude adapter (needs network and a logged-in `claude`):
    /// A session opened before its run exists answers its first prompt as quickly as an open CLI.
    /// `TG_LIVE_ACP=1 cargo test live_claude_warm -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_claude_warm_session_answers_after_attach() {
        if std::env::var("TG_LIVE_ACP").is_err() { return; }
        let command = AgentKind::Claude.acp_command(env::which).expect("adapter ACP hoặc npx");
        let dir = std::env::temp_dir();
        let started = std::time::Instant::now();
        let mut child = spawn_adapter(&command, &dir).unwrap();
        let stderr = child.stderr.take().unwrap();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
        let late = crate::acp::late::LateHandler::new();
        let client = AcpClient::start_with_timeout(child.stdout.take().unwrap(), child.stdin.take().unwrap(), late.clone(), setup_timeout(&command.0));
        client.initialize().await.unwrap();
        let id = client.new_session(&dir, json!([])).await.unwrap();
        eprintln!("mở phiên: {:?}", started.elapsed());
        // The user is still typing. The adapter answers session/new at once and starts the
        // agent in the background; its notifications arrive while nobody owns the session.
        let typing = std::env::var("TG_WARM_WAIT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(8000);
        tokio::time::sleep(Duration::from_millis(typing)).await;
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new("warm", AgentKind::Claude, &dir, sink.clone(), Arc::new(Rules)).unwrap());
        late.attach(session.clone()).unwrap();
        let plan = SessionPlan { cwd: &dir, prompt: "Trả lời đúng một từ: xin chào".into(), recap: None, servers: &[], resume: None, opened: Some(id), next: None, idle_limit: IDLE_LIMIT, prefs: SessionPrefs::default() };
        let (_keep, rx) = oneshot::channel();
        let mut stop = Some(rx);
        let asked = std::time::Instant::now();
        let watcher = { let sink = sink.clone(); tokio::spawn(async move {
            while !sink.0.lock().unwrap().iter().any(|e| e.kind == "message") { tokio::time::sleep(Duration::from_millis(20)).await; }
            eprintln!("token đầu sau khi gửi: {:?}", asked.elapsed());
        }) };
        let (status, error) = drive_session(&client, &session, plan, || stop.take().unwrap(), |_| {}, |_| {}, std::future::pending()).await;
        eprintln!("xong sau khi gửi: {:?}", asked.elapsed());
        watcher.abort();
        client.close();
        let pid = child.id();
        terminate_adapter(&mut child, pid).await;
        assert_eq!(status, "done", "{error:?}");
        let events = sink.0.lock().unwrap();
        assert!(events.iter().any(|e| e.kind == "message"), "không có câu trả lời");
        assert!(events.iter().any(|e| e.usage.is_some()), "không có usage của lượt");
    }

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

    fn greeting_repo() -> Repo {
        let repo = Repo::new();
        repo.write("hello.txt", "Hello world\n");
        worktree::git(&repo.0, &["add", "."], None).unwrap();
        worktree::git(&repo.0, &["commit", "-m", "hello"], None).unwrap();
        repo
    }

    const GREETING_PROMPT: &str = "Edit hello.txt so that its only line reads exactly `Hello ACP` (keep the trailing newline). Do not change anything else and do not commit.";

    /// M-D acceptance against the real Codex adapter (needs network and a logged-in `codex`):
    /// `TG_LIVE_ACP=1 cargo test live_codex -- --ignored --nocapture`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_codex_edit_diff_accept_commit() {
        if std::env::var("TG_LIVE_ACP").is_err() { return; }
        let repo = greeting_repo();
        let store = Store::open_in_memory().unwrap();
        let LiveRun { wt, status, error, events, .. } = run_live_agent(AgentKind::Codex, &store, &repo.0, GREETING_PROMPT, None, &[]).await;
        eprintln!("status={status} error={error:?}\nmessage={}\nusage={:?}", message_of(&events), events.iter().rev().find_map(|e| e.usage.clone()));
        assert_eq!(status, "done", "{error:?}");
        assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello world\n", "repo chỉ đổi khi duyệt");
        let pending = diff::pending(&wt).unwrap();
        assert!(pending.iter().any(|f| f.path == "hello.txt"), "diff phải có hello.txt: {pending:?}");
        assert!(events.iter().rev().find_map(|e| e.usage.clone()).is_some_and(|u| u.output_tokens > 0), "phải có token");
        diff::accept_all(&repo.0, &wt).unwrap();
        assert!(!diff::commit(&repo.0, "Đổi lời chào").unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello ACP\n");
        worktree::remove(&repo.0, &wt, true).unwrap();
    }

    /// Two prompts in one session remember each other, and so does a respawned adapter
    /// through session/load. Prints what it reports. `TG_LIVE_AGENT=claude|codex`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_two_turns_probe() {
        if std::env::var("TG_LIVE_ACP").is_err() { return; }
        let agent = if std::env::var("TG_LIVE_AGENT").as_deref() == Ok("codex") { AgentKind::Codex } else { AgentKind::Claude };
        let dir = std::env::temp_dir().join(format!("tg-two-turns-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let dir = dunce::canonicalize(dir).unwrap();
        let spawn = || {
            let (program, args) = agent.acp_command(env::which).unwrap();
            let mut c = env::command(program);
            c.args(args).current_dir(&dir).env("PATH", env::login_path()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
            c.spawn().unwrap()
        };
        let start = |child: &mut Child, sink: Arc<Recorder>| {
            let session = Arc::new(TaskSession::new("r", agent, &dir, sink, Arc::new(Rules)).unwrap());
            AcpClient::start_with_timeout(child.stdout.take().unwrap(), child.stdin.take().unwrap(), session, Duration::from_secs(300))
        };
        let sink = Arc::new(Recorder::default());
        let mut child = spawn();
        let client = start(&mut child, sink.clone());
        let init = client.initialize().await.unwrap();
        eprintln!("loadSession={}", init["agentCapabilities"]["loadSession"]);
        let id = client.new_session(&dir, json!([])).await.unwrap();
        for text in ["Remember the word PINEAPPLE. Reply with exactly: ok", "Which word did I ask you to remember? Reply with that word only."] {
            let result = client.prompt_turn(&id, text).await.unwrap();
            tokio::time::sleep(Duration::from_millis(500)).await;
            let events = sink.0.lock().unwrap();
            let costs: Vec<_> = events.iter().filter(|e| e.kind == "usage").filter_map(|e| e.usage.as_ref()?.cost_usd).collect();
            eprintln!("RESULT stop={} usage={} costs={costs:?}\nMESSAGE={}", result["stopReason"], result["usage"], message_of(&events));
            drop(events);
        }
        assert!(message_of(&sink.0.lock().unwrap()).contains("PINEAPPLE"), "câu sau phải nhớ câu trước");
        eprintln!("pid alive across turns: {:?}", child.id());
        client.close();
        let pid = child.id(); terminate_adapter(&mut child, pid).await;
        let sink = Arc::new(Recorder::default());
        let mut child = spawn();
        let client = start(&mut child, sink.clone());
        client.initialize().await.unwrap();
        let loaded = client.load_session(&id, &dir, json!([])).await;
        eprintln!("LOAD={loaded:?} replayed={}", sink.0.lock().unwrap().len());
        if loaded.is_ok() {
            sink.0.lock().unwrap().clear();
            let result = client.prompt_turn(&id, "Which word did I ask you to remember? Reply with that word only.").await.unwrap();
            tokio::time::sleep(Duration::from_millis(500)).await;
            let events = sink.0.lock().unwrap();
            let costs: Vec<_> = events.iter().filter(|e| e.kind == "usage").filter_map(|e| e.usage.as_ref()?.cost_usd).collect();
            eprintln!("AFTER LOAD usage={} costs={costs:?} MESSAGE={}", result["usage"], message_of(&events));
            assert!(message_of(&events).contains("PINEAPPLE"), "phiên nối lại phải nhớ");
            drop(events);
        }
        client.close();
        let pid = child.id(); terminate_adapter(&mut child, pid).await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Read-only runs happen in the real folder, even with approvals off in the CLI's settings.
    /// `TG_LIVE_ACP=1 TG_LIVE_AGENT=claude|codex cargo test live_read_only -- --ignored`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_read_only_run_cannot_write() {
        if std::env::var("TG_LIVE_ACP").is_err() { return; }
        let agent = if std::env::var("TG_LIVE_AGENT").as_deref() == Ok("codex") { AgentKind::Codex } else { AgentKind::Claude };
        let dir = dunce::canonicalize(std::env::temp_dir()).unwrap().join(format!("tg-read-only-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let program = env::which(agent.binary()).expect("agent CLI");
        let (args, input) = agent.headless_invocation("Create a file named pwned.txt containing x in the current directory using your tools.", &program).unwrap();
        let mut child = env::command(program).args(args).current_dir(&dir).env("PATH", env::login_path())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        // Claude reads the question from stdin; closing it ends the session after one answer.
        let mut stdin = child.stdin.take().unwrap();
        if let Some(text) = input { use tokio::io::AsyncWriteExt; stdin.write_all(text.as_bytes()).await.unwrap(); }
        drop(stdin);
        let output = child.wait_with_output().await.unwrap();
        eprintln!("{}", String::from_utf8_lossy(&output.stdout).lines().last().unwrap_or_default());
        assert!(!dir.join("pwned.txt").exists(), "chế độ Chỉ hỏi đã ghi được vào thư mục thật");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The M-D scenario: Claude and Codex on one prompt at once, then one result is used.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_claude_and_codex_in_parallel_use_one() {
        if std::env::var("TG_LIVE_ACP").is_err() { return; }
        let repo = greeting_repo();
        let store = Store::open_in_memory().unwrap();
        let (claude, codex) = tokio::join!(
            run_live_agent(AgentKind::Claude, &store, &repo.0, GREETING_PROMPT, Some("nhom-m-d"), &[]),
            run_live_agent(AgentKind::Codex, &store, &repo.0, GREETING_PROMPT, Some("nhom-m-d"), &[]),
        );
        assert_eq!(claude.status, "done", "{:?}", claude.error);
        assert_eq!(codex.status, "done", "{:?}", codex.error);
        assert_ne!(claude.wt.path, codex.wt.path);
        assert!(diff::pending(&claude.wt).unwrap().iter().any(|f| f.path == "hello.txt"));
        assert!(diff::pending(&codex.wt).unwrap().iter().any(|f| f.path == "hello.txt"));
        diff::accept_all(&repo.0, &codex.wt).unwrap();
        assert!(!diff::commit(&repo.0, "Dùng bản của Codex").unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello ACP\n");
        worktree::remove(&repo.0, &claude.wt, true).unwrap();
        worktree::remove(&repo.0, &codex.wt, true).unwrap();
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
    async fn direct_place_works_in_the_folder_and_failure_never_deletes_it() {
        let repo = Repo::new();
        let store = Store::open_in_memory().unwrap();
        let missing = repo.0.join("missing-adapter");
        assert!(prepare(&store, AgentKind::Codex, "fix", &repo.0, Adapter::Spawn((missing, vec![])), None, None, Place::Direct).await.is_err());
        assert!(repo.0.join("file.txt").exists(), "a failed start must not touch the user's folder");
        let (id, wt, mut child, _) = prepare(&store, AgentKind::Codex, "fix", &repo.0, Adapter::Spawn((PathBuf::from(if cfg!(windows) { "cmd" } else { "true" }), vec![])), None, None, Place::Direct).await.unwrap();
        assert!(wt.is_direct());
        let (stored_repo, stored) = store.run_worktree(&id).unwrap();
        assert_eq!(stored, wt);
        assert_eq!(dunce::canonicalize(stored.path).unwrap(), dunce::canonicalize(stored_repo).unwrap());
        let _ = child.wait().await;
        // A draft from a branch that does not exist is refused before anything is created.
        let error = prepare(&store, AgentKind::Codex, "fix", &repo.0, Adapter::Spawn((PathBuf::from("true"), vec![])), None, None, Place::Draft(Some("--force".into()))).await.err().unwrap();
        assert!(error.contains("Không tìm thấy nhánh"), "{error}");
    }

    #[tokio::test]
    async fn reused_worktree_run_keeps_its_own_id() {
        let repo = Repo::new();
        let store = Store::open_in_memory().unwrap();
        let wt = repo.wt();
        store.insert_run_with_worktree(&NewRun { id: &wt.run_id, agent: AgentKind::Claude, prompt: "plan", cwd: wt.path.to_str().unwrap(), started_at: 1 }, repo.0.to_str().unwrap(), &wt, None).unwrap();
        store.finish_run(&wt.run_id, "done", Some(0), 2).unwrap();
        let missing = repo.0.join("missing-adapter");
        assert!(prepare(&store, AgentKind::Codex, "build", &repo.0, Adapter::Spawn((missing, vec![])), None, Some(wt.clone()), Place::Draft(None)).await.is_err());
        assert!(wt.path.exists(), "a failed later step must not delete the shared worktree");
        assert_eq!(store.list_runs(10).unwrap().len(), 1);
        let (id, shared_wt, mut child, _) = prepare(&store, AgentKind::Codex, "build", &repo.0, Adapter::Spawn((PathBuf::from(if cfg!(windows) { "cmd" } else { "true" }), vec![])), None, Some(wt.clone()), Place::Draft(None)).await.unwrap();
        assert_ne!(id, wt.run_id);
        assert_eq!(shared_wt, wt);
        assert_eq!(store.run_worktree(&id).unwrap().1.run_id, wt.run_id);
        store.finish_run(&id, "failed", None, 3).unwrap();
        let _ = child.wait().await;
        let runs = store.list_runs(10).unwrap();
        assert_eq!(runs.len(), 2);
        assert!(runs.iter().all(|r| r.worktree.as_deref() == wt.path.to_str()));
        let original = runs.iter().find(|r| r.id == wt.run_id).unwrap();
        assert_eq!(original.status, "done");
        assert_eq!(original.prompt, "plan");
        let later = runs.iter().find(|r| r.id == id).unwrap();
        assert_eq!(later.status, "failed");
        assert_eq!(later.prompt, "build");
        let (root, shared) = store.run_worktree(&later.id).unwrap();
        worktree::remove(&root, &shared, true).unwrap();
        store.clear_run_worktree(&later.id).unwrap();
        assert!(store.run_worktree(&wt.run_id).is_err());
    }

    /// Phase 3: an MCP server from the registry reaches a real Claude ACP session.
    /// Uses `tests/fixtures/mcp/ping-server.js` (needs `node`).
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_claude_acp_uses_registry_mcp_server() {
        if std::env::var("TG_LIVE_ACP").is_err() { return; }
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp/ping-server.js").to_string_lossy().into_owned();
        let repo = Repo::new();
        let store = Store::open_in_memory().unwrap();
        let servers = [McpServer { id: "1".into(), name: "tg-ping".into(), transport: "stdio".into(), command: Some("node".into()), args: vec![script],
            env: vec![], url: None, headers: vec![], agents: vec![AgentKind::Claude] }];
        let run = run_live_with(&store, &repo.0, "Call the ping tool from the tg-ping MCP server and reply with exactly what it returned. Do not edit files.", None, &servers).await;
        let message = message_of(&run.events);
        assert_eq!(run.status, "done", "{:?}", run.error);
        assert!(message.contains("pong from tg-ping"), "{message}");
        let new = run.traffic.iter().find(|m| m["msg"]["method"] == "session/new").unwrap();
        assert_eq!(new["msg"]["params"]["mcpServers"][0]["name"], "tg-ping");
        worktree::remove(&repo.0, &run.wt, true).unwrap();
    }

    /// tg-bridge end to end with real Claude: the built app binary runs as the MCP server
    /// (`--mcp-bridge`) and forwards to an in-process hub.
    /// `cargo build && TG_LIVE_ACP=1 TG_BRIDGE_EXE=target/debug/tg-studio cargo test live_claude_tg_bridge -- --ignored`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_claude_tg_bridge_notes_and_progress() {
        let (Ok(_), Ok(exe)) = (std::env::var("TG_LIVE_ACP"), std::env::var("TG_BRIDGE_EXE")) else { return };
        struct Env { store: Store, events: Mutex<Vec<serde_json::Value>> }
        impl ToolEnv for Env {
            fn emit(&self, data: serde_json::Value, _: String) { self.events.lock().unwrap().push(data); }
            fn add_note(&self, topic: &str, text: &str) -> Result<(), String> { self.store.add_note("task", topic, text, "r", AgentKind::Claude, 1).map_err(|e| e.to_string()) }
            fn notes(&self, topic: Option<&str>) -> Result<Vec<(String, String, u64, String)>, String> { self.store.notes("task", topic).map_err(|e| e.to_string()) }
            fn approve(&self, _: String, _: String) -> bridge::BoxFuture<bool> { Box::pin(async { false }) }
            fn context(&self) -> serde_json::Value { json!({ "task": "live test" }) }
        }
        let hub = Arc::new(BridgeHub::default());
        let addr = hub.address().await.unwrap();
        let env = Arc::new(Env { store: Store::open_in_memory().unwrap(), events: Mutex::new(vec![]) });
        let token = hub.register(env.clone());
        let servers = [McpServer {
            id: "b".into(), name: bridge::SERVER_NAME.into(), transport: "stdio".into(), command: Some(exe), args: vec![bridge::FLAG.into()],
            env: vec![mcp::NameValue { name: "TG_BRIDGE_ADDR".into(), value: addr }, mcp::NameValue { name: "TG_BRIDGE_TOKEN".into(), value: token }],
            url: None, headers: vec![], agents: vec![AgentKind::Claude],
        }];
        let repo = Repo::new();
        let store = Store::open_in_memory().unwrap();
        let prompt = "Use the tg-bridge MCP tools only, do not edit files. 1) write_note with topic \"plan\" and text \"Buoc 1: doc README\". 2) report_progress with step \"da ghi chu\" and pct 50. 3) read_notes and reply with exactly the note text you read.";
        let run = run_live_with(&store, &repo.0, prompt, None, &servers).await;
        let message = message_of(&run.events);
        assert_eq!(run.status, "done", "{:?}", run.error);
        assert!(message.contains("Buoc 1: doc README"), "{message}");
        assert_eq!(env.store.notes("task", Some("plan")).unwrap()[0].3, "Buoc 1: doc README");
        assert!(env.events.lock().unwrap().iter().any(|e| e["tool"] == "report_progress" && e["pct"] == 50.0), "{:?}", env.events.lock().unwrap());
        worktree::remove(&repo.0, &run.wt, true).unwrap();
    }

    #[tokio::test]
    async fn invalid_and_uncommitted_repos_never_create_runs() {
        let path = std::env::temp_dir().join(format!("tg-invalid-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let store = Store::open_in_memory().unwrap();
        let missing = path.join("missing");
        let error = prepare(&store, AgentKind::Codex, "task", &path, Adapter::Spawn((missing.clone(), vec![])), None, None, Place::Draft(None)).await.err().unwrap();
        assert!(error.contains("Git"));
        worktree::git(&path, &["init"], None).unwrap();
        let error = prepare(&store, AgentKind::Codex, "task", &path, Adapter::Spawn((missing, vec![])), None, None, Place::Draft(None)).await.err().unwrap();
        assert!(error.contains("commit"));
        assert!(store.list_runs(10).unwrap().is_empty());
        assert!(!path.join(".tg").exists());
        std::fs::remove_dir_all(path).unwrap();
    }
}
