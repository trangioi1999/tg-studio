//! Tauri boundary and process lifetime for ACP tasks. Session routing stays UI-independent.

pub(crate) mod bridge_env;
pub(crate) mod changes;
pub(crate) mod cleanup;
pub(crate) mod delegate;
pub(crate) mod headless;
pub(crate) mod session;
pub(crate) mod warm;

use bridge_env::{bridge_enabled, bridge_server, ChildSpec, TaskEnv};
use changes::stored_worktree;
#[cfg(test)]
use cleanup::delete_runs_inner;

use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio, sync::{Arc, Mutex}, time::Duration};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::{io::{AsyncBufReadExt, BufReader}, process::Child, sync::oneshot};
use crate::{acp::client::AcpClient, tasks::session::{Approval, TaskSession, EventSink, RuleMemory}, agents::adapters::{AgentKind, setup_timeout}, workspace::diff::{self, FileDiff}, system::env, integrations::bridge::{self, BridgeHub, ToolEnv}, integrations::mcp::{self, McpServer}, agents::options::{self, SessionPrefs}, tasks::headless::{AgentEvent, Runs}, store::{NewRun, Store}, workspace::files, workspace::worktree::{self, Worktree}};

#[derive(Default)]
pub struct TaskRuns(Mutex<HashMap<String, Arc<TaskSession>>>);

impl TaskRuns {
    /// The agent is working on a turn, not just waiting for the next message.
    fn busy(&self, run_id: &str) -> Result<bool, String> {
        Ok(self.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.get(run_id).is_some_and(|s| s.is_busy()))
    }

    /// Some agent is writing in this folder now (every direct run of a repo works in the repo
    /// itself; pipeline steps share a draft).
    fn writing_in(&self, dir: &Path) -> Result<bool, String> {
        let wanted = dunce::canonicalize(dir).ok();
        let same = |p: &Path| p == dir || (wanted.is_some() && dunce::canonicalize(p).ok() == wanted);
        Ok(self.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.values().any(|s| s.is_busy() && same(s.root())))
    }

    /// Runs `f` with these folders locked, once no agent writes in the ones that carry a
    /// message, and (with `own`) once this run is not busy. Checked under the lock, so the
    /// check and the change it allows are one step for every other review or commit.
    /// A folder without a message is only locked: its writer does not matter to `f`.
    pub(crate) fn quiet_in<T>(&self, own: Option<(&str, &str)>, dirs: &[(&Path, Option<&str>)], f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let paths: Vec<&Path> = dirs.iter().map(|(d, _)| *d).collect();
        diff::exclusive_in(&paths, || {
            if let Some((id, why)) = own {
                if self.busy(id)? { return Err(why.to_owned()); }
            }
            for (dir, why) in dirs {
                if let Some(why) = why {
                    if self.writing_in(dir)? { return Err((*why).to_owned()); }
                }
            }
            f()
        })
    }
}

/// Marks the session at work, under its folder's lock: a review or commit running there
/// finishes first, and one that starts after sees the agent busy. False if it already works.
pub(crate) fn start_turn(session: &TaskSession) -> bool {
    diff::exclusive_in(&[session.root()], || session.claim_turn())
}

/// Where the next message of each open session goes.
#[derive(Default)]
pub struct SessionInboxes(Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<String>>>);

struct AppSink(AppHandle);
impl EventSink for AppSink {
    fn emit(&self, ev: AgentEvent) { headless::publish(&self.0, ev); }
    fn child_run(&self, id: &str, parent: &str, agent: AgentKind, title: &str) {
        if let Err(e) = self.0.state::<Store>().insert_child_run(id, parent, agent, title, crate::system::clock::now_ms()) { eprintln!("Không lưu được subagent: {e}"); }
    }
    fn child_finished(&self, id: &str, status: &str) {
        let code = (status == "done").then_some(0);
        if let Err(e) = self.0.state::<Store>().finish_run(id, status, code, crate::system::clock::now_ms()) { eprintln!("Không lưu được subagent: {e}"); }
    }
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
/// Where a new task works: the user's folder, or a draft (worktree) from a branch (`None`: HEAD).
#[derive(Debug, Clone, PartialEq)]
pub enum Place { Direct, Draft(Option<String>), Snapshot(String) }

/// Where a task works. A delegated agent (`child`: its snapshot, or `None` in place) follows
/// its parent; a question to an agent without a read-only CLI flag runs in a throwaway draft.
fn place_for(approval: Approval, place: Option<&str>, base: Option<String>, child: Option<Option<String>>) -> Result<Place, String> {
    Ok(match (child, approval, place) {
        (Some(Some(snapshot)), _, _) => Place::Snapshot(snapshot),
        (Some(None), _, _) => Place::Direct,
        (None, Approval::Deny, _) => Place::Draft(None),
        (None, _, Some("draft")) => Place::Draft(base.filter(|b| !b.is_empty())),
        (None, _, Some("direct")) => Place::Direct,
        (None, _, None) => Place::Draft(None),
        (None, _, Some(other)) => return Err(format!("Nơi làm việc không hợp lệ: {other}")),
    })
}

/// The ACP adapter process, with piped stdio, started in `dir`.
pub(crate) fn spawn_adapter(command: &(PathBuf, Vec<String>), dir: &Path) -> Result<Child, String> {
    let mut process = env::command(&command.0);
    process.args(&command.1).current_dir(dir)
        .env("PATH", env::login_path()).stdin(Stdio::piped()).stdout(Stdio::piped())
        .stderr(Stdio::piped()).kill_on_drop(true);
    env::isolate(&mut process);
    env::adapter_env(&mut process);
    process.spawn().map_err(|e| format!("Không chạy được adapter {}: {e}", command.0.display()))
}

/// How a task gets its adapter: start one, or take a session opened ahead of time.
/// `Warm` keeps the command: an adapter that died while waiting is replaced by a fresh one.
enum Adapter { Spawn((PathBuf, Vec<String>)), Warm(Box<crate::tasks::warm::Warm>, (PathBuf, Vec<String>)) }

#[cfg(test)]
async fn prepare(store: &Store, agent: AgentKind, prompt: &str, repo: &Path, adapter: Adapter, group: Option<&str>, reuse: Option<Worktree>, place: Place) -> Result<(String, Worktree, Child, Option<crate::tasks::warm::Claimed>), String> {
    prepare_with(store, agent, prompt, repo, adapter, group, reuse, place, None).await
}

/// The project's setup script, run in a new draft before its agent starts.
pub(super) struct Setup<'a> {
    pub command: &'a str,
    pub sink: Arc<dyn EventSink>,
    /// Where `stop_agent` finds the run while the script runs.
    pub stops: &'a Runs,
}

/// The last lines of a script's output, for the run's log.
fn output_tail(output: &str) -> String {
    let lines: Vec<&str> = output.trim_end().lines().collect();
    lines[lines.len().saturating_sub(40)..].join("\n")
}

/// Runs the setup script of a draft whose run is already saved. Err: the run has ended
/// (failed or stopped) and its exit event is sent.
async fn setup_draft(store: &Store, id: &str, agent: AgentKind, repo: &Path, wt: &Worktree, setup: Setup<'_>) -> Result<(), String> {
    let note = |text: String| {
        let mut event = AgentEvent::new(id, agent, "stderr");
        event.line = Some(text);
        setup.sink.emit(event);
    };
    note(format!("Đang chuẩn bị bản nháp: {}", setup.command.trim()));
    let (tx, rx) = oneshot::channel();
    setup.stops.0.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_owned(), tx);
    let result = tokio::select! {
        r = crate::workspace::hooks::run_setup(repo, &wt.path, setup.command) => Some(r),
        _ = rx => None,
    };
    setup.stops.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    let end = |status: &str, message: String| {
        note(message.clone());
        if let Err(e) = store.finish_run(id, status, None, crate::system::clock::now_ms()) { eprintln!("Không lưu được trạng thái lượt chạy: {e}"); }
        let mut event = AgentEvent::new(id, agent, "exit");
        event.data = Some(json!({ "status": status }));
        setup.sink.emit(event);
        Err(message)
    };
    match result {
        None => end("stopped", "Đã dừng khi đang chuẩn bị bản nháp.".into()),
        Some(Ok(r)) if r.code == Some(0) => {
            note(format!("Đã chuẩn bị bản nháp ({} s).", r.duration_ms / 1000));
            Ok(())
        }
        Some(Ok(r)) => {
            if !r.output.trim().is_empty() { note(output_tail(&r.output)); }
            let code = r.code.map_or_else(|| "bị dừng".to_owned(), |c| format!("mã {c}"));
            end("failed", format!("Script chuẩn bị hỏng ({code}). Sửa script ở Thiết lập dự án rồi gửi lại."))
        }
        Some(Err(e)) => end("failed", format!("Không chạy được script chuẩn bị: {e}")),
    }
}

#[allow(clippy::too_many_arguments)]
async fn prepare_with(store: &Store, agent: AgentKind, prompt: &str, repo: &Path, adapter: Adapter, group: Option<&str>, reuse: Option<Worktree>, place: Place, setup: Option<Setup<'_>>) -> Result<(String, Worktree, Child, Option<crate::tasks::warm::Claimed>), String> {
    let id = uuid::Uuid::new_v4().to_string();
    // Only a new draft lacks the user's ignored files (.env, local settings).
    let setup = setup.filter(|s| reuse.is_none() && matches!(place, Place::Draft(_)) && !s.command.trim().is_empty());
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
        // A delegated agent: a draft from a snapshot of its parent's folder.
        (None, Place::Snapshot(commit)) => worktree::create_at(repo, agent_name.as_str().unwrap(), prompt, &id, Some(&commit)),
    })();
    let wt = match made {
        Ok(wt) => wt,
        Err(e) => {
            if let Adapter::Warm(warm, _) = adapter { warm.close_later(); }
            return Err(e);
        }
    };
    let cleanup = |wt: &Worktree| if shared { Ok(()) } else { worktree::remove(repo, wt, true) };
    let new_run = NewRun { id: &id, agent, prompt, cwd: &wt.path.to_string_lossy(), started_at: crate::system::clock::now_ms() };
    let saved_early = setup.is_some();
    if let Some(setup) = setup {
        // Saved first: the script's lines belong to the run, and a stop must find it.
        if let Err(e) = store.insert_run_with_worktree(&new_run, &repo.to_string_lossy(), &wt, group) {
            let cleanup = cleanup(&wt);
            return Err(format!("Không lưu được lượt chạy: {e}{}", cleanup.err().map(|e| format!("; {e}")).unwrap_or_default()));
        }
        setup_draft(store, &id, agent, repo, &wt, setup).await?;
    }
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
            Err(e) if saved_early => {
                // The run and its prepared draft stay, as for any failed run.
                let _ = store.finish_run(&id, "failed", None, crate::system::clock::now_ms());
                return Err(e);
            }
            Err(e) => {
                let cleanup = cleanup(&wt);
                return Err(format!("{e}{}", cleanup.err().map(|e| format!("; {e}")).unwrap_or_default()));
            }
        },
    };
    let pid = warm.as_ref().and_then(|w| w.pid).or(child.id());
    if let Some(pid) = pid { crate::system::resources::register(pid, crate::system::resources::Owner::Run(id.clone())); }
    let saved = if saved_early { Ok(()) } else { store.insert_run_with_worktree(&new_run, &repo.to_string_lossy(), &wt, group) };
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
    if let Some(pid) = pid { crate::system::resources::unregister(pid); }
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
    session.reopen();
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
    // A commit may be running in this folder; wait for it (at most a second or so).
    start_turn(session);
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
    start_task_with(app, TaskRequest { group, reuse, single_turn, recap, thread, scope, prefs, place, base, approval, ..TaskRequest::new(agent, prompt, repo) }).await
}

/// What starting a task needs, from the UI (`start_task`) or from an agent delegating.
/// Named fields: many of them are optional strings, easy to pass in the wrong order.
pub(crate) struct TaskRequest {
    pub agent: AgentKind,
    pub prompt: String,
    pub repo: String,
    /// Runs started together in parallel mode.
    pub group: Option<String>,
    /// A later pipeline step: continue in this run's worktree.
    pub reuse: Option<String>,
    pub single_turn: Option<bool>,
    /// What a new session is told about the conversation it cannot reopen.
    pub recap: Option<String>,
    pub thread: Option<String>,
    pub scope: Option<String>,
    pub prefs: Option<SessionPrefs>,
    /// "direct" or "draft".
    pub place: Option<String>,
    /// The branch a draft starts from.
    pub base: Option<String>,
    pub approval: Option<Approval>,
    /// Set when another agent delegated this task.
    pub child: Option<ChildSpec>,
}

impl TaskRequest {
    pub fn new(agent: AgentKind, prompt: String, repo: String) -> Self {
        Self { agent, prompt, repo, group: None, reuse: None, single_turn: None, recap: None, thread: None, scope: None, prefs: None, place: None, base: None, approval: None, child: None }
    }
}

pub(crate) async fn start_task_with(app: AppHandle, request: TaskRequest) -> Result<String, String> {
    let TaskRequest { agent, prompt, repo, group, reuse, single_turn, recap, thread, scope, prefs, place, base, approval, child } = request;
    let approval = approval.unwrap_or_default();
    let single_turn = Some(single_turn.unwrap_or(false) || child.is_some());
    let (parent, child_done) = match child {
        Some(c) => (Some((c.parent, c.snapshot)), Some(c.done)),
        None => (None, None),
    };
    let place = place_for(approval, place.as_deref(), base, parent.as_ref().map(|(_, s)| s.clone()))?;
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
    // Not for a delegated agent: a session opened ahead of time has the parent's tg-bridge tools.
    let adapter = match (&place, &reuse, &resumed, env::scoped_dir(&repo, scope.as_deref())) {
        (Place::Direct, None, None, Ok(cwd)) if parent.is_none() => {
            let key = crate::tasks::warm::key_for(&app.state::<Store>(), agent, &cwd);
            match app.state::<crate::tasks::warm::WarmPool>().take(&key).await {
                Some(warm) => Adapter::Warm(Box::new(warm), command),
                None => Adapter::Spawn(command),
            }
        }
        _ => Adapter::Spawn(command),
    };
    // A new draft of a real task gets the project's setup script; not a question's throwaway draft, not a delegated agent.
    let setup_command = if !throwaway && parent.is_none() { crate::workspace::hooks::load(&app.state::<Store>(), &repo).setup } else { String::new() };
    let setup_sink: Arc<dyn EventSink> = Arc::new(AppSink(app.clone()));
    let setup = Some(Setup { command: &setup_command, sink: setup_sink, stops: &app.state::<Runs>() });
    let (id, wt, mut child, warm) = prepare_with(&app.state::<Store>(), agent, &prompt, &repo, adapter, group.as_deref(), reuse, place, setup).await?;
    let pid = warm.as_ref().and_then(|w| w.pid).or(child.id());
    if let Some(thread) = &thread {
        if let Err(e) = app.state::<Store>().set_run_thread(&id, thread, scope.as_deref()) { eprintln!("Không lưu được cuộc trò chuyện: {e}"); }
    }
    if let Some((parent, _)) = &parent {
        if let Err(e) = app.state::<Store>().set_run_parent(&id, parent) { eprintln!("Không lưu được run cha: {e}"); }
    }
    let start_dir = match env::scoped_dir(&wt.path, scope.as_deref()) {
        Ok(dir) => dir,
        Err(e) => {
            terminate_adapter(&mut child, pid).await;
            if let Some(warm) = warm { warm.release(); }
            let _ = app.state::<Store>().finish_run(&id, "failed", None, crate::system::clock::now_ms());
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
            let _ = app.state::<Store>().finish_run(&id, "failed", None, crate::system::clock::now_ms());
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
    if let Some((parent, _)) = &parent { started.data = Some(json!({ "parent": parent })); }
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
    let scope_name = scope.clone();
    let scope = group.clone().unwrap_or_else(|| wt.run_id.clone());
    let is_child = parent.is_some();
    let env = TaskEnv { app: app.clone(), run_id: id.clone(), agent, scope, prompt: prompt.clone(), group: group.clone(), wt: wt.clone(), sink: sink.clone(), session: session.clone(),
        repo: repo.clone(), thread: thread.clone(), subfolder: scope_name.clone(), child: is_child };
    tauri::async_runtime::spawn(async move {
        let mut servers: Vec<McpServer> = crate::tasks::warm::user_servers(&app.state::<Store>());
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
                    servers.push(bridge_server(agent, exe, addr, t.clone(), is_child));
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
        if let Err(e) = app.state::<Store>().finish_run(&task_id, status, code, crate::system::clock::now_ms()) {
            eprintln!("Không lưu được trạng thái lượt chạy: {e}");
        }
        if let Some(done) = child_done { let _ = done.send((status.to_string(), session.last_reply())); }
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
    if let Some(sent) = headless::send_headless(&app, &run_id, &prompt) { return sent; }
    let inbox = inboxes.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.get(&run_id).cloned();
    let session = tasks.0.lock().map_err(|_| "Không đọc được phiên ACP.")?.get(&run_id).cloned();
    let (Some(inbox), Some(session)) = (inbox, session) else { return Err("Phiên này đã đóng.".into()); };
    if !start_turn(&session) { return Err("Agent đang chạy. Hãy chờ hoặc dừng trước.".into()); }
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
#[cfg(test)]
mod tests;
