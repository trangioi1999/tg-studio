//! Starts an agent as a child process in a working folder and streams every
//! output line to the UI as an `agent-event`.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::adapters::AgentKind;
use crate::env;
use crate::usage::{self, Usage};

const EVENT: &str = "agent-event";

/// Running agents, keyed by run id. The sender stops the run.
#[derive(Default)]
pub struct Runs(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    run_id: String,
    agent: AgentKind,
    /// "started" | "log" | "stderr" | "usage" | "exit"
    kind: &'static str,
    line: Option<String>,
    usage: Option<Usage>,
    code: Option<i32>,
    at_ms: u64,
}

impl AgentEvent {
    fn new(run_id: &str, agent: AgentKind, kind: &'static str) -> Self {
        let at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Self {
            run_id: run_id.to_string(),
            agent,
            kind,
            line: None,
            usage: None,
            code: None,
            at_ms,
        }
    }
}

#[tauri::command]
pub async fn start_agent(
    app: AppHandle,
    runs: State<'_, Runs>,
    agent: AgentKind,
    prompt: String,
    cwd: String,
) -> Result<String, String> {
    let args = agent.headless_args(&prompt).ok_or_else(|| {
        format!(
            "{} chưa chạy được ở chế độ headless trong bản này — sẽ chạy qua ACP ở giai đoạn 1.",
            agent.display_name()
        )
    })?;
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("Thư mục không tồn tại: {cwd}"));
    }
    let bin = tauri::async_runtime::spawn_blocking(move || env::which(agent.binary()))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Không tìm thấy `{}` trong PATH.", agent.binary()))?;

    let mut child = Command::new(&bin)
        .args(&args)
        .current_dir(&cwd)
        .env("PATH", env::login_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Không chạy được {}: {e}", bin.display()))?;

    let run_id = uuid::Uuid::new_v4().to_string();
    let stdout = child.stdout.take().ok_or("Không đọc được stdout")?;
    let stderr = child.stderr.take().ok_or("Không đọc được stderr")?;
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    runs.0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), stop_tx);

    let mut started = AgentEvent::new(&run_id, agent, "started");
    started.line = Some(format!("{} · {}", bin.display(), cwd));
    let _ = app.emit(EVENT, started);

    {
        let app = app.clone();
        let id = run_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(u) = usage::parse_line(agent, &line) {
                    let mut ev = AgentEvent::new(&id, agent, "usage");
                    ev.usage = Some(u);
                    let _ = app.emit(EVENT, ev);
                }
                let mut ev = AgentEvent::new(&id, agent, "log");
                ev.line = Some(line);
                let _ = app.emit(EVENT, ev);
            }
        });
    }
    {
        let app = app.clone();
        let id = run_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut ev = AgentEvent::new(&id, agent, "stderr");
                ev.line = Some(line);
                let _ = app.emit(EVENT, ev);
            }
        });
    }
    {
        let app = app.clone();
        let id = run_id.clone();
        tauri::async_runtime::spawn(async move {
            let finished = tokio::select! {
                status = child.wait() => Some(status),
                _ = stop_rx => None,
            };
            let code = match finished {
                Some(status) => status.ok().and_then(|s| s.code()),
                None => {
                    let _ = child.kill().await;
                    None
                }
            };
            if let Ok(mut map) = app.state::<Runs>().0.lock() {
                map.remove(&id);
            }
            let mut ev = AgentEvent::new(&id, agent, "exit");
            ev.code = code;
            let _ = app.emit(EVENT, ev);
        });
    }

    Ok(run_id)
}

#[tauri::command]
pub fn stop_agent(runs: State<'_, Runs>, run_id: String) -> Result<(), String> {
    let sender = runs.0.lock().map_err(|e| e.to_string())?.remove(&run_id);
    match sender {
        Some(tx) => {
            let _ = tx.send(());
            Ok(())
        }
        None => Err("Lượt chạy này đã kết thúc.".into()),
    }
}
