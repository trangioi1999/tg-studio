//! Starts an agent as a child process in a working folder and streams every
//! output line to the UI as an `agent-event`.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::oneshot;

use crate::adapters::AgentKind;
use crate::env;
use crate::store::{NewRun, Store};
use crate::usage::{self, Usage};

const EVENT: &str = "agent-event";

/// Running agents, keyed by run id. The sender stops the run.
#[derive(Default)]
pub struct Runs(pub(crate) Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub(crate) run_id: String,
    pub(crate) agent: AgentKind,
    /// "started" | "log" | "stderr" | "usage" | "limits" | "exit" | ACP kinds
    pub(crate) kind: &'static str,
    pub(crate) line: Option<String>,
    pub(crate) usage: Option<Usage>,
    pub(crate) code: Option<i32>,
    pub(crate) data: Option<serde_json::Value>,
    pub(crate) at_ms: u64,
}

impl AgentEvent {
    pub(crate) fn new(run_id: &str, agent: AgentKind, kind: &'static str) -> Self {
        let at_ms = now_ms();
        Self {
            run_id: run_id.to_string(),
            agent,
            kind,
            line: None,
            usage: None,
            code: None,
            at_ms,
            data: None,
        }
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Writes an event to the run history. "exit" is saved through `finish_run`.
fn save_event(store: &Store, ev: &AgentEvent) -> rusqlite::Result<()> {
    match (ev.kind, &ev.line, &ev.usage) {
        ("started" | "log" | "stderr" | "user", Some(line), _) => {
            store.append_line(&ev.run_id, ev.kind, line, ev.at_ms)
        }
        ("message", _, _) => match ev.data.as_ref().and_then(|v| v["text"].as_str()) {
            Some(text) => store.append_line(&ev.run_id, "message", text, ev.at_ms),
            None => Ok(()),
        },
        ("usage", _, Some(u)) => store.add_usage(&ev.run_id, ev.at_ms, u),
        // tg-bridge activity reads like a log line when history is reopened.
        ("bridge", Some(line), _) => store.append_line(&ev.run_id, "log", line, ev.at_ms),
        ("limits", _, _) => match ev.data.as_ref().map(|v| serde_json::from_value::<Vec<crate::usage::LimitWindow>>(v["windows"].clone())) {
            Some(Ok(windows)) => store.set_limits(ev.agent, &windows, ev.at_ms),
            _ => Ok(()),
        },
        _ => Ok(()),
    }
}

fn final_status(stopped: bool, code: Option<i32>) -> &'static str {
    match (stopped, code) {
        (true, _) => "stopped",
        (false, Some(0)) => "done",
        (false, _) => "failed",
    }
}

/// History is a convenience: a storage error must never break a run.
fn log_store_error(result: rusqlite::Result<()>) {
    if let Err(e) = result {
        eprintln!("Không ghi được lịch sử lượt chạy: {e}");
    }
}

pub(crate) fn publish(app: &AppHandle, ev: AgentEvent) {
    log_store_error(save_event(&app.state::<Store>(), &ev));
    let _ = app.emit(EVENT, ev);
}

#[tauri::command]
pub async fn start_agent(
    app: AppHandle,
    runs: State<'_, Runs>,
    agent: AgentKind,
    prompt: String,
    cwd: String,
) -> Result<String, String> {
    let mut args = agent.headless_args(&prompt).ok_or_else(|| {
        format!(
            "{} chưa chạy được ở chế độ headless trong bản này — sẽ chạy qua ACP ở giai đoạn 1.",
            agent.display_name()
        )
    })?;
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("Thư mục không tồn tại: {cwd}"));
    }
    // MCP servers enabled for Claude reach headless runs too; the user's own config still applies.
    if agent == AgentKind::Claude {
        if let Some(config) = crate::mcp::claude_config(&crate::mcp::load(&app.state::<Store>())) {
            args.extend(["--mcp-config".to_string(), config]);
        }
    }
    let bin = tauri::async_runtime::spawn_blocking(move || env::which(agent.binary()))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Không tìm thấy `{}` trong PATH.", agent.binary()))?;

    let mut child = env::command(&bin)
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

    log_store_error(app.state::<Store>().insert_run(&NewRun {
        id: &run_id,
        agent,
        prompt: &prompt,
        cwd: &cwd,
        started_at: now_ms(),
    }));

    let mut started = AgentEvent::new(&run_id, agent, "started");
    started.line = Some(format!("{} · {}", bin.display(), cwd));
    publish(&app, started);

    {
        let app = app.clone();
        let id = run_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(u) = usage::parse_line(agent, &line) {
                    let mut ev = AgentEvent::new(&id, agent, "usage");
                    ev.usage = Some(u);
                    publish(&app, ev);
                }
                if let Some(windows) = usage::parse_limits(agent, &line) {
                    let mut ev = AgentEvent::new(&id, agent, "limits");
                    ev.data = Some(serde_json::json!({ "windows": windows }));
                    publish(&app, ev);
                }
                let mut ev = AgentEvent::new(&id, agent, "log");
                ev.line = Some(line);
                publish(&app, ev);
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
                publish(&app, ev);
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
            let stopped = finished.is_none();
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
            log_store_error(app.state::<Store>().finish_run(
                &id,
                final_status(stopped, code),
                code,
                ev.at_ms,
            ));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_run() -> Store {
        let store = Store::open_in_memory().unwrap();
        store
            .insert_run(&NewRun {
                id: "r",
                agent: AgentKind::Codex,
                prompt: "p",
                cwd: "/tmp",
                started_at: 1,
            })
            .unwrap();
        store
    }

    fn event(kind: &'static str, line: Option<&str>) -> AgentEvent {
        let mut ev = AgentEvent::new("r", AgentKind::Codex, kind);
        ev.line = line.map(str::to_string);
        ev
    }

    #[test]
    fn saves_lines_and_usage_but_not_exit() {
        let store = store_with_run();
        save_event(&store, &event("started", Some("s"))).unwrap();
        save_event(&store, &event("log", Some("l"))).unwrap();
        save_event(&store, &event("stderr", Some("e"))).unwrap();
        save_event(&store, &event("exit", None)).unwrap();
        let mut with_usage = event("usage", None);
        with_usage.usage = Some(Usage {
            input_tokens: 7,
            source: "tokens",
            ..Default::default()
        });
        save_event(&store, &with_usage).unwrap();

        let run = store.list_runs(1).unwrap().remove(0);
        let kinds: Vec<_> = run.lines.iter().map(|l| l.kind.as_str()).collect();
        assert_eq!(kinds, ["started", "log", "stderr"]);
        assert_eq!(run.usage.unwrap().input_tokens, 7);
        assert_eq!(run.status, "running");
    }

    #[test]
    fn acp_messages_are_persisted_as_message_lines() {
        let store = store_with_run();
        let mut message = event("message", None);
        message.data = Some(serde_json::json!({"text":"Đang sửa file\n"}));
        save_event(&store, &message).unwrap();
        let run = store.list_runs(1).unwrap().remove(0);
        assert_eq!(run.lines, vec![crate::store::StoredLine { kind: "message".into(), line: "Đang sửa file\n".into() }]);
    }

    #[test]
    fn status_follows_stop_then_exit_code() {
        assert_eq!(final_status(true, None), "stopped");
        assert_eq!(final_status(true, Some(0)), "stopped");
        assert_eq!(final_status(false, Some(0)), "done");
        assert_eq!(final_status(false, Some(2)), "failed");
        assert_eq!(final_status(false, None), "failed");
    }
}
