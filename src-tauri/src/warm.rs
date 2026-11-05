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
    /// The user's MCP servers for this agent, serialized; tg-bridge is `bridge`.
    pub servers: String,
    pub bridge: bool,
}

/// The user's MCP servers a task session of `agent` gets, without tg-bridge.
pub fn user_servers(store: &Store, agent: AgentKind) -> Vec<McpServer> {
    let _ = agent;
    mcp::load(store).into_iter().filter(|s| s.name != bridge::SERVER_NAME).collect()
}

pub fn key_for(store: &Store, agent: AgentKind, cwd: &Path) -> WarmKey {
    let servers = serde_json::to_string(&user_servers(store, agent)).unwrap_or_default();
    WarmKey { agent, cwd: cwd.to_path_buf(), servers, bridge: crate::acp_tasks::bridge_enabled(store) }
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
    client: AcpClient,
    late: Arc<LateHandler>,
    session_id: String,
    /// Reserved tg-bridge token, bound to the run's tools on claim.
    token: Option<String>,
    /// Said to the user once the run exists (for example skipped MCP servers).
    notes: Vec<String>,
    relay: Arc<Mutex<Relay>>,
    stderr_task: JoinHandle<()>,
}

/// A warm session handed to its run; the run owns the adapter process separately.
pub struct Claimed {
    pub client: AcpClient,
    pub late: Arc<LateHandler>,
    pub session_id: String,
    pub token: Option<String>,
    pub notes: Vec<String>,
    relay: Arc<Mutex<Relay>>,
    pub stderr_task: JoinHandle<()>,
}

impl Claimed {
    /// Adapter stderr goes to the run from now on, starting with what it already wrote.
    pub fn relay_to(&self, sink: Arc<dyn EventSink>, run_id: &str, agent: AgentKind) {
        let mut relay = self.relay.lock().unwrap();
        for line in relay.tail.drain(..) { emit_stderr(&sink, run_id, agent, line); }
        relay.target = Some((sink, run_id.to_string(), agent));
    }
}

impl Warm {
    pub fn into_parts(self) -> (Child, Claimed) {
        let Warm { child, client, late, session_id, token, notes, relay, stderr_task } = self;
        (child, Claimed { client, late, session_id, token, notes, relay, stderr_task })
    }

    fn alive(&mut self) -> bool { !self.late.is_closed() && matches!(self.child.try_wait(), Ok(None)) }

    async fn close(mut self, hub: &BridgeHub) {
        self.client.close();
        if let Some(t) = &self.token { hub.unregister(t); }
        let pid = self.child.id();
        crate::acp_tasks::terminate_adapter(&mut self.child, pid).await;
        self.stderr_task.abort();
    }
}

struct Entry {
    key: WarmKey,
    generation: u64,
    /// Held by the opening task until the session is ready (or failed: `None`).
    slot: Arc<tokio::sync::Mutex<Option<Warm>>>,
    opening: JoinHandle<()>,
}

#[derive(Default)]
pub struct WarmPool { entry: Mutex<Option<Entry>>, generation: Mutex<u64> }

impl WarmPool {
    /// Removes the entry, whatever its state, and closes it.
    async fn discard(entry: Entry, hub: &BridgeHub) {
        entry.opening.abort();
        // An aborted opening drops its adapter (kill_on_drop); a finished one is closed here.
        if let Some(warm) = entry.slot.lock().await.take() { warm.close(hub).await; }
    }

    /// The session opened for `key`, waiting for it if it is still opening. `None`: open your own.
    pub async fn take(&self, key: &WarmKey, hub: &BridgeHub) -> Option<Warm> {
        let entry = self.entry.lock().unwrap().take()?;
        if &entry.key != key {
            Self::discard(entry, hub).await;
            return None;
        }
        let mut warm = entry.slot.lock().await.take()?;
        if warm.alive() { Some(warm) } else { warm.close(hub).await; None }
    }

    async fn expire(&self, generation: u64, hub: &BridgeHub) {
        let entry = {
            let mut slot = self.entry.lock().unwrap();
            if slot.as_ref().is_some_and(|e| e.generation == generation) { slot.take() } else { None }
        };
        if let Some(entry) = entry { Self::discard(entry, hub).await; }
    }
}

/// Opens adapter + session for `key`; the result is stored in `slot`.
async fn open(app: &AppHandle, key: &WarmKey) -> Result<Warm, String> {
    let command = key.agent.acp_command(env::which).ok_or("Không tìm thấy adapter.")?;
    let timeout = setup_timeout(&command.0);
    let mut child = crate::acp_tasks::spawn_adapter(&command, &key.cwd)?;
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
    let hub = app.state::<Arc<BridgeHub>>().inner().clone();
    let mut servers = user_servers(&app.state::<Store>(), key.agent);
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
    match tokio::time::timeout(timeout + Duration::from_secs(5), opened).await.unwrap_or_else(|_| Err("Adapter không trả lời kịp.".into())) {
        Ok(session_id) => Ok(Warm { child, client, late, session_id, token, notes, relay, stderr_task }),
        Err(e) => {
            let warm = Warm { child, client, late, session_id: String::new(), token, notes, relay, stderr_task };
            warm.close(&hub).await;
            Err(e)
        }
    }
}

/// Opens a session for the next message of a new conversation in `repo` (`scope`: its subfolder).
#[tauri::command]
pub async fn warm_task(app: AppHandle, agent: AgentKind, repo: String, scope: Option<String>) -> Result<(), String> {
    let root = crate::worktree::git(Path::new(&repo), &["rev-parse", "--show-toplevel"], None)?;
    let repo = dunce::canonicalize(root.trim()).map_err(|e| e.to_string())?;
    let cwd = env::scoped_dir(&repo, scope.as_deref())?;
    let key = key_for(&app.state::<Store>(), agent, &cwd);
    let pool = app.state::<WarmPool>();
    let hub = app.state::<Arc<BridgeHub>>().inner().clone();
    let replaced = {
        let mut entry = pool.entry.lock().unwrap();
        if entry.as_ref().is_some_and(|e| e.key == key) { return Ok(()); }
        entry.take()
    };
    if let Some(old) = replaced { WarmPool::discard(old, &hub).await; }
    let generation = { let mut g = pool.generation.lock().unwrap(); *g += 1; *g };
    let slot = Arc::new(tokio::sync::Mutex::new(None));
    let guard = slot.clone().lock_owned().await;
    let opening = {
        let (app, key) = (app.clone(), key.clone());
        tokio::spawn(async move {
            let mut guard = guard;
            match open(&app, &key).await {
                Ok(warm) => *guard = Some(warm),
                Err(e) => eprintln!("Không mở sẵn được phiên {}: {e}", key.agent.display_name()),
            }
        })
    };
    {
        let mut entry = pool.entry.lock().unwrap();
        // Another warm_task may have won the race while the old entry was closing.
        if let Some(other) = entry.replace(Entry { key, generation, slot, opening }) {
            tauri::async_runtime::spawn(async move { WarmPool::discard(other, &hub).await; });
        }
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WARM_TTL).await;
        let hub = app2.state::<Arc<BridgeHub>>().inner().clone();
        app2.state::<WarmPool>().expire(generation, &hub).await;
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
        Warm { child, client, late, session_id: "s".into(), token: None, notes: vec![], relay: Default::default(), stderr_task: tokio::spawn(async {}) }
    }

    fn entry(pool: &WarmPool, key: WarmKey, generation: u64, ready: Option<Warm>) -> Arc<tokio::sync::Mutex<Option<Warm>>> {
        let slot = Arc::new(tokio::sync::Mutex::new(ready));
        *pool.entry.lock().unwrap() = Some(Entry { key, generation, slot: slot.clone(), opening: tokio::spawn(async {}) });
        slot
    }

    #[tokio::test]
    async fn a_send_while_opening_waits_for_that_session() {
        let (pool, hub) = (WarmPool::default(), BridgeHub::default());
        let slot = entry(&pool, key(AgentKind::Claude), 1, None);
        let mut guard = slot.clone().lock_owned().await;
        let opening = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            *guard = Some(warm());
        });
        let taken = pool.take(&key(AgentKind::Claude), &hub).await.expect("phiên đang mở phải được chờ");
        assert_eq!(taken.session_id, "s");
        opening.await.unwrap();
        assert!(pool.entry.lock().unwrap().is_none(), "phiên chỉ được nhận một lần");
    }

    #[tokio::test]
    async fn another_key_gets_nothing_and_the_old_session_is_closed() {
        let (pool, hub) = (WarmPool::default(), BridgeHub::default());
        let slot = entry(&pool, key(AgentKind::Claude), 1, Some(warm()));
        assert!(pool.take(&key(AgentKind::Codex), &hub).await.is_none());
        assert!(slot.lock().await.is_none(), "phiên cũ phải bị đóng");
        assert!(pool.entry.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn a_dead_adapter_is_not_handed_out() {
        let (pool, hub) = (WarmPool::default(), BridgeHub::default());
        let mut dead = warm();
        dead.child.kill().await.unwrap();
        entry(&pool, key(AgentKind::Claude), 1, Some(dead));
        assert!(pool.take(&key(AgentKind::Claude), &hub).await.is_none());
    }

    #[tokio::test]
    async fn a_failed_opening_falls_back() {
        let (pool, hub) = (WarmPool::default(), BridgeHub::default());
        entry(&pool, key(AgentKind::Claude), 1, None);
        assert!(pool.take(&key(AgentKind::Claude), &hub).await.is_none());
    }

    #[tokio::test]
    async fn only_the_same_generation_expires() {
        let (pool, hub) = (WarmPool::default(), BridgeHub::default());
        entry(&pool, key(AgentKind::Claude), 2, Some(warm()));
        pool.expire(1, &hub).await;
        assert!(pool.entry.lock().unwrap().is_some(), "hết hạn của lần mở cũ không được đóng phiên mới");
        pool.expire(2, &hub).await;
        assert!(pool.entry.lock().unwrap().is_none());
    }

    #[test]
    fn the_key_follows_folder_servers_and_bridge() {
        let base = key(AgentKind::Claude);
        assert_ne!(base, WarmKey { cwd: std::env::temp_dir().join("con"), ..base.clone() });
        assert_ne!(base, WarmKey { servers: "[{}]".into(), ..base.clone() });
        assert_ne!(base, WarmKey { bridge: true, ..base.clone() });
    }
}
