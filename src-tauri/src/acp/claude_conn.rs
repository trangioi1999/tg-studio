//! `claude -p --input-format stream-json --output-format stream-json` spoken in-process:
//! lines from Claude's stdout become the ACP calls and notifications `TaskSession` already
//! handles (see claude-agent-acp for the shapes), and ACP requests become stdin lines.
//! It spawns nothing: the caller hands it the process's stdout and stdin.
//!
//! `set_permission_mode`, `set_model` and `interrupt` were run against Claude CLI 2.1.332 with
//! `--permission-prompt-tool stdio --permission-prompts host` (0 tokens, not logged in):
//! after `initialize`, every one answers `success`: `set_permission_mode` with `"default"`,
//! `"manual"`, `"plan"` and `"acceptEdits"` (`manual` is accepted too, apparently without
//! being checked), `set_model` `{model:"sonnet"}`, and `interrupt` with no turn running.
//! The SDK's canonical name for asking is `"default"` (`ASK_MODE`).
//!
//! `can_use_tool`, checked on 2026-11-27 against the Agent SDK TypeScript docs
//! (code.claude.com/docs/en/agent-sdk/typescript.md: `CanUseTool`, `PermissionResult`) and
//! the package `@anthropic-ai/claude-agent-sdk` 0.3.332 (`sdk.d.ts`:
//! `SDKControlPermissionRequest`, `SDKControlResponse`; `sdk.mjs`: `processControlRequest`,
//! `handleControlRequest`). Both agree:
//! - Claude asks on stdout `{"type":"control_request","request_id":…,"request":{"subtype":
//!   "can_use_tool","tool_name":…,"input":{…},"tool_use_id":…}}`, with optional fields
//!   (`permission_suggestions`, `blocked_path`, `decision_reason`, `title`, `agent_id`…).
//! - The answer on stdin is `{"type":"control_response","response":{"subtype":"success",
//!   "request_id":…,"response":<PermissionResult>}}`, where `PermissionResult` is
//!   `{"behavior":"allow","updatedInput"?,"updatedPermissions"?,"toolUseID"?}` or
//!   `{"behavior":"deny","message","interrupt"?,"toolUseID"?}`. The SDK adds `toolUseID`
//!   (the request's `tool_use_id`); so does this file. `updatedInput` is optional in 0.3.332;
//!   it is always sent, as older CLIs required it.
//! - Claude sends these only when started with `--permission-prompt-tool stdio` (the SDK
//!   passes `--permission-prompt-tool=stdio` whenever `canUseTool` is set). Prompts do not
//!   time out. Claude may withdraw one with `{"type":"control_cancel_request","request_id"}`.

//! Subagents and rate limits, checked the same day against the same SDK types (`sdk.d.ts`:
//! `SDKTaskStartedMessage`, `SDKTaskNotificationMessage`, `SDKAssistantMessage`) and the
//! subagents page of the docs:
//! - `{"type":"system","subtype":"task_started","task_id","tool_use_id"?,"description",
//!   "task_type"?,"ambient"?,"skip_transcript"?}`: `tool_use_id` is the `Agent` tool call that
//!   spawned it. Only `local_agent` tasks (or no `task_type`) are subagents; shell and monitor
//!   tasks, and ambient ones, are not shown as runs.
//! - A subagent's `assistant`/`user` lines carry `parent_tool_use_id` (that tool call's id)
//!   and `agent_id` (= its `task_id`); `can_use_tool` carries `agent_id` too.
//! - `{"type":"system","subtype":"task_notification","task_id","status":"completed"|"failed"|
//!   "stopped"}` ends it. `task_progress` and `task_updated` are not needed.
//! - `rate_limit_event.rate_limit_info` is what claude-agent-acp puts, unchanged, in
//!   `usage_update._meta["_claude/rateLimit"]` (`usage::parse_rate_limit` reads both).
//!   Fields that are missing are ignored, never an error.

// Only tests use it until `start_task` spawns Claude this way.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};

use crate::acp::client::{ClientHandler, REQUEST_ID_KEY, WITHDRAW_PERMISSION};
use crate::acp::conn::{AgentConn, BoxFuture};
use crate::tasks::session::Approval;

const SETUP_TIMEOUT: Duration = Duration::from_secs(30);
const STOPPED: &str = "Claude đã dừng trước khi hoàn tất yêu cầu.";
/// What the model reads when a tool call is refused, whoever refused it.
const REFUSED: &str = "Người dùng đã từ chối.";
/// A tool's output in the log is cut to its last characters: a `cat` of a huge file would
/// otherwise go whole into every event, the SQLite history and the UI.
const TOOL_TEXT_LIMIT: usize = 20_000;

/// Claude's permission mode that asks before running a tool (`Approval::Ask`).
const ASK_MODE: &str = "default";

/// The session id Claude reports on its first lines, and whether stdout has closed.
#[derive(Clone, Default)]
struct SessionState { id: Option<String>, closed: bool }

pub struct ClaudeConn {
    /// Lines for stdin; `None` once `close()` dropped it, which closes stdin.
    writer: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    /// Control requests sent to Claude, by `request_id`, waiting for their `control_response`.
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    session: watch::Sender<SessionState>,
    /// The running turn, answered by its `result` (or dropped when stdout closes).
    turn: Mutex<Option<oneshot::Sender<Result<Value, String>>>>,
    /// The running turn was interrupted: its `result` ends it as `cancelled`.
    interrupted: AtomicBool,
    /// `can_use_tool` requests the handler is still deciding; Claude may withdraw them.
    asking: Mutex<HashSet<String>>,
    /// `configOptions` as ACP adapters report them (`model`), from `initialize`.
    config: Mutex<Value>,
    /// The context window figures of the latest top-level answer: tokens used, model.
    context: Mutex<(Option<u64>, Option<String>)>,
    /// The `used` and `size` of the last `usage_update`, which a rate limit update repeats.
    last_usage: Mutex<(u64, u64)>,
    /// Subagents Claude announced: the ids that name one (`task_id`, the spawning `tool_use_id`)
    /// to its `task_id`, which is its session id for `TaskSession`.
    subagents: Mutex<HashMap<String, String>>,
    handler: Arc<dyn ClientHandler>,
}

impl ClaudeConn {
    /// Đọc stdout của `claude -p`, ghi stdin. `handler` nhận mọi thứ đã dịch sang ACP.
    pub fn start<R, W>(reader: R, writer: W, handler: Arc<dyn ClientHandler>) -> Arc<ClaudeConn>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (lines, mut queued) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            let mut writer = writer;
            while let Some(bytes) = queued.recv().await {
                if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() { break; }
            }
            let _ = writer.shutdown().await;
        });
        let conn = Arc::new(ClaudeConn {
            writer: Mutex::new(Some(lines)),
            pending: Mutex::default(),
            session: watch::Sender::new(SessionState::default()),
            turn: Mutex::default(),
            interrupted: AtomicBool::new(false),
            asking: Mutex::default(),
            config: Mutex::new(Value::Null),
            context: Mutex::default(),
            last_usage: Mutex::default(),
            subagents: Mutex::default(),
            handler,
        });
        let reading = conn.clone();
        tokio::spawn(async move {
            // Bytes, not `lines()`: one line that is not UTF-8 is skipped instead of ending the reading.
            let mut reader = BufReader::new(reader);
            let mut line = Vec::new();
            while matches!(reader.read_until(b'\n', &mut line).await, Ok(n) if n > 0) {
                if let Ok(message) = serde_json::from_slice::<Value>(&line) { reading.dispatch(message); }
                line.clear();
            }
            reading.closed();
        });
        conn
    }

    fn send(&self, message: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let writer = self.writer.lock().unwrap();
        writer.as_ref().and_then(|w| w.send(bytes).ok()).ok_or_else(|| STOPPED.to_string())
    }

    /// Sends a control request and waits for the inner `response` of its answer.
    async fn control(&self, request: Value) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (reply, answer) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), reply);
        if self.session.borrow().closed {
            self.pending.lock().unwrap().remove(&id);
            return Err("Claude đã dừng.".into());
        }
        if let Err(e) = self.send(&json!({ "type": "control_request", "request_id": id, "request": request })) {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        let response = match tokio::time::timeout(SETUP_TIMEOUT, answer).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => return Err("Claude đã dừng trước khi trả lời.".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                return Err(format!("Claude không trả lời sau {} giây.", SETUP_TIMEOUT.as_secs()));
            }
        };
        if response["subtype"] == "success" { return Ok(response["response"].clone()); }
        Err(response["error"].as_str().unwrap_or("lỗi không rõ").to_string())
    }

    /// A control request nobody waits for (its answer finds no `pending` entry and is ignored).
    fn fire(&self, request: Value) -> Result<(), String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.send(&json!({ "type": "control_request", "request_id": id, "request": request }))
    }

    /// The session id from Claude's first lines, waiting up to `SETUP_TIMEOUT`.
    async fn session_id(&self) -> Result<String, String> {
        let mut state = self.session.subscribe();
        let seen = tokio::time::timeout(SETUP_TIMEOUT, state.wait_for(|s| s.id.is_some() || s.closed)).await
            .map_err(|_| format!("Claude không báo mã phiên sau {} giây.", SETUP_TIMEOUT.as_secs()))?
            .map_err(|_| "Claude đã dừng trước khi mở phiên.".to_string())?
            .clone();
        seen.id.ok_or_else(|| "Claude đã dừng trước khi mở phiên.".to_string())
    }

    fn update(&self, update: Value) { self.update_in(None, update) }

    /// An update for a subagent's session (`Some(task_id)`) or the main one.
    fn update_in(&self, subagent: Option<&str>, update: Value) {
        let session = subagent.map(str::to_string).or_else(|| self.session.borrow().id.clone());
        self.handler.on_notification("session/update", json!({ "sessionId": session, "update": update }));
    }

    fn dispatch(self: &Arc<Self>, message: Value) {
        if let Some(id) = message["session_id"].as_str().filter(|id| !id.is_empty()) {
            self.session.send_if_modified(|s| {
                if s.id.is_some() { return false; }
                s.id = Some(id.to_string());
                true
            });
        }
        match message["type"].as_str() {
            Some("control_response") => {
                let response = &message["response"];
                let waiting = response["request_id"].as_str().and_then(|id| self.pending.lock().unwrap().remove(id));
                if let Some(waiting) = waiting { let _ = waiting.send(response.clone()); }
            }
            Some("control_cancel_request") => {
                if let Some(id) = message["request_id"].as_str() {
                    if self.asking.lock().unwrap().remove(id) {
                        self.handler.on_notification(WITHDRAW_PERMISSION, json!({ "requestId": id }));
                    }
                }
            }
            Some("control_request") if message["request"]["subtype"] == "can_use_tool" => self.can_use_tool(&message),
            // Subagent output (`parent_tool_use_id`) belongs to its own run, not this reply.
            Some("stream_event") if matches!(self.owner(&message), Owner::Main) => {
                let event = &message["event"];
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta" {
                    if let Some(text) = event["delta"]["text"].as_str() {
                        self.update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } }));
                    }
                }
            }
            Some("assistant") => match self.owner(&message) {
                Owner::Main => {
                    let answer = &message["message"];
                    if answer["usage"].is_object() {
                        *self.context.lock().unwrap() = (Some(tokens(&answer["usage"])), answer["model"].as_str().map(str::to_string));
                    }
                    for block in blocks(answer, "tool_use") {
                        let mut call = tool_call_of(block);
                        call["sessionUpdate"] = json!("tool_call");
                        self.update(call);
                    }
                }
                // A subagent has no streamed text: its whole message arrives here.
                Owner::Sub(id) => {
                    for block in blocks(&message["message"], "text") {
                        if let Some(text) = block["text"].as_str().filter(|t| !t.is_empty()) {
                            self.update_in(Some(&id), json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } }));
                        }
                    }
                    for block in blocks(&message["message"], "tool_use") {
                        let mut call = tool_call_of(block);
                        call["sessionUpdate"] = json!("tool_call");
                        self.update_in(Some(&id), call);
                    }
                }
                Owner::Unknown => {}
            },
            Some("user") => {
                let target = match self.owner(&message) { Owner::Main => None, Owner::Sub(id) => Some(id), Owner::Unknown => return };
                for block in blocks(&message["message"], "tool_result") {
                    self.update_in(target.as_deref(), tool_call_update_of(block));
                }
            }
            Some("system") => self.system(&message),
            Some("rate_limit_event") => self.rate_limit(&message["rate_limit_info"]),
            Some("result") => self.result(&message),
            _ => {}
        }
    }

    /// Whose line this is: a subagent's (by `agent_id`, else the tool call that spawned it) or the main agent's.
    fn owner(&self, message: &Value) -> Owner {
        if let Some(agent) = message["agent_id"].as_str().filter(|a| !a.is_empty()) {
            self.open_subagent(agent, None);
            return Owner::Sub(agent.to_string());
        }
        match message["parent_tool_use_id"].as_str().filter(|p| !p.is_empty()) {
            None => Owner::Main,
            Some(tool) => self.subagents.lock().unwrap().get(tool).cloned().map_or(Owner::Unknown, Owner::Sub),
        }
    }

    /// Announces a subagent to `TaskSession` (which opens its nested run) unless it already did.
    fn open_subagent(&self, task: &str, title: Option<&str>) {
        if self.subagents.lock().unwrap().insert(task.to_string(), task.to_string()).is_some() { return; }
        self.subagent_state(task, "running", title);
    }

    fn subagent_state(&self, task: &str, state: &str, title: Option<&str>) {
        let mut update = json!({ "sessionUpdate": "subagent_update", "sessionId": task, "state": { "state": state } });
        if let Some(title) = title { update["title"] = json!(title); }
        self.update(update);
    }

    /// `task_started` and `task_notification`: a subagent's start and end.
    fn system(&self, message: &Value) {
        let Some(task) = message["task_id"].as_str().filter(|t| !t.is_empty()) else { return };
        match message["subtype"].as_str() {
            Some("task_started") => {
                let subagent = message["task_type"].as_str().is_none_or(|t| t == "local_agent");
                if !subagent || message["ambient"] == true || message["skip_transcript"] == true { return; }
                {
                    let mut known = self.subagents.lock().unwrap();
                    known.insert(task.to_string(), task.to_string());
                    if let Some(tool) = message["tool_use_id"].as_str().filter(|t| !t.is_empty()) { known.insert(tool.to_string(), task.to_string()); }
                }
                self.subagent_state(task, "running", message["description"].as_str().filter(|d| !d.is_empty()));
            }
            Some("task_notification") => {
                if self.subagents.lock().unwrap().contains_key(task) { self.subagent_state(task, "idle", None); }
            }
            _ => {}
        }
    }

    /// The plan's limit windows, as claude-agent-acp reports them: on a `usage_update`
    /// that repeats the last `used` and `size`.
    fn rate_limit(&self, info: &Value) {
        if !info.is_object() { return; }
        let (used, size) = *self.last_usage.lock().unwrap();
        self.update(json!({ "sessionUpdate": "usage_update", "used": used, "size": size, "_meta": { "_claude/rateLimit": info } }));
    }

    /// Claude asks before running a tool: the handler decides as for an ACP adapter's
    /// `session/request_permission` (cards, Chỉ hỏi, the forbidden list), then the answer
    /// goes back as the `control_response` of that request.
    fn can_use_tool(self: &Arc<Self>, message: &Value) {
        let Some(request_id) = message["request_id"].as_str().map(str::to_string) else { return };
        let request = &message["request"];
        let input = if request["input"].is_object() { request["input"].clone() } else { json!({}) };
        let tool_use_id = request["tool_use_id"].as_str().unwrap_or_default().to_string();
        let tool_call = tool_call_of(&json!({ "id": tool_use_id, "name": request["tool_name"], "input": input }));
        let params = json!({
            "sessionId": self.session.borrow().id,
            REQUEST_ID_KEY: request_id,
            "toolCall": tool_call,
            "options": [
                { "optionId": "allow", "kind": "allow_once", "name": "Cho phép" },
                { "optionId": "allow_always", "kind": "allow_always", "name": "Luôn cho phép" },
                { "optionId": "reject", "kind": "reject_once", "name": "Từ chối" },
            ],
        });
        self.asking.lock().unwrap().insert(request_id.clone());
        let answer = self.handler.on_request("session/request_permission".into(), params);
        let conn = self.clone();
        tokio::spawn(async move {
            let chosen = match answer.await {
                Ok(outcome) if outcome["outcome"]["outcome"] == "selected" => outcome["outcome"]["optionId"].as_str().map(str::to_string),
                _ => None,
            };
            // Withdrawn meanwhile: Claude no longer waits for an answer, and a late one would be stray.
            if !conn.asking.lock().unwrap().remove(&request_id) { return; }
            let decision = match chosen.as_deref() {
                Some("allow" | "allow_always") => json!({ "behavior": "allow", "updatedInput": input, "toolUseID": tool_use_id }),
                _ => json!({ "behavior": "deny", "message": REFUSED, "toolUseID": tool_use_id }),
            };
            // Claude may have exited meanwhile: nobody is left to answer.
            let _ = conn.send(&json!({
                "type": "control_response",
                "response": { "subtype": "success", "request_id": request_id, "response": decision },
            }));
        });
    }

    fn result(&self, result: &Value) {
        let (used, model) = self.context.lock().unwrap().clone();
        let mut usage = json!({ "sessionUpdate": "usage_update", "used": used.unwrap_or_else(|| tokens(&result["usage"])) });
        if let Some(size) = context_window(&result["modelUsage"], model.as_deref()) { usage["size"] = json!(size); }
        // Claude adds the cost up over the session, as `usage_update` carries it.
        if let Some(cost) = result["total_cost_usd"].as_f64() { usage["cost"] = json!({ "amount": cost, "currency": "USD" }); }
        *self.last_usage.lock().unwrap() = (usage["used"].as_u64().unwrap_or(0), usage["size"].as_u64().unwrap_or(0));
        self.update(usage);

        let interrupted = self.interrupted.swap(false, Ordering::SeqCst);
        let Some(turn) = self.turn.lock().unwrap().take() else { return };
        let _ = turn.send(turn_end(result, interrupted));
    }

    fn closed(&self) {
        self.session.send_modify(|s| s.closed = true);
        self.pending.lock().unwrap().clear();
        if let Some(turn) = self.turn.lock().unwrap().take() { let _ = turn.send(Err(STOPPED.into())); }
        self.handler.on_closed();
    }
}

/// Whose line a message is.
enum Owner {
    Main,
    /// A subagent, by its `task_id`.
    Sub(String),
    /// A subagent's line that names no subagent announced: dropped.
    Unknown,
}

/// Frees the turn slot when `prompt_turn` is dropped mid-turn (its caller gave up): otherwise
/// every later prompt would be refused as "busy". An interrupted turn clears it as well.
struct TurnSlot<'a> { conn: &'a ClaudeConn, armed: bool }

impl Drop for TurnSlot<'_> {
    fn drop(&mut self) {
        if !self.armed { return; }
        self.conn.turn.lock().unwrap().take();
        self.conn.interrupted.store(false, Ordering::SeqCst);
    }
}

/// The content blocks of one type in a message (`message.content` may also be a plain string).
fn blocks<'a>(message: &'a Value, kind: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
    message["content"].as_array().into_iter().flatten().filter(move |b| b["type"] == kind)
}

/// An ACP `tool_call` (without `sessionUpdate`) for one of Claude's `tool_use` blocks, with
/// the kinds and titles of claude-agent-acp's `toolInfoFromToolUse`, so `policy::tool_info`
/// and the UI read it as they read the adapter's. `_meta.claudeCode.toolName` is the tool's
/// real name, which the policy trusts over the title (tg-bridge tools).
pub fn tool_call_of(tool_use: &Value) -> Value {
    let name = tool_use["name"].as_str().unwrap_or_default();
    let input = if tool_use["input"].is_object() { tool_use["input"].clone() } else { json!({}) };
    let text = |key: &str| input[key].as_str().filter(|v| !v.is_empty()).map(str::to_string);
    // Since CLI 2.1.280 Write also takes `path` (the adapter's `normalizeWriteInput`).
    let file = text("file_path").or_else(|| if name == "Write" { text("path") } else { None });
    let diff = |old: &Value, new: &Value| json!({ "type": "diff", "path": file, "oldText": old.as_str().filter(|o| !o.is_empty()), "newText": new.as_str().unwrap_or_default() });
    let (kind, title, content) = match name {
        "Bash" | "PowerShell" => ("execute", text("command").unwrap_or_else(|| "Terminal".into()), None),
        "Read" => ("read", file.as_ref().map_or_else(|| "Read File".into(), |f| format!("Read {f}")), None),
        "Edit" => ("edit", file.as_ref().map_or_else(|| "Edit".into(), |f| format!("Edit {f}")),
            file.as_ref().map(|_| vec![diff(&input["old_string"], &input["new_string"])])),
        "MultiEdit" => ("edit", file.as_ref().map_or_else(|| "Edit".into(), |f| format!("Edit {f}")),
            file.as_ref().map(|_| input["edits"].as_array().into_iter().flatten().map(|e| diff(&e["old_string"], &e["new_string"])).collect())),
        "Write" => {
            let body = ["content", "file_text", "file_content"].iter().map(|k| &input[*k]).find(|v| v.is_string()).cloned().unwrap_or(json!(""));
            ("edit", file.as_ref().map_or_else(|| "Preparing file…".into(), |f| format!("Write {f}")),
                file.as_ref().map(|_| vec![diff(&Value::Null, &body)]))
        }
        "Grep" => {
            let mut title = "grep".to_string();
            if let Some(pattern) = text("pattern") { title.push_str(&format!(" \"{pattern}\"")); }
            if let Some(path) = text("path").or_else(|| text("file_path")) { title.push_str(&format!(" {path}")); }
            ("search", title, None)
        }
        "Glob" => {
            let parts: Vec<String> = ["path", "pattern"].iter().filter_map(|k| text(k)).map(|p| format!("`{p}`")).collect();
            ("search", std::iter::once("Find".to_string()).chain(parts).collect::<Vec<_>>().join(" "), None)
        }
        "WebFetch" => ("fetch", text("url").map_or_else(|| "Fetch".into(), |u| format!("Fetch {u}")), None),
        "WebSearch" => ("fetch", text("query").map_or_else(|| "Web search".into(), |q| format!("Search \"{q}\"")), None),
        _ => ("other", if name.is_empty() { "tool".into() } else { name.to_string() }, None),
    };
    let mut call = json!({
        "toolCallId": tool_use["id"],
        "title": title,
        "kind": kind,
        "status": "in_progress",
        "rawInput": input,
        "_meta": { "claudeCode": { "toolName": name } },
    });
    if let Some(content) = content { call["content"] = Value::Array(content); }
    if let (Some(path), true) = (&file, matches!(kind, "read" | "edit")) { call["locations"] = json!([{ "path": path }]); }
    call
}

/// The ACP `tool_call_update` for one of Claude's `tool_result` blocks: its text, cut to the
/// last `TOOL_TEXT_LIMIT` characters.
fn tool_call_update_of(result: &Value) -> Value {
    let text = match &result["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    };
    json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": result["tool_use_id"],
        "status": if result["is_error"] == true { "failed" } else { "completed" },
        "content": [{ "type": "content", "content": { "type": "text", "text": tail(&text, TOOL_TEXT_LIMIT) } }],
    })
}

/// The last `limit` characters of `text`, after "…" when something was cut.
fn tail(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    if count <= limit { return text.to_string(); }
    let start = text.char_indices().nth(count - limit).map_or(0, |(i, _)| i);
    format!("…{}", &text[start..])
}

/// Tokens of one usage object: Anthropic's `input_tokens` leaves out the cache counters.
fn tokens(usage: &Value) -> u64 {
    ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
        .iter().filter_map(|k| usage[*k].as_u64()).sum()
}

/// `contextWindow` of the model that answered last, else of any model in `modelUsage`.
fn context_window(model_usage: &Value, model: Option<&str>) -> Option<u64> {
    let all = model_usage.as_object()?;
    let matching = model.and_then(|m| all.iter().find(|(k, _)| k.starts_with(m) || m.starts_with(k.as_str())));
    matching.into_iter().chain(all.iter())
        .find_map(|(_, u)| u["contextWindow"].as_u64().filter(|w| *w > 0))
}

/// How a `result` ends the turn, as claude-agent-acp's `resultEnd` reads it. `usage` is
/// this turn's own (`modelUsage` and `total_cost_usd` add up over the session).
fn turn_end(result: &Value, interrupted: bool) -> Result<Value, String> {
    let subtype = result["subtype"].as_str().unwrap_or("success");
    let stop = if interrupted {
        "cancelled"
    } else if result["stop_reason"] == "refusal" {
        "refusal"
    } else if subtype == "error_max_turns" {
        "max_turn_requests"
    } else if result["stop_reason"] == "max_tokens" {
        "max_tokens"
    } else if result["is_error"] == true || subtype.starts_with("error") {
        let errors: Vec<&str> = result["errors"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let text = result["result"].as_str().filter(|t| !t.is_empty()).map(str::to_string)
            .unwrap_or_else(|| if errors.is_empty() { subtype.to_string() } else { errors.join(", ") });
        return Err(format!("Claude báo lỗi: {text}"));
    } else {
        "end_turn"
    };
    let u = &result["usage"];
    let n = |k: &str| u[k].as_u64().unwrap_or(0);
    Ok(json!({
        "stopReason": stop,
        "usage": {
            "inputTokens": n("input_tokens"),
            "outputTokens": n("output_tokens"),
            "cachedReadTokens": n("cache_read_input_tokens"),
            "cachedWriteTokens": n("cache_creation_input_tokens"),
        },
    }))
}

/// `available_commands_update` from the commands of `initialize`. Descriptions keep
/// Claude's ` (project)`/` (user)` suffix, as claude-agent-acp passes them on.
fn commands_update(commands: &Value) -> Value {
    let listed: Vec<Value> = commands.as_array().into_iter().flatten().filter_map(|c| {
        let name = c["name"].as_str().filter(|n| !n.is_empty() && !n.contains(char::is_whitespace))?;
        let hint = c["argumentHint"].as_str().filter(|h| !h.is_empty());
        Some(json!({ "name": name, "description": c["description"].as_str().unwrap_or(""), "input": hint.map(|h| json!({ "hint": h })) }))
    }).collect();
    json!({ "sessionUpdate": "available_commands_update", "availableCommands": listed })
}

/// The `model` select of ACP `configOptions`, from the models of `initialize`.
fn model_options(models: &Value) -> Value {
    let options: Vec<Value> = models.as_array().into_iter().flatten().filter_map(|m| {
        let value = m["value"].as_str()?;
        Some(json!({ "value": value, "name": m["displayName"].as_str().unwrap_or(value) }))
    }).collect();
    if options.is_empty() { return Value::Null; }
    let current = if options.iter().any(|o| o["value"] == "default") { json!("default") } else { options[0]["value"].clone() };
    json!([{ "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": current, "options": options }])
}

impl AgentConn for ClaudeConn {
    fn initialize(&self) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(async move {
            let init = self.control(json!({ "subtype": "initialize" })).await
                .map_err(|e| format!("Claude không khởi tạo được: {e}"))?;
            *self.config.lock().unwrap() = model_options(&init["models"]);
            self.update(commands_update(&init["commands"]));
            Ok(json!({ "agentCapabilities": { "loadSession": true, "promptCapabilities": { "image": true, "embeddedContext": true } } }))
        })
    }

    /// Claude starts its session on launch; the id comes on its first lines.
    fn new_session<'a>(&'a self, _cwd: &'a Path, _mcp: Value) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(self.session_id())
    }

    /// The session was reopened at launch (`--resume`): nothing to send, only to check.
    fn load_session<'a>(&'a self, session_id: &'a str, _cwd: &'a Path, _mcp: Value) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let running = self.session_id().await?;
            if running == session_id { Ok(()) } else { Err(format!("Claude đang mở phiên {running}, không phải {session_id}.")) }
        })
    }

    fn prompt_turn<'a>(&'a self, _session_id: &'a str, text: &'a str) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let (reply, answer) = oneshot::channel();
            {
                let mut turn = self.turn.lock().unwrap();
                if turn.is_some() { return Err("Claude đang trả lời một yêu cầu khác.".into()); }
                if self.session.borrow().closed { return Err(STOPPED.into()); }
                // Before the slot is filled: a `cancel` (which needs the slot) lands after this, never between.
                self.interrupted.store(false, Ordering::SeqCst);
                *turn = Some(reply);
            }
            let mut slot = TurnSlot { conn: self, armed: true };
            let line = json!({ "type": "user", "message": { "role": "user", "content": crate::system::attachments::claude_content(text) } });
            self.send(&line)?;
            let outcome = answer.await.unwrap_or_else(|_| Err(STOPPED.into()));
            // `result()` or `closed()` already took the slot; the guard must not touch the next turn's.
            slot.armed = false;
            outcome
        })
    }

    /// Asks Claude to stop the turn; its `result` then ends the turn as `cancelled`. With no turn
    /// running it does nothing, so a late press of Dừng cannot mislabel the next turn.
    fn cancel(&self, _session_id: &str) -> Result<(), String> {
        if self.turn.lock().unwrap().is_none() { return Ok(()); }
        self.interrupted.store(true, Ordering::SeqCst);
        self.fire(json!({ "subtype": "interrupt" }))
    }

    fn config_options(&self) -> Value { self.config.lock().unwrap().clone() }

    fn set_config_option<'a>(&'a self, _session_id: &'a str, config_id: &'a str, value: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if config_id != "model" { return Err(format!("Chưa đổi được {config_id} của Claude qua kết nối này.")); }
            self.control(json!({ "subtype": "set_model", "model": value })).await
                .map_err(|e| format!("Claude không đổi được model: {e}"))?;
            if let Some(options) = self.config.lock().unwrap().as_array_mut() {
                for option in options.iter_mut().filter(|o| o["id"] == "model") { option["currentValue"] = json!(value); }
            }
            Ok(())
        })
    }

    /// Claude's permission mode follows the app's: Chỉ hỏi is `plan`, Tự động `acceptEdits`.
    fn set_mode(&self, approval: Approval) -> Result<(), String> {
        let mode = match approval { Approval::Deny => "plan", Approval::Auto => "acceptEdits", Approval::Ask => ASK_MODE };
        self.fire(json!({ "subtype": "set_permission_mode", "mode": mode }))
    }

    /// Closes stdin: Claude exits, and stdout closing ends any running turn.
    fn close(&self) { self.writer.lock().unwrap().take(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::client::HandlerFuture;
    use crate::acp::fake_claude::{self, fake_claude, ClaudeStep};
    use crate::acp::conn::AgentConn;
    use crate::tasks::session::Approval;
    use serde_json::json;

    #[derive(Default)]
    struct Recorder { updates: Mutex<Vec<Value>> }

    impl ClientHandler for Recorder {
        fn on_notification(&self, method: &str, params: Value) {
            if method == "session/update" { self.updates.lock().unwrap().push(params["update"].clone()); }
        }
        fn on_request(&self, method: String, _params: Value) -> HandlerFuture {
            Box::pin(async move { Err(crate::acp::client::method_not_found(&method)) })
        }
        fn on_closed(&self) {}
    }

    impl Recorder {
        fn of(&self, kind: &str) -> Vec<Value> {
            self.updates.lock().unwrap().iter().filter(|u| u["sessionUpdate"] == kind).cloned().collect()
        }
    }

    async fn open(steps: Vec<ClaudeStep>) -> (Arc<ClaudeConn>, Arc<Recorder>, String) {
        let recorder = Arc::new(Recorder::default());
        let (reader, writer, _log) = fake_claude(steps);
        let conn = ClaudeConn::start(reader, writer, recorder.clone());
        conn.initialize().await.unwrap();
        let id = conn.new_session(Path::new("/tmp"), json!([])).await.unwrap();
        (conn, recorder, id)
    }

    fn result(stop: &'static str) -> ClaudeStep {
        ClaudeStep::Result { stop, usage: json!({"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}), cost: 0.01 }
    }

    #[tokio::test]
    async fn claude_conn_runs_a_turn() {
        let (conn, recorder, id) = open(vec![ClaudeStep::Text("Xin "), ClaudeStep::Text("chào"), result("success")]).await;
        let turn = conn.prompt_turn(&id, "chào Claude").await.unwrap();
        let chunks: Vec<_> = recorder.of("agent_message_chunk").iter().map(|u| u["content"]["text"].as_str().unwrap().to_string()).collect();
        assert_eq!(chunks, ["Xin ", "chào"]);
        assert!(recorder.of("agent_message_chunk").iter().all(|u| u["content"]["type"] == "text"));
        let usage = recorder.of("usage_update");
        assert_eq!(usage.len(), 1, "{usage:?}");
        assert_eq!(usage[0]["cost"]["amount"], 0.01);
        assert_eq!(usage[0]["cost"]["currency"], "USD");
        assert_eq!(usage[0]["size"], 1_000_000);
        assert_eq!(turn["stopReason"], "end_turn");
        assert_eq!(turn["usage"]["inputTokens"], 10);
        assert_eq!(turn["usage"]["outputTokens"], 5);
        assert_eq!(turn["usage"]["cachedReadTokens"], 2);
        assert_eq!(turn["usage"]["cachedWriteTokens"], 1);
        conn.close();
    }

    #[tokio::test]
    async fn claude_conn_sends_the_question_as_a_user_line() {
        let recorder = Arc::new(Recorder::default());
        let (reader, writer, log) = fake_claude(vec![result("success")]);
        let conn = ClaudeConn::start(reader, writer, recorder);
        conn.initialize().await.unwrap();
        let id = conn.new_session(Path::new("/tmp"), json!([])).await.unwrap();
        conn.prompt_turn(&id, "làm đi").await.unwrap();
        let sent = log.lock().unwrap().clone();
        assert_eq!(sent[0]["type"], "control_request");
        assert_eq!(sent[0]["request"]["subtype"], "initialize");
        assert!(sent[0]["request_id"].as_str().is_some_and(|r| !r.is_empty()));
        let user = sent.iter().find(|m| m["type"] == "user").unwrap();
        assert_eq!(user["message"]["role"], "user");
        assert_eq!(user["message"]["content"], "làm đi");
        conn.close();
    }

    #[tokio::test]
    async fn claude_conn_initialize_maps_commands_and_models() {
        let recorder = Arc::new(Recorder::default());
        let (reader, writer, _log) = fake_claude(vec![]);
        let conn = ClaudeConn::start(reader, writer, recorder.clone());
        let init = conn.initialize().await.unwrap();
        assert_eq!(init["agentCapabilities"]["loadSession"], true);
        assert_eq!(init["agentCapabilities"]["promptCapabilities"]["image"], true);
        assert_eq!(init["agentCapabilities"]["promptCapabilities"]["embeddedContext"], true);
        let commands = recorder.of("available_commands_update");
        assert_eq!(commands.len(), 1);
        let listed = commands[0]["availableCommands"].as_array().unwrap();
        assert!(listed.iter().any(|c| c["name"] == "review" && c["description"] == "Review a pull request" && c["input"]["hint"] == "[pr]"), "{listed:?}");
        // The suffix stays, so `options::parse_commands` sees a project skill.
        let parsed = crate::agents::options::parse_commands(crate::agents::adapters::AgentKind::Claude, &commands[0], None);
        assert!(parsed.iter().any(|c| c.name == "tg-demo-skill" && c.kind == "skill" && c.source.as_deref() == Some("project")), "{parsed:?}");
        let config = conn.config_options();
        assert_eq!(config[0]["id"], "model");
        assert_eq!(config[0]["type"], "select");
        assert_eq!(config[0]["currentValue"], "default");
        assert_eq!(config[0]["options"][1], json!({ "value": "sonnet", "name": "Sonnet 5.5" }));
        let id = conn.new_session(Path::new("/tmp"), json!([])).await.unwrap();
        assert_eq!(id, fake_claude::SESSION_ID);
        conn.load_session(&id, Path::new("/tmp"), json!([])).await.unwrap();
        assert!(conn.load_session("khac", Path::new("/tmp"), json!([])).await.is_err());
        conn.close();
    }

    #[tokio::test]
    async fn claude_conn_crash_mid_turn_fails_turn() {
        let (conn, recorder, id) = open(vec![ClaudeStep::Text("a"), ClaudeStep::Crash]).await;
        let error = conn.prompt_turn(&id, "x").await.unwrap_err();
        assert!(error.contains("đã dừng"), "{error}");
        assert_eq!(recorder.of("agent_message_chunk").len(), 1);
        // A later turn fails at once instead of waiting forever.
        assert!(conn.prompt_turn(&id, "y").await.is_err());
    }

    #[tokio::test]
    async fn claude_conn_ignores_unknown_messages() {
        let (conn, _recorder, id) = open(vec![
            ClaudeStep::Line(json!({"type":"brand_new","x":1})),
            ClaudeStep::Line(json!({"type":"system","subtype":"weird"})),
            result("success"),
        ]).await;
        assert_eq!(conn.prompt_turn(&id, "x").await.unwrap()["stopReason"], "end_turn");
        conn.close();
    }

    #[tokio::test]
    async fn claude_conn_maps_result_errors() {
        let (conn, _recorder, id) = open(vec![result("error_max_turns")]).await;
        assert_eq!(conn.prompt_turn(&id, "x").await.unwrap()["stopReason"], "max_turn_requests");
        conn.close();
        let (conn, recorder, id) = open(vec![result("error_during_execution")]).await;
        let error = conn.prompt_turn(&id, "x").await.unwrap_err();
        assert!(error.starts_with("Claude báo lỗi: "), "{error}");
        assert_eq!(recorder.of("usage_update").len(), 1, "cost still counts");
        conn.close();
        let refusal = json!({"type":"result","subtype":"success","is_error":false,"stop_reason":"refusal","usage":{}});
        let (conn, _recorder, id) = open(vec![ClaudeStep::Line(refusal)]).await;
        assert_eq!(conn.prompt_turn(&id, "x").await.unwrap()["stopReason"], "refusal");
        conn.close();
    }

    #[tokio::test]
    async fn claude_conn_turns_report_their_own_usage() {
        // Shapes from `tests/fixtures/claude/2.1.318/ask-session.jsonl`: `usage` is per turn,
        // `modelUsage` and `total_cost_usd` add up over the session.
        let second = json!({"input_tokens":4,"cache_creation_input_tokens":93,"cache_read_input_tokens":32758,"output_tokens":43});
        let (conn, _recorder, id) = open(vec![ClaudeStep::Result { stop: "success", usage: second, cost: 0.19 }]).await;
        conn.prompt_turn(&id, "1").await.unwrap();
        let turn = conn.prompt_turn(&id, "2").await.unwrap();
        assert_eq!(turn["usage"], json!({"inputTokens":4,"outputTokens":43,"cachedReadTokens":32758,"cachedWriteTokens":93}));
        conn.close();
    }

    fn tool_use(name: &str, input: Value) -> ClaudeStep {
        ClaudeStep::Line(json!({
            "type": "assistant",
            "message": { "role": "assistant", "content": [{ "type": "tool_use", "id": "toolu_1", "name": name, "input": input }] },
            "parent_tool_use_id": null,
            "session_id": fake_claude::SESSION_ID,
        }))
    }

    fn tool_result(content: Value, is_error: bool) -> ClaudeStep {
        ClaudeStep::Line(json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": content, "is_error": is_error }] },
            "parent_tool_use_id": null,
            "session_id": fake_claude::SESSION_ID,
        }))
    }

    #[tokio::test]
    async fn claude_conn_tool_call_and_result() {
        let (conn, recorder, id) = open(vec![tool_use("Bash", json!({"command":"npm test"})), tool_result(json!("ok"), false), result("success")]).await;
        conn.prompt_turn(&id, "chạy test").await.unwrap();
        let calls = recorder.of("tool_call");
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert_eq!(calls[0]["toolCallId"], "toolu_1");
        assert_eq!(calls[0]["kind"], "execute");
        assert_eq!(calls[0]["title"], "npm test");
        assert_eq!(calls[0]["status"], "in_progress");
        assert_eq!(calls[0]["rawInput"]["command"], "npm test");
        // `policy::tool_info` reads the tool's real name from here, as with the adapter.
        assert_eq!(calls[0]["_meta"]["claudeCode"]["toolName"], "Bash");
        let updates = recorder.of("tool_call_update");
        assert_eq!(updates.len(), 1, "{updates:?}");
        assert_eq!(updates[0]["toolCallId"], "toolu_1");
        assert_eq!(updates[0]["status"], "completed");
        assert_eq!(updates[0]["content"], json!([{ "type": "content", "content": { "type": "text", "text": "ok" } }]));
        conn.close();
    }

    #[tokio::test]
    async fn claude_conn_failed_tool_result_reads_text_blocks() {
        let blocks = json!([{ "type": "text", "text": "lỗi 1" }, { "type": "image", "source": {} }, { "type": "text", "text": "lỗi 2" }]);
        let (conn, recorder, id) = open(vec![tool_use("Read", json!({"file_path":"/a/b.rs"})), tool_result(blocks, true), result("success")]).await;
        conn.prompt_turn(&id, "x").await.unwrap();
        let update = &recorder.of("tool_call_update")[0];
        assert_eq!(update["status"], "failed");
        assert_eq!(update["content"][0]["content"]["text"], "lỗi 1\nlỗi 2");
        conn.close();
    }

    #[tokio::test]
    async fn tool_result_is_truncated() {
        let long: String = (0..1_000_000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        let (conn, recorder, id) = open(vec![tool_use("Bash", json!({"command":"cat big"})), tool_result(json!(long.clone()), false), result("success")]).await;
        conn.prompt_turn(&id, "x").await.unwrap();
        let text = recorder.of("tool_call_update")[0]["content"][0]["content"]["text"].as_str().unwrap().to_string();
        assert!(text.chars().count() <= 20_001, "{}", text.chars().count());
        assert!(text.starts_with('…'));
        assert!(long.ends_with(text.trim_start_matches('…')));
        assert_eq!(text.trim_start_matches('…').chars().count(), 20_000);
        conn.close();
    }

    #[test]
    fn tool_call_of_maps_tools_like_the_adapter() {
        let call = |name: &str, input: Value| tool_call_of(&json!({ "type": "tool_use", "id": "t", "name": name, "input": input }));
        let read = call("Read", json!({"file_path":"/r/a.rs"}));
        assert_eq!((read["kind"].as_str(), read["title"].as_str()), (Some("read"), Some("Read /r/a.rs")));
        assert_eq!(read["locations"][0]["path"], "/r/a.rs");
        let edit = call("Edit", json!({"file_path":"/r/a.rs","old_string":"a","new_string":"b"}));
        assert_eq!(edit["kind"], "edit");
        assert_eq!(edit["content"], json!([{ "type": "diff", "path": "/r/a.rs", "oldText": "a", "newText": "b" }]));
        let write = call("Write", json!({"file_path":"/r/n.md","content":"mới"}));
        assert_eq!(write["kind"], "edit");
        assert_eq!(write["title"], "Write /r/n.md");
        assert_eq!(write["content"], json!([{ "type": "diff", "path": "/r/n.md", "oldText": null, "newText": "mới" }]));
        let multi = call("MultiEdit", json!({"file_path":"/r/a.rs","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"d"}]}));
        assert_eq!(multi["kind"], "edit");
        assert_eq!(multi["content"].as_array().unwrap().len(), 2);
        assert_eq!(multi["content"][1]["newText"], "d");
        for (name, kind) in [("Grep", "search"), ("Glob", "search"), ("WebFetch", "fetch"), ("WebSearch", "fetch"), ("PowerShell", "execute"), ("mcp__x__y", "other"), ("Task", "other")] {
            assert_eq!(call(name, json!({}))["kind"], kind, "{name}");
        }
        assert_eq!(call("mcp__x__y", json!({}))["title"], "mcp__x__y");
        assert_eq!(call("Bash", json!({}))["title"], "Terminal");
        assert!(call("Bash", json!({"command":"ls"}))["content"].is_null());
    }

    #[tokio::test]
    async fn claude_conn_new_session_fails_when_claude_exits_first() {
        let recorder = Arc::new(Recorder::default());
        let (io, agent) = tokio::io::duplex(1024);
        drop(agent);
        let (reader, writer) = tokio::io::split(io);
        let conn = ClaudeConn::start(reader, writer, recorder);
        let error = tokio::time::timeout(std::time::Duration::from_secs(2), conn.new_session(Path::new("/tmp"), json!([]))).await.unwrap().unwrap_err();
        assert!(error.contains("đã dừng"), "{error}");
        assert!(conn.initialize().await.is_err());
    }

    async fn open_logged(steps: Vec<ClaudeStep>) -> (Arc<ClaudeConn>, String, fake_claude::Log) {
        let (reader, writer, log) = fake_claude(steps);
        let conn = ClaudeConn::start(reader, writer, Arc::new(Recorder::default()));
        conn.initialize().await.unwrap();
        let id = conn.new_session(Path::new("/tmp"), json!([])).await.unwrap();
        (conn, id, log)
    }

    async fn until(what: &str, mut ready: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(3), async { while !ready() { tokio::task::yield_now().await; } })
            .await.unwrap_or_else(|_| panic!("quá hạn: {what}"));
    }

    fn controls(log: &fake_claude::Log, subtype: &str) -> Vec<Value> {
        log.lock().unwrap().iter().filter(|m| m["type"] == "control_request" && m["request"]["subtype"] == subtype).cloned().collect()
    }

    #[tokio::test]
    async fn interrupt_when_idle_is_harmless() {
        let (conn, id, log) = open_logged(vec![ClaudeStep::Text("a"), result("success")]).await;
        conn.cancel(&id).unwrap();
        conn.cancel(&id).unwrap();
        assert!(controls(&log, "interrupt").is_empty(), "không có lượt thì không gửi gì");
        let turn = conn.prompt_turn(&id, "hỏi").await.unwrap();
        assert_eq!(turn["stopReason"], "end_turn");
        conn.close();
    }

    #[tokio::test]
    async fn interrupt_ends_turn_as_cancelled() {
        let (conn, id, log) = open_logged(vec![ClaudeStep::Text("a"), ClaudeStep::WaitForControl("interrupt"), result("success")]).await;
        let turn = { let conn = conn.clone(); let id = id.clone(); tokio::spawn(async move { conn.prompt_turn(&id, "dài lắm").await }) };
        until("lượt đã gửi", || log.lock().unwrap().iter().any(|m| m["type"] == "user")).await;
        conn.cancel(&id).unwrap();
        let turn = tokio::time::timeout(Duration::from_secs(3), turn).await.unwrap().unwrap().unwrap();
        assert_eq!(turn["stopReason"], "cancelled");
        assert_eq!(controls(&log, "interrupt").len(), 1);
        conn.close();
    }

    #[tokio::test]
    async fn a_dropped_prompt_frees_the_turn_slot() {
        let (conn, id, _log) = open_logged(vec![ClaudeStep::Text("a"), ClaudeStep::WaitForControl("never")]).await;
        // The caller gives up (`run_turn` stop timeout): the future is dropped mid-turn.
        assert!(tokio::time::timeout(Duration::from_millis(100), conn.prompt_turn(&id, "treo")).await.is_err());
        assert!(conn.turn.lock().unwrap().is_none());
        assert!(!conn.interrupted.load(Ordering::SeqCst));
        // The next prompt is accepted (it reaches Claude and waits), not refused as busy.
        assert!(tokio::time::timeout(Duration::from_millis(100), conn.prompt_turn(&id, "tiếp")).await.is_err());
        conn.close();
    }

    /// A new turn starts clean: the flag is reset under the `turn` lock, so only a `cancel`
    /// made after the slot is filled can mark it interrupted.
    #[tokio::test]
    async fn a_new_turn_does_not_inherit_a_stale_interrupt() {
        let (conn, _recorder, id) = open(vec![result("success")]).await;
        conn.interrupted.store(true, Ordering::SeqCst);
        assert_eq!(conn.prompt_turn(&id, "x").await.unwrap()["stopReason"], "end_turn");
        conn.close();
    }

    #[tokio::test]
    async fn set_mode_sends_permission_mode() {
        let (conn, _id, log) = open_logged(vec![]).await;
        for (approval, mode) in [(Approval::Deny, "plan"), (Approval::Auto, "acceptEdits"), (Approval::Ask, ASK_MODE)] {
            conn.set_mode(approval).unwrap();
            let want = mode.to_string();
            until("set_permission_mode", || controls(&log, "set_permission_mode").last().is_some_and(|m| m["request"]["mode"] == want.as_str())).await;
        }
        let sent: Vec<_> = controls(&log, "set_permission_mode").iter().map(|m| m["request"]["mode"].as_str().unwrap().to_string()).collect();
        assert_eq!(sent, ["plan", "acceptEdits", ASK_MODE]);
        conn.close();
    }

    #[tokio::test]
    async fn set_config_option_model_sends_set_model() {
        let (conn, id, log) = open_logged(vec![]).await;
        conn.set_config_option(&id, "model", "sonnet").await.unwrap();
        assert_eq!(controls(&log, "set_model")[0]["request"]["model"], "sonnet");
        assert_eq!(conn.config_options()[0]["currentValue"], "sonnet");
        assert!(conn.set_config_option(&id, "thought_level", "high").await.is_err());
        conn.close();
    }
}
