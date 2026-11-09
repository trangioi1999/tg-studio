//! Starts an agent as a child process in a working folder and streams every
//! output line to the UI as an `agent-event`.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// A headless run whose process stays open for the next question (Claude reads them as
/// JSON lines on stdin). Closing `input` ends the process after its current answer.
pub struct HeadlessSession {
    agent: AgentKind,
    input: Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>,
    busy: AtomicBool,
    /// Bumped by every question and every answer, so a stale idle timer does nothing.
    generation: AtomicU64,
}

impl HeadlessSession {
    /// Hands a question to the process unless it is still answering. `before` runs once the
    /// question is accepted but before the CLI sees it, so the UI hears of the question
    /// before any answer. Err: what to tell the user.
    fn ask(&self, prompt: &str, before: impl FnOnce()) -> Result<(), String> {
        // One lock with the idle timer: it never closes the input between check and send.
        let input = self.input.lock().unwrap();
        let Some(tx) = input.as_ref().filter(|tx| !tx.is_closed()) else { return Err("Phiên này đã đóng.".into()) };
        if self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err("Agent đang chạy. Hãy chờ hoặc dừng trước.".into());
        }
        self.generation.fetch_add(1, Ordering::SeqCst);
        before();
        if tx.send(self.agent.headless_input(prompt).unwrap_or_default()).is_err() {
            self.busy.store(false, Ordering::SeqCst);
            return Err("Phiên này đã đóng.".into());
        }
        Ok(())
    }

    /// The answer is complete. Returns the generation an idle timer must still see to close.
    fn answered(&self) -> u64 {
        let _input = self.input.lock().unwrap();
        self.busy.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Ends the process after its answer, unless a question came after `generation`.
    fn close_if_idle(&self, generation: u64) -> bool {
        let mut input = self.input.lock().unwrap();
        let idle = self.generation.load(Ordering::SeqCst) == generation && !self.busy.load(Ordering::SeqCst);
        if idle { input.take(); }
        idle
    }

    #[cfg(test)]
    fn close(&self) { self.input.lock().unwrap().take(); }
}

#[derive(Default)]
pub struct HeadlessSessions(pub(crate) Mutex<HashMap<String, Arc<HeadlessSession>>>);

/// A live headless session closes after this long without a question, like an ACP session.
const IDLE_LIMIT: Duration = Duration::from_secs(30 * 60);

/// `Some(status)` when this stdout line ends one answer of a live Claude session.
fn turn_status(line: &str) -> Option<&'static str> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    (v["type"] == "result").then(|| if v["is_error"] == true { "failed" } else { "done" })
}

/// The next question of an open headless session. `None`: no such session (an ACP run).
pub(crate) fn send_headless(app: &AppHandle, run_id: &str, prompt: &str) -> Option<Result<(), String>> {
    let session = app.state::<HeadlessSessions>().0.lock().ok()?.get(run_id).cloned()?;
    Some(session.ask(prompt, || {
        log_store_error(app.state::<Store>().set_run_status(run_id, "running"));
        let mut ev = AgentEvent::new(run_id, session.agent, "user");
        ev.line = Some(prompt.to_string());
        publish(app, ev);
    }))
}

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

use crate::clock::now_ms;

/// Claude's partial-message line (`--include-partial-messages`).
fn is_stream_chunk(line: &str) -> bool {
    line.starts_with(r#"{"type":"stream_event""#)
}

/// Writes an event to the run history. "exit" is saved through `finish_run`.
fn save_event(store: &Store, ev: &AgentEvent) -> rusqlite::Result<()> {
    // A streamed chunk is repeated whole by the final `assistant` line, which is kept.
    if ev.kind == "log" && ev.line.as_deref().is_some_and(is_stream_chunk) { return Ok(()); }
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
    thread: Option<String>,
    resume_from: Option<String>,
    scope: Option<String>,
    prefs: Option<crate::options::SessionPrefs>,
) -> Result<String, String> {
    let unsupported = || format!("{} chưa hỗ trợ quyền Chỉ hỏi. Chọn quyền Sửa code để dùng agent này.", agent.display_name());
    if agent.headless_args(&prompt).is_none() { return Err(unsupported()); }
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("Thư mục không tồn tại: {cwd}"));
    }
    let bin = tauri::async_runtime::spawn_blocking(move || env::which(agent.binary()))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Không tìm thấy `{}` trong PATH.", agent.binary()))?;

    let (mut args, input) = agent.headless_invocation(&prompt, &bin).ok_or_else(unsupported)?;
    // The next question of a conversation continues the CLI's session, if it was this agent's.
    if let Some((owner, Some(session), _)) = resume_from.as_deref().and_then(|run| app.state::<Store>().session_of(run).ok()) {
        if serde_json::to_value(agent).ok().and_then(|v| v.as_str().map(|s| s == owner)).unwrap_or(false) {
            args = agent.resume_args(args, &session);
        }
    }
    // Model and effort go right after the first word (`-p` / `exec`), before any subcommand or prompt.
    let flags = crate::options::headless_flags(agent, &prefs.unwrap_or_default());
    if !flags.is_empty() { args.splice(1..1, flags); }
    // MCP servers enabled for Claude reach headless runs too; the user's own config still applies.
    if agent == AgentKind::Claude {
        if let Some(config) = crate::mcp::claude_config(&crate::mcp::load(&app.state::<Store>())) {
            args.extend(["--mcp-config".to_string(), config]);
        }
    }
    let mut command = env::command(&bin);
    command.args(&args).current_dir(env::scoped_dir(std::path::Path::new(&cwd), scope.as_deref())?).env("PATH", env::login_path())
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    env::isolate(&mut command);
    let mut child = command.spawn().map_err(|e| format!("Không chạy được {}: {e}", bin.display()))?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let registration = crate::resources::Registration::new(child.id(), crate::resources::Owner::Run(run_id.clone()));
    // A live session keeps stdin open and writes each question as it comes.
    let live = agent.headless_input("").is_some();
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let _ = tx.send(text);
        if live {
            let session = Arc::new(HeadlessSession { agent, input: Mutex::new(Some(tx)), busy: AtomicBool::new(true), generation: AtomicU64::new(0) });
            app.state::<HeadlessSessions>().0.lock().map_err(|e| e.to_string())?.insert(run_id.clone(), session);
        } else {
            drop(tx);
        }
        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Some(text) = rx.recv().await {
                if stdin.write_all(text.as_bytes()).await.is_err() || stdin.flush().await.is_err() { break; }
            }
            let _ = stdin.shutdown().await;
        });
    }
    let pid = child.id();

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

    if let Some(thread) = &thread { log_store_error(app.state::<Store>().set_run_thread(&run_id, thread, scope.as_deref())); }
    let mut started = AgentEvent::new(&run_id, agent, "started");
    started.line = Some(format!("{} · {}", bin.display(), cwd));
    publish(&app, started);

    {
        let app = app.clone();
        let id = run_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut session_saved = false;
            let mut totals = usage::SessionTotals::default();
            let session = app.state::<HeadlessSessions>().0.lock().ok().and_then(|s| s.get(&id).cloned());
            while let Ok(Some(line)) = lines.next_line().await {
                if !session_saved {
                    if let Some(session) = usage::headless_session_id(agent, &line) {
                        log_store_error(app.state::<Store>().set_acp_session(&id, &session));
                        session_saved = true;
                    }
                }
                if let Some(u) = usage::parse_line(agent, &line) {
                    let mut ev = AgentEvent::new(&id, agent, "usage");
                    // Each answer of a live session reports its own tokens.
                    ev.usage = Some(if session.is_some() { totals.add(&u) } else { u });
                    publish(&app, ev);
                }
                if let Some(windows) = usage::parse_limits(agent, &line) {
                    let mut ev = AgentEvent::new(&id, agent, "limits");
                    ev.data = Some(serde_json::json!({ "windows": windows }));
                    publish(&app, ev);
                }
                let ended = session.as_ref().and(turn_status(&line));
                let mut ev = AgentEvent::new(&id, agent, "log");
                ev.line = Some(line);
                publish(&app, ev);
                if let (Some(status), Some(session)) = (ended, &session) {
                    let generation = session.answered();
                    // Under the sessions lock: once `exit` has removed the session, its
                    // final status must not be turned back into `idle`.
                    if let Ok(open) = app.state::<HeadlessSessions>().0.lock() {
                        if open.contains_key(&id) {
                            log_store_error(app.state::<Store>().set_run_status(&id, "idle"));
                            let mut ev = AgentEvent::new(&id, agent, "turn_end");
                            ev.data = Some(serde_json::json!({ "status": status }));
                            publish(&app, ev);
                        }
                    }
                    let session = session.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(IDLE_LIMIT).await;
                        session.close_if_idle(generation);
                    });
                }
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
            let registration = registration;
            let finished = tokio::select! {
                status = child.wait() => Some(status),
                _ = stop_rx => None,
            };
            let stopped = finished.is_none();
            let code = match finished {
                Some(status) => status.ok().and_then(|s| s.code()),
                None => {
                    if let Some(pid) = pid { env::kill_tree(pid).await; }
                    let _ = child.kill().await;
                    None
                }
            };
            drop(registration);
            if let Ok(mut map) = app.state::<Runs>().0.lock() {
                map.remove(&id);
            }
            if let Ok(mut map) = app.state::<HeadlessSessions>().0.lock() {
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

#[tauri::command(async)]
pub fn stop_agent(runs: State<'_, Runs>, delegations: State<'_, std::sync::Arc<crate::delegate::Delegations>>, run_id: String) -> Result<(), String> {
    // Stopping an agent stops the agents it delegated to as well.
    for d in delegations.of_parent(&run_id).into_iter().filter(|d| d.active()) {
        if let Some(child) = &d.child {
            if let Some(tx) = runs.0.lock().map_err(|e| e.to_string())?.remove(child) { let _ = tx.send(()); }
        }
    }
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

    /// Partial messages only show the answer as it is written; its final `assistant` line
    /// has the whole text, so history keeps that and none of the dozens of chunks.
    #[test]
    fn streamed_chunks_are_shown_but_not_saved() {
        let store = store_with_run();
        let fixture = include_str!("../tests/fixtures/claude/2.1.318/ask-session.jsonl");
        for line in fixture.lines() { save_event(&store, &event("log", Some(line))).unwrap(); }
        let saved = store.list_runs(1).unwrap().remove(0).lines;
        assert!(saved.iter().all(|l| !l.line.contains("\"stream_event\"")));
        assert_eq!(saved.len(), fixture.lines().filter(|l| !l.contains("\"type\":\"stream_event\"")).count());
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

    fn live(busy: bool) -> (HeadlessSession, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (HeadlessSession { agent: AgentKind::Claude, input: Mutex::new(Some(tx)), busy: AtomicBool::new(busy), generation: AtomicU64::new(0) }, rx)
    }

    #[test]
    fn a_live_session_takes_one_question_at_a_time() {
        let (session, mut rx) = live(true);
        assert_eq!(session.ask("hai", || {}).unwrap_err(), "Agent đang chạy. Hãy chờ hoặc dừng trước.");
        assert!(rx.try_recv().is_err(), "không được ghi chồng khi đang trả lời");
        session.answered();
        session.ask("hai", || {}).unwrap();
        let line: serde_json::Value = serde_json::from_str(rx.try_recv().unwrap().trim()).unwrap();
        assert_eq!(line["message"]["content"], "hai");
        assert!(session.ask("ba", || {}).is_err());
    }

    #[test]
    fn a_closed_session_refuses_questions_and_frees_itself() {
        let (session, _rx) = live(false);
        session.close();
        assert_eq!(session.ask("hai", || {}).unwrap_err(), "Phiên này đã đóng.");
        session.answered();
        let (session, rx) = live(false);
        drop(rx);
        assert_eq!(session.ask("hai", || {}).unwrap_err(), "Phiên này đã đóng.", "tiến trình đã thoát");
        assert!(!session.busy.load(Ordering::SeqCst));
    }

    #[test]
    fn a_question_after_an_answer_cancels_its_idle_timer() {
        let (session, mut rx) = live(true);
        let timer = session.answered();
        session.ask("hai", || {}).unwrap();
        assert!(!session.close_if_idle(timer), "câu mới phải huỷ hẹn giờ cũ");
        assert!(rx.try_recv().is_ok());
        let later = session.answered();
        assert!(session.close_if_idle(later));
        assert_eq!(session.ask("ba", || {}).unwrap_err(), "Phiên này đã đóng.");
    }

    #[test]
    fn the_question_is_announced_before_the_cli_sees_it() {
        let (session, mut rx) = live(false);
        let mut seen_before = None;
        session.ask("hai", || seen_before = Some(rx.try_recv().is_err())).unwrap();
        assert_eq!(seen_before, Some(true));
        let mut called = false;
        assert!(session.ask("ba", || called = true).is_err());
        assert!(!called, "câu bị từ chối thì không báo lên UI");
    }

    #[test]
    fn every_result_ends_one_answer_of_the_fixture() {
        let fixture = include_str!("../tests/fixtures/claude/2.1.318/ask-session.jsonl");
        assert_eq!(fixture.lines().filter_map(turn_status).collect::<Vec<_>>(), ["done", "done"]);
        assert_eq!(turn_status(r#"{"type":"result","is_error":true}"#), Some("failed"));
        assert_eq!(turn_status("không phải json"), None);
    }

    /// The CLI contract a live ask session relies on, with the real Claude Code:
    /// questions on stdin, one `result` per answer, memory across answers, nothing written.
    /// Writing being refused is `live_read_only_run_cannot_write`.
    /// `TG_LIVE_ACP=1 cargo test live_claude_ask_session -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_claude_ask_session_two_questions() {
        if std::env::var("TG_LIVE_ACP").is_err() { return; }
        use tokio::io::AsyncWriteExt;
        let dir = std::env::temp_dir().join(format!("tg-ask-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "màu yêu thích: xanh lá\n").unwrap();
        let program = env::which("claude").expect("claude CLI");
        let (args, first) = AgentKind::Claude.headless_invocation("Đọc a.txt rồi cho biết màu yêu thích ghi trong đó.", &program).unwrap();
        let mut child = env::command(&program).args(&args).current_dir(&dir).env("PATH", env::login_path())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(first.unwrap().as_bytes()).await.unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let (mut answers, mut totals, mut text) = (Vec::new(), usage::SessionTotals::default(), String::new());
        let mut last = None;
        let mut asked = std::time::Instant::now();
        while let Some(line) = lines.next_line().await.unwrap() {
            let v: serde_json::Value = serde_json::from_str(&line).unwrap();
            if v["type"] == "stream_event" && v["event"]["delta"]["type"] == "text_delta" && text.is_empty() {
                eprintln!("chữ đầu sau {:?}", asked.elapsed());
            }
            if v["type"] == "stream_event" { if let Some(t) = v["event"]["delta"]["text"].as_str() { text.push_str(t); } }
            if let Some(u) = usage::parse_line(AgentKind::Claude, &line) { last = Some(totals.add(&u)); }
            if let Some(status) = turn_status(&line) {
                answers.push((status, std::mem::take(&mut text)));
                if answers.len() == 1 {
                    asked = std::time::Instant::now();
                    stdin.write_all(AgentKind::Claude.headless_input("Màu bạn vừa nói là màu gì? Chỉ ghi tên màu.").unwrap().as_bytes()).await.unwrap();
                } else {
                    drop(stdin);
                    break;
                }
            }
        }
        let code = child.wait().await.unwrap();
        eprintln!("{answers:?} {last:?}");
        assert_eq!(answers.iter().map(|a| a.0).collect::<Vec<_>>(), ["done", "done"]);
        assert!(answers[1].1.to_lowercase().contains("xanh"), "câu hai phải nhớ câu một: {:?}", answers[1].1);
        assert!(code.success(), "đóng stdin thì CLI thoát bình thường");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "Chỉ hỏi không được ghi gì vào thư mục");
        let last = last.unwrap();
        assert!(last.cumulative && last.output_tokens > 0 && last.cost_usd.is_some());
        let _ = std::fs::remove_dir_all(dir);
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
