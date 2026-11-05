//! An ACP session opened before the user sends the first message of a conversation.
//! Starting the adapter and `session/new` take ~5 s (most of it the agent's own start);
//! doing it while the user types makes the first answer as quick as an open CLI.
//! Warming is an optimization: every failure here is logged, never shown, and
//! `start_task` falls back to opening its own session.

use std::{collections::VecDeque, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::{io::{AsyncBufReadExt, BufReader}, process::Child, task::JoinHandle};
use crate::{acp::{client::AcpClient, late::LateHandler}, acp_runner::EventSink, adapters::{setup_timeout, AgentKind}, bridge::{self, BridgeHub}, env, mcp::{self, McpServer}, runner::AgentEvent, store::Store};

/// Unclaimed sessions are closed after this long.
pub const WARM_TTL: Duration = Duration::from_secs(10 * 60);
const STDERR_TAIL: usize = 50;

/// What a session was opened with. A different key means a different session.
#[derive(Debug, Clone, PartialEq)]
pub struct WarmKey {
    pub agent: AgentKind,
    pub cwd: PathBuf,
    /// The user's MCP servers, serialized; tg-bridge is `bridge`.
    pub servers: String,
    pub bridge: bool,
}

/// The user's MCP servers a task session gets, without tg-bridge.
pub fn user_servers(store: &Store) -> Vec<McpServer> {
    mcp::load(store).into_iter().filter(|s| s.name != bridge::SERVER_NAME).collect()
}

/// The key for these servers: `warm_task` opens with the very list it keyed on.
pub fn key_of(agent: AgentKind, cwd: &Path, servers: &[McpServer], bridge: bool) -> WarmKey {
    WarmKey { agent, cwd: cwd.to_path_buf(), servers: serde_json::to_string(servers).unwrap_or_default(), bridge }
}

pub fn key_for(store: &Store, agent: AgentKind, cwd: &Path) -> WarmKey {
    key_of(agent, cwd, &user_servers(store), crate::acp_tasks::bridge_enabled(store))
}

/// Adapter stderr: kept as a short tail until a run owns the session, then streamed as events.
#[derive(Default)]
struct Relay { tail: VecDeque<String>, target: Option<(Arc<dyn EventSink>, String, AgentKind)> }

fn emit_stderr(sink: &Arc<dyn EventSink>, run_id: &str, agent: AgentKind, line: String) {
    let mut event = AgentEvent::new(run_id, agent, "stderr");
    event.line = Some(line);
    sink.emit(event);
}

/// An opened session waiting for its run.
pub struct Warm {
    child: Child,
    /// Taken at spawn: once the wrapper exits, `child.id()` is gone but its descendants may not be.
    pid: Option<u32>,
    parts: Claimed,
}

/// A warm session handed to its run; the run owns the adapter process separately.
pub struct Claimed {
    pub client: AcpClient,
    pub late: Arc<LateHandler>,
    pub session_id: String,
    pub pid: Option<u32>,
    /// Reserved tg-bridge token, bound to the run's tools on claim.
    pub token: Option<String>,
    /// Said to the user once the run exists (for example skipped MCP servers).
    pub notes: Vec<String>,
    relay: Arc<Mutex<Relay>>,
    pub stderr_task: JoinHandle<()>,
    hub: Arc<BridgeHub>,
}

impl Claimed {
    /// Adapter stderr goes to the run from now on, starting with what it already wrote.
    pub fn relay_to(&self, sink: Arc<dyn EventSink>, run_id: &str, agent: AgentKind) {
        let mut relay = self.relay.lock().unwrap();
        for line in relay.tail.drain(..) { emit_stderr(&sink, run_id, agent, line); }
        relay.target = Some((sink, run_id.to_string(), agent));
    }

    /// Releases everything but the process, which whoever holds the child stops.
    pub fn release(self) {
        self.client.close();
        if let Some(t) = &self.token { self.hub.unregister(t); }
        self.stderr_task.abort();
    }
}

impl Warm {
    pub fn into_parts(self) -> (Child, Claimed) { (self.child, self.parts) }

    fn alive(&mut self) -> bool { !self.parts.late.is_closed() && matches!(self.child.try_wait(), Ok(None)) }

    pub async fn close(mut self) {
        crate::acp_tasks::terminate_adapter(&mut self.child, self.pid).await;
        self.parts.release();
    }

    pub fn close_later(self) { tauri::async_runtime::spawn(self.close()); }
}

struct Entry {
    key: WarmKey,
    generation: u64,
    /// Held by the opening task until the session is ready (or failed: `None`).
    slot: Arc<tokio::sync::Mutex<Option<Warm>>>,
}

#[derive(Default)]
pub struct WarmPool { entry: Mutex<Option<Entry>>, generation: Mutex<u64> }

impl WarmPool {
    /// Closes the entry in the background once its opening has finished, so the adapter
    /// tree, the bridge token and the stderr reader are always released.
    fn discard(entry: Entry) {
        tauri::async_runtime::spawn(async move {
            if let Some(warm) = entry.slot.lock().await.take() { warm.close().await; }
        });
    }

    /// The session opened for `key`, waiting for it if it is still opening. `None`: open your own.
    pub async fn take(&self, key: &WarmKey) -> Option<Warm> {
        let entry = self.entry.lock().unwrap().take()?;
        if &entry.key != key {
            Self::discard(entry);
            return None;
        }
        let mut warm = entry.slot.lock().await.take()?;
        if warm.alive() { Some(warm) } else { warm.close_later(); None }
    }

    fn expire(&self, generation: u64) {
        let mut slot = self.entry.lock().unwrap();
        if slot.as_ref().is_some_and(|e| e.generation == generation) { Self::discard(slot.take().unwrap()); }
    }

    /// Puts an opening session in the pool unless one with this key is there.
    /// Replacing happens under one lock, so a slower earlier call can never win.
    fn install(&self, key: &WarmKey) -> Option<(u64, tokio::sync::OwnedMutexGuard<Option<Warm>>)> {
        let mut entry = self.entry.lock().unwrap();
        if entry.as_ref().is_some_and(|e| &e.key == key) { return None; }
        let generation = { let mut g = self.generation.lock().unwrap(); *g += 1; *g };
        let slot = Arc::new(tokio::sync::Mutex::new(None));
        let guard = slot.clone().try_lock_owned().expect("khoá mới tạo");
        if let Some(old) = entry.replace(Entry { key: key.clone(), generation, slot }) { Self::discard(old); }
        Some((generation, guard))
    }
}

/// Opens adapter + session for `key` with exactly the servers it was keyed on.
async fn open(hub: Arc<BridgeHub>, key: &WarmKey, mut servers: Vec<McpServer>) -> Result<Warm, String> {
    let command = key.agent.acp_command(env::which).ok_or("Không tìm thấy adapter.")?;
    let timeout = setup_timeout(&command.0);
    let mut child = crate::acp_tasks::spawn_adapter(&command, &key.cwd)?;
    let pid = child.id();
    let relay = Arc::new(Mutex::new(Relay::default()));
    let stderr = child.stderr.take().expect("piped stderr");
    let stderr_task = {
        let relay = relay.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut relay = relay.lock().unwrap();
                match &relay.target {
                    Some((sink, run_id, agent)) => emit_stderr(sink, run_id, *agent, line),
                    None => {
                        if relay.tail.len() == STDERR_TAIL { relay.tail.pop_front(); }
                        relay.tail.push_back(line);
                    }
                }
            }
        })
    };
    let late = LateHandler::new();
    let client = AcpClient::start_with_timeout(child.stdout.take().expect("piped stdout"), child.stdin.take().expect("piped stdin"), late.clone(), timeout);
    let mut notes = Vec::new();
    let mut token = None;
    if key.bridge {
        match (hub.address().await, bridge::executable()) {
            (Ok(addr), Some(exe)) => {
                let t = hub.reserve();
                servers.push(crate::acp_tasks::bridge_server(key.agent, exe, addr, t.clone()));
                token = Some(t);
            }
            (Err(e), _) => notes.push(format!("tg-bridge không bật được: {e}")),
            (_, None) => notes.push("tg-bridge không bật được: không xác định được đường dẫn của app.".into()),
        }
    }
    let opened = async {
        let init = client.initialize().await?;
        let (mcp, skipped) = mcp::for_acp(&servers, key.agent, &init);
        if !skipped.is_empty() { notes.push(format!("Bỏ qua MCP server {} vì agent không báo hỗ trợ kết nối http.", skipped.join(", "))); }
        client.new_session(&key.cwd, mcp).await
    };
    let result = tokio::time::timeout(timeout + Duration::from_secs(5), opened).await.unwrap_or_else(|_| Err("Adapter không trả lời kịp.".into()));
    let session_id = result.as_ref().cloned().unwrap_or_default();
    let warm = Warm { child, pid, parts: Claimed { client, late, session_id, pid, token, notes, relay, stderr_task, hub } };
    match result {
        Ok(_) => Ok(warm),
        Err(e) => { warm.close().await; Err(e) }
    }
}

/// Opens a session for the next message of a new conversation in `repo` (`scope`: its subfolder).
#[tauri::command]
pub async fn warm_task(app: AppHandle, agent: AgentKind, repo: String, scope: Option<String>) -> Result<(), String> {
    let root = crate::worktree::git(Path::new(&repo), &["rev-parse", "--show-toplevel"], None)?;
    let repo = dunce::canonicalize(root.trim()).map_err(|e| e.to_string())?;
    let cwd = env::scoped_dir(&repo, scope.as_deref())?;
    let (servers, bridge) = { let store = app.state::<Store>(); (user_servers(&store), crate::acp_tasks::bridge_enabled(&store)) };
    let key = key_of(agent, &cwd, &servers, bridge);
    let Some((generation, mut guard)) = app.state::<WarmPool>().install(&key) else { return Ok(()) };
    let hub = app.state::<Arc<BridgeHub>>().inner().clone();
    tauri::async_runtime::spawn(async move {
        match open(hub, &key, servers).await {
            Ok(warm) => *guard = Some(warm),
            Err(e) => eprintln!("Không mở sẵn được phiên {}: {e}", key.agent.display_name()),
        }
    });
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WARM_TTL).await;
        app.state::<WarmPool>().expire(generation);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(agent: AgentKind) -> WarmKey { WarmKey { agent, cwd: std::env::temp_dir(), servers: "[]".into(), bridge: false } }

    /// A warm session over the fake agent, with a long-lived stand-in process.
    fn warm() -> Warm {
        let mut sleep = env::command(if cfg!(windows) { "timeout" } else { "sleep" });
        sleep.arg("30").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).kill_on_drop(true);
        let child = sleep.spawn().unwrap();
        let (reader, writer, _) = crate::acp::fake::spawn(vec![]);
        let late = LateHandler::new();
        let client = AcpClient::start(reader, writer, late.clone());
        let pid = child.id();
        Warm { child, pid, parts: Claimed { client, late, session_id: "s".into(), pid, token: None, notes: vec![], relay: Default::default(), stderr_task: tokio::spawn(async {}), hub: Arc::new(BridgeHub::default()) } }
    }

    fn entry(pool: &WarmPool, key: WarmKey, generation: u64, ready: Option<Warm>) -> Arc<tokio::sync::Mutex<Option<Warm>>> {
        let slot = Arc::new(tokio::sync::Mutex::new(ready));
        *pool.entry.lock().unwrap() = Some(Entry { key, generation, slot: slot.clone() });
        slot
    }

    #[tokio::test]
    async fn a_send_while_opening_waits_for_that_session() {
        let pool = WarmPool::default();
        let slot = entry(&pool, key(AgentKind::Claude), 1, None);
        let mut guard = slot.clone().lock_owned().await;
        let opening = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            *guard = Some(warm());
        });
        let taken = pool.take(&key(AgentKind::Claude)).await.expect("phiên đang mở phải được chờ");
        assert_eq!(taken.parts.session_id, "s");
        opening.await.unwrap();
        assert!(pool.entry.lock().unwrap().is_none(), "phiên chỉ được nhận một lần");
    }

    #[tokio::test]
    async fn another_key_gets_nothing_and_the_old_session_is_closed() {
        let pool = WarmPool::default();
        let slot = entry(&pool, key(AgentKind::Claude), 1, Some(warm()));
        assert!(pool.take(&key(AgentKind::Codex)).await.is_none());
        tokio::time::timeout(Duration::from_secs(2), async { while slot.lock().await.is_some() { tokio::task::yield_now().await; } }).await.expect("phiên cũ phải bị đóng");
        assert!(pool.entry.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn a_dead_adapter_is_not_handed_out() {
        let pool = WarmPool::default();
        let mut dead = warm();
        dead.child.kill().await.unwrap();
        entry(&pool, key(AgentKind::Claude), 1, Some(dead));
        assert!(pool.take(&key(AgentKind::Claude)).await.is_none());
    }

    #[tokio::test]
    async fn a_failed_opening_falls_back() {
        let pool = WarmPool::default();
        entry(&pool, key(AgentKind::Claude), 1, None);
        assert!(pool.take(&key(AgentKind::Claude)).await.is_none());
    }

    #[tokio::test]
    async fn only_the_same_generation_expires() {
        let pool = WarmPool::default();
        entry(&pool, key(AgentKind::Claude), 2, Some(warm()));
        pool.expire(1);
        assert!(pool.entry.lock().unwrap().is_some(), "hết hạn của lần mở cũ không được đóng phiên mới");
        pool.expire(2);
        assert!(pool.entry.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn a_later_warm_always_replaces_an_earlier_one() {
        let pool = WarmPool::default();
        let (first, _a) = pool.install(&key(AgentKind::Claude)).unwrap();
        assert!(pool.install(&key(AgentKind::Claude)).is_none(), "cùng khoá thì giữ phiên đang mở");
        let (second, _b) = pool.install(&key(AgentKind::Codex)).unwrap();
        assert!(second > first);
        let entry = pool.entry.lock().unwrap();
        assert_eq!(entry.as_ref().map(|e| (e.key.agent, e.generation)), Some((AgentKind::Codex, second)));
    }

    #[tokio::test]
    async fn a_replaced_session_is_closed_once_its_opening_ends() {
        let pool = WarmPool::default();
        let (_, mut opening) = pool.install(&key(AgentKind::Claude)).unwrap();
        let old = pool.entry.lock().unwrap().as_ref().unwrap().slot.clone();
        pool.install(&key(AgentKind::Codex)).unwrap();
        // Still opening: nothing is aborted half-way; the opening finishes, then it is closed.
        *opening = Some(warm());
        drop(opening);
        tokio::time::timeout(Duration::from_secs(2), async { while old.lock().await.is_some() { tokio::task::yield_now().await; } }).await.expect("phiên bị thay phải được đóng");
    }

    #[test]
    fn the_key_follows_folder_servers_and_bridge() {
        let base = key(AgentKind::Claude);
        assert_ne!(base, WarmKey { cwd: std::env::temp_dir().join("con"), ..base.clone() });
        assert_ne!(base, WarmKey { servers: "[{}]".into(), ..base.clone() });
        assert_ne!(base, WarmKey { bridge: true, ..base.clone() });
    }
}
