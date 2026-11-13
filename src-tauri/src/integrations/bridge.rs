//! tg-bridge: a small MCP server TG Studio gives every code task, so agents from
//! different vendors coordinate through one channel (`docs/05` §6).
//!
//! The agent spawns this same executable with `--mcp-bridge` (stdio MCP). That
//! process forwards each tool call over a loopback TCP socket to the app, with a
//! token issued per run. The app answers from the run's own context. A handoff only
//! proposes and `request_approval` shows a card; `delegate` starts another agent on part
//! of the task, asking the user first unless the session runs in Tự động.

use std::{collections::HashMap, future::Future, pin::Pin, sync::{Arc, Mutex}};

use serde_json::{json, Value};
use tokio::{io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader}, net::{TcpListener, TcpStream}};

use crate::agents::adapters::AgentKind;

pub const FLAG: &str = "--mcp-bridge";
pub const SERVER_NAME: &str = "tg-bridge";
const PROTOCOL: &str = "2025-06-18";
const MAX_TOPIC: usize = 100;
const MAX_TEXT: usize = 20_000;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// What the tools may do inside one run. The app implements it per task; tests fake it.
pub trait ToolEnv: Send + Sync {
    /// A bridge event for the UI: progress, notes, handoff proposals.
    fn emit(&self, data: Value, line: String);
    fn add_note(&self, topic: &str, text: &str) -> Result<(), String>;
    /// (topic, agent, at_ms, text), oldest first.
    fn notes(&self, topic: Option<&str>) -> Result<Vec<(String, String, u64, String)>, String>;
    /// Shows an approval card; resolves to true only if the user allowed it.
    fn approve(&self, action: String, reason: String) -> BoxFuture<bool>;
    fn context(&self) -> Value;
    /// Starts another agent on part of the task; resolves to its report (`Delegation::report`).
    fn delegate(&self, _agent: AgentKind, _task: String, _files: Vec<String>) -> BoxFuture<Result<Value, String>> {
        Box::pin(async { Err("Phiên này không giao việc cho agent khác được.".to_string()) })
    }
    /// Reports of this run's delegations (only `ids` if given), once none is still going or after `timeout`.
    fn wait_delegated(&self, _ids: Vec<String>, _timeout: std::time::Duration) -> BoxFuture<Result<Value, String>> {
        Box::pin(async { Err("Phiên này không giao việc cho agent khác được.".to_string()) })
    }
    /// The parent settled a delegation's conflicts itself: its draft can go.
    fn resolve_delegated(&self, _id: String) -> Result<String, String> {
        Err("Phiên này không giao việc cho agent khác được.".into())
    }
}

/// Tools only a top-level agent has: a delegated agent cannot delegate or hand off further.
const PARENT_ONLY: [&str; 4] = ["delegate", "wait_delegated", "resolve_delegated", "handoff_to"];

/// The tools a session lists; `child` for an agent working on a delegated piece.
pub fn tools_for(child: bool) -> Value {
    let all = tools();
    if !child { return all; }
    Value::Array(all.as_array().unwrap().iter().filter(|t| !PARENT_ONLY.contains(&t["name"].as_str().unwrap_or(""))).cloned().collect())
}

pub fn tools() -> Value {
    let obj = |props: Value, required: &[&str]| json!({ "type": "object", "properties": props, "required": required });
    json!([
        { "name": "report_progress", "description": "Report what step you are on so the user sees it in TG Studio's timeline. Cheap; call it at each milestone.",
          "inputSchema": obj(json!({ "step": {"type":"string"}, "pct": {"type":"number","minimum":0,"maximum":100}, "note": {"type":"string"} }), &["step"]) },
        { "name": "handoff_to", "description": "Propose moving the rest of the conversation to another agent (claude, codex, gemini, kiro), which then takes over from you. Only when the user wants to switch agents. To have another agent do a task or a part of one (\"give X to Kiro\", \"let Codex write the tests\"), use delegate instead. The user decides; nothing runs until they accept.",
          "inputSchema": obj(json!({ "agent": {"type":"string","enum":["claude","codex","gemini","kiro"]}, "task": {"type":"string"}, "files": {"type":"array","items":{"type":"string"}} }), &["agent", "task"]) },
        { "name": "read_notes", "description": "Read the task's shared notes (plan, decisions, conventions) written by any agent on this task.",
          "inputSchema": obj(json!({ "topic": {"type":"string"} }), &[]) },
        { "name": "write_note", "description": "Write a shared note for this task that the other agents on it can read.",
          "inputSchema": obj(json!({ "topic": {"type":"string"}, "text": {"type":"string"} }), &["topic", "text"]) },
        { "name": "request_approval", "description": "Ask the user to approve an action outside your task's scope. Waits for their answer: approved or denied.",
          "inputSchema": obj(json!({ "action": {"type":"string"}, "reason": {"type":"string"} }), &["action", "reason"]) },
        { "name": "get_task_context", "description": "The task description, pipeline step and files changed so far in this worktree.",
          "inputSchema": obj(json!({}), &[]) },
        { "name": "delegate", "description": "Start another agent (claude, codex, gemini, kiro) on a task or an independent part of yours, in parallel with you; you stay in charge and get its result. Use this whenever the user asks you to give work to another agent. When you work right in the user's folder it works there too, at the same time as you: give each agent its own files. When you work in a draft it gets its own copy, merged back into yours when it finishes. Returns at once with an id; call wait_delegated for the result. Give a self-contained task and list the files it should touch. At most 3 at a time. In the user's Hỏi trước mode the user is asked first.",
          "inputSchema": obj(json!({ "agent": {"type":"string","enum":["claude","codex","gemini","kiro"]}, "task": {"type":"string"}, "files": {"type":"array","items":{"type":"string"}} }), &["agent", "task"]) },
        { "name": "wait_delegated", "description": "Wait (at most timeout_s, max 50) until your delegated tasks finish, then get each one's status, summary, files_changed and conflicts. Call again while any is still running. A conflict means that file was not merged: read child_worktree/<file>, merge it into your file yourself, then call resolve_delegated.",
          "inputSchema": obj(json!({ "ids": {"type":"array","items":{"type":"string"}}, "timeout_s": {"type":"number","minimum":1,"maximum":50} }), &[]) },
        { "name": "resolve_delegated", "description": "After you merged a delegated task's conflicting files yourself: removes its copy of the folder.",
          "inputSchema": obj(json!({ "id": {"type":"string"} }), &["id"]) },
    ])
}

fn text_arg<'a>(args: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    let v = args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Thiếu tham số {key}."))?;
    if v.chars().count() > max { return Err(format!("{key} dài quá {max} ký tự.")); }
    Ok(v)
}

/// Runs one tool for one run. Errors become MCP tool errors the agent can read.
pub async fn call_tool(env: &dyn ToolEnv, tool: &str, args: &Value) -> Result<String, String> {
    match tool {
        "report_progress" => {
            let step = text_arg(args, "step", 200)?;
            let pct = args.get("pct").and_then(Value::as_f64).filter(|p| p.is_finite()).map(|p| p.clamp(0.0, 100.0));
            let note = args.get("note").and_then(Value::as_str).map(|n| n.chars().take(500).collect::<String>());
            let line = format!("◆ tg-bridge · {step}{}{}", pct.map(|p| format!(" ({p:.0}%)")).unwrap_or_default(), note.as_deref().map(|n| format!(" — {n}")).unwrap_or_default());
            env.emit(json!({ "tool": tool, "step": step, "pct": pct, "note": note }), line);
            Ok("Đã ghi tiến độ.".into())
        }
        "write_note" => {
            let topic = text_arg(args, "topic", MAX_TOPIC)?;
            let text = text_arg(args, "text", MAX_TEXT)?;
            env.add_note(topic, text)?;
            env.emit(json!({ "tool": tool, "topic": topic }), format!("◆ tg-bridge · ghi chú \"{topic}\""));
            Ok(format!("Đã lưu ghi chú \"{topic}\"."))
        }
        "read_notes" => {
            let topic = args.get("topic").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
            let notes = env.notes(topic)?;
            if notes.is_empty() { return Ok("Chưa có ghi chú nào.".into()); }
            Ok(notes.iter().map(|(t, agent, _, text)| format!("## {t} ({agent})\n{text}")).collect::<Vec<_>>().join("\n\n"))
        }
        "handoff_to" => {
            let agent = text_arg(args, "agent", 20)?;
            serde_json::from_value::<AgentKind>(Value::String(agent.into())).map_err(|_| format!("Không có agent {agent}."))?;
            let task = text_arg(args, "task", MAX_TEXT)?;
            let files: Vec<String> = args.get("files").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).take(50).map(String::from).collect()).unwrap_or_default();
            let id = uuid::Uuid::new_v4().to_string();
            env.emit(json!({ "tool": tool, "id": id, "agent": agent, "task": task, "files": files }), format!("◆ tg-bridge · đề xuất chuyển cho {agent}: {}", task.chars().take(120).collect::<String>()));
            Ok("Đã gửi đề xuất chuyển việc cho người dùng duyệt. Chưa có gì được chạy; hãy tiếp tục hoặc kết thúc phần việc của bạn.".into())
        }
        "request_approval" => {
            let action = text_arg(args, "action", 500)?.to_string();
            let reason = text_arg(args, "reason", 2000)?.to_string();
            Ok(if env.approve(action, reason).await { "approved".into() } else { "denied".into() })
        }
        "get_task_context" => Ok(serde_json::to_string_pretty(&env.context()).unwrap_or_default()),
        "delegate" => {
            let agent = text_arg(args, "agent", 20)?;
            let kind = serde_json::from_value::<AgentKind>(Value::String(agent.into())).map_err(|_| format!("Không có agent {agent}."))?;
            let task = text_arg(args, "task", MAX_TEXT)?.to_string();
            let files: Vec<String> = args.get("files").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).take(50).map(String::from).collect()).unwrap_or_default();
            let report = env.delegate(kind, task, files).await?;
            Ok(serde_json::to_string_pretty(&report).unwrap_or_default())
        }
        "wait_delegated" => {
            let ids: Vec<String> = args.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
            let secs = args.get("timeout_s").and_then(Value::as_f64).filter(|s| s.is_finite()).unwrap_or(50.0).clamp(1.0, 50.0);
            let reports = env.wait_delegated(ids, std::time::Duration::from_secs_f64(secs)).await?;
            Ok(serde_json::to_string_pretty(&reports).unwrap_or_default())
        }
        "resolve_delegated" => env.resolve_delegated(text_arg(args, "id", 100)?.to_string()),
        _ => Err(format!("Không có tool {tool}.")),
    }
}

// ---------------------------------------------------------------- app side

/// Loopback endpoint the bridge processes call into. One per app; runs register a token.
#[derive(Default)]
pub struct BridgeHub {
    addr: tokio::sync::Mutex<Option<String>>,
    envs: Mutex<HashMap<String, Option<Arc<dyn ToolEnv>>>>,
}

impl BridgeHub {
    /// Starts listening on 127.0.0.1 the first time; returns the address.
    pub async fn address(self: &Arc<Self>) -> Result<String, String> {
        let mut addr = self.addr.lock().await;
        if let Some(a) = addr.as_ref() { return Ok(a.clone()); }
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("Không mở được cổng tg-bridge: {e}"))?;
        let bound = listener.local_addr().map_err(|e| e.to_string())?.to_string();
        let hub = self.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let hub = hub.clone();
                tokio::spawn(async move { let _ = hub.serve(stream).await; });
            }
        });
        *addr = Some(bound.clone());
        Ok(bound)
    }

    /// A fresh unguessable token for one run.
    pub fn register(&self, env: Arc<dyn ToolEnv>) -> String {
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        self.envs.lock().unwrap().insert(token.clone(), Some(env));
        token
    }

    /// Reserves a token; tool calls are refused until its environment is bound.
    pub fn reserve(&self) -> String {
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        self.envs.lock().unwrap().insert(token.clone(), None);
        token
    }

    /// Binds a reserved token exactly once, while it is still registered.
    pub fn bind(&self, token: &str, env: Arc<dyn ToolEnv>) -> Result<(), String> {
        let mut envs = self.envs.lock().unwrap();
        match envs.get_mut(token) {
            Some(slot @ None) => { *slot = Some(env); Ok(()) }
            Some(Some(_)) => Err("Phiên tg-bridge đã được gắn môi trường.".into()),
            None => Err("Phiên tg-bridge không còn hiệu lực.".into()),
        }
    }

    pub fn unregister(&self, token: &str) {
        self.envs.lock().unwrap().remove(token);
    }

    async fn serve(&self, stream: TcpStream) -> std::io::Result<()> {
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let Some(line) = lines.next_line().await? else { return Ok(()) };
        let reply = match serde_json::from_str::<Value>(&line) {
            Err(_) => json!({ "ok": false, "error": "Yêu cầu không hợp lệ." }),
            Ok(req) => {
                let env = req["token"].as_str().and_then(|t| self.envs.lock().unwrap().get(t).cloned().flatten());
                match env {
                    None => json!({ "ok": false, "error": "Phiên tg-bridge không còn hiệu lực." }),
                    Some(env) => match call_tool(env.as_ref(), req["tool"].as_str().unwrap_or(""), &req["args"]).await {
                        Ok(text) => json!({ "ok": true, "text": text }),
                        Err(e) => json!({ "ok": false, "error": e }),
                    },
                }
            }
        };
        write.write_all(format!("{reply}\n").as_bytes()).await?;
        write.shutdown().await
    }
}

// ---------------------------------------------------------------- bridge process

async fn forward(addr: &str, token: &str, tool: &str, args: &Value) -> Result<String, String> {
    let stream = TcpStream::connect(addr).await.map_err(|e| format!("Không kết nối được TG Studio: {e}"))?;
    let (read, mut write) = stream.into_split();
    write.write_all(format!("{}\n", json!({ "token": token, "tool": tool, "args": args })).as_bytes()).await.map_err(|e| e.to_string())?;
    let line = BufReader::new(read).lines().next_line().await.map_err(|e| e.to_string())?.ok_or("TG Studio đóng kết nối.")?;
    let reply: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    if reply["ok"] == true { Ok(reply["text"].as_str().unwrap_or_default().to_string()) } else { Err(reply["error"].as_str().unwrap_or("Lỗi không rõ.").to_string()) }
}

/// The stdio MCP server an agent talks to. Newline-delimited JSON-RPC 2.0.
pub async fn serve_stdio<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(reader: R, mut writer: W, addr: &str, token: &str, child: bool) -> std::io::Result<()> {
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue }; // notifications need no answer
        let result = match msg["method"].as_str().unwrap_or("") {
            "initialize" => Ok(json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools_for(child) })),
            "tools/call" => {
                let name = msg["params"]["name"].as_str().unwrap_or("");
                let args = msg["params"].get("arguments").cloned().unwrap_or(json!({}));
                Ok(match forward(addr, token, name, &args).await {
                    Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                    Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
                })
            }
            other => Err(json!({ "code": -32601, "message": format!("Method not found: {other}") })),
        };
        let reply = match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
        };
        writer.write_all(format!("{reply}\n").as_bytes()).await?;
        writer.flush().await?;
    }
    Ok(())
}

/// Entry point for `tg-studio --mcp-bridge`: no window, just stdio.
pub fn run_process() -> i32 {
    let (Ok(addr), Ok(token)) = (std::env::var("TG_BRIDGE_ADDR"), std::env::var("TG_BRIDGE_TOKEN")) else {
        eprintln!("tg-bridge chỉ chạy khi TG Studio khởi động nó cho một task.");
        return 2;
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => { eprintln!("tg-bridge: {e}"); return 1; }
    };
    let child = std::env::var("TG_BRIDGE_CHILD").is_ok_and(|v| v == "1");
    match runtime.block_on(serve_stdio(tokio::io::stdin(), tokio::io::stdout(), &addr, &token, child)) {
        Ok(()) => 0,
        Err(e) => { eprintln!("tg-bridge: {e}"); 1 }
    }
}

/// The executable agents spawn: this app (or TG_BRIDGE_EXE, for tests and development).
pub fn executable() -> Option<String> {
    std::env::var("TG_BRIDGE_EXE").ok().filter(|p| !p.is_empty())
        .or_else(|| std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fake {
        events: Mutex<Vec<(Value, String)>>,
        notes: Mutex<Vec<(String, String, u64, String)>>,
        allow: bool,
    }
    impl ToolEnv for Fake {
        fn emit(&self, data: Value, line: String) { self.events.lock().unwrap().push((data, line)); }
        fn add_note(&self, topic: &str, text: &str) -> Result<(), String> { self.notes.lock().unwrap().push((topic.into(), "claude".into(), 1, text.into())); Ok(()) }
        fn notes(&self, topic: Option<&str>) -> Result<Vec<(String, String, u64, String)>, String> {
            Ok(self.notes.lock().unwrap().iter().filter(|n| topic.is_none_or(|t| n.0 == t)).cloned().collect())
        }
        fn approve(&self, _: String, _: String) -> BoxFuture<bool> { let a = self.allow; Box::pin(async move { a }) }
        fn context(&self) -> Value { json!({ "task": "Đổi tiêu đề" }) }
    }

    #[tokio::test]
    async fn tools_validate_and_only_propose() {
        let env = Fake { allow: false, ..Default::default() };
        assert_eq!(call_tool(&env, "report_progress", &json!({"step":"Viết test","pct":140})).await.unwrap(), "Đã ghi tiến độ.");
        assert_eq!(env.events.lock().unwrap()[0].0["pct"], 100.0);
        assert!(call_tool(&env, "report_progress", &json!({})).await.unwrap_err().contains("step"));
        assert!(call_tool(&env, "read_notes", &json!({})).await.unwrap().contains("Chưa có"));
        call_tool(&env, "write_note", &json!({"topic":"plan","text":"1. A\n2. B"})).await.unwrap();
        call_tool(&env, "write_note", &json!({"topic":"style","text":"tabs"})).await.unwrap();
        assert_eq!(call_tool(&env, "read_notes", &json!({"topic":"plan"})).await.unwrap(), "## plan (claude)\n1. A\n2. B");
        assert!(call_tool(&env, "write_note", &json!({"topic":"x".repeat(101),"text":"t"})).await.is_err());
        assert!(call_tool(&env, "handoff_to", &json!({"agent":"cursor","task":"x"})).await.unwrap_err().contains("cursor"));
        assert!(call_tool(&env, "handoff_to", &json!({"agent":"codex","task":"Viết test","files":["a.ts"]})).await.unwrap().contains("người dùng duyệt"));
        let handoff = env.events.lock().unwrap().last().unwrap().0.clone();
        assert_eq!((handoff["agent"].as_str(), handoff["files"][0].as_str()), (Some("codex"), Some("a.ts")));
        assert_eq!(call_tool(&env, "request_approval", &json!({"action":"xóa build/","reason":"dọn"})).await.unwrap(), "denied");
        assert!(call_tool(&env, "get_task_context", &json!({})).await.unwrap().contains("Đổi tiêu đề"));
        assert!(call_tool(&env, "rm_rf", &json!({})).await.is_err());
    }

    /// A parent agent that can delegate: records the calls, answers like the app would.
    #[derive(Default)]
    struct Parent { calls: Mutex<Vec<String>> }
    impl ToolEnv for Parent {
        fn emit(&self, _: Value, _: String) {}
        fn add_note(&self, _: &str, _: &str) -> Result<(), String> { Ok(()) }
        fn notes(&self, _: Option<&str>) -> Result<Vec<(String, String, u64, String)>, String> { Ok(vec![]) }
        fn approve(&self, _: String, _: String) -> BoxFuture<bool> { Box::pin(async { true }) }
        fn context(&self) -> Value { json!({}) }
        fn delegate(&self, agent: AgentKind, task: String, files: Vec<String>) -> BoxFuture<Result<Value, String>> {
            self.calls.lock().unwrap().push(format!("delegate {agent:?} {task} {files:?}"));
            Box::pin(async { Ok(json!({"id": "d1", "status": "running"})) })
        }
        fn wait_delegated(&self, ids: Vec<String>, timeout: std::time::Duration) -> BoxFuture<Result<Value, String>> {
            self.calls.lock().unwrap().push(format!("wait {ids:?} {}", timeout.as_secs()));
            Box::pin(async { Ok(json!([{"id": "d1", "status": "done", "summary": "xong"}])) })
        }
        fn resolve_delegated(&self, id: String) -> Result<String, String> { Ok(format!("resolved {id}")) }
    }

    #[tokio::test]
    async fn delegate_tools_validate_and_reach_the_env() {
        let env = Parent::default();
        assert!(call_tool(&env, "delegate", &json!({"agent":"cursor","task":"x"})).await.unwrap_err().contains("cursor"));
        assert!(call_tool(&env, "delegate", &json!({"agent":"codex"})).await.unwrap_err().contains("task"));
        assert!(call_tool(&env, "delegate", &json!({"agent":"codex","task":"Viết test","files":["a.ts"]})).await.unwrap().contains("\"running\""));
        assert!(call_tool(&env, "wait_delegated", &json!({"timeout_s": 500})).await.unwrap().contains("xong"));
        call_tool(&env, "wait_delegated", &json!({"ids": ["d1"], "timeout_s": 0})).await.unwrap();
        assert_eq!(call_tool(&env, "resolve_delegated", &json!({"id":"d1"})).await.unwrap(), "resolved d1");
        assert_eq!(*env.calls.lock().unwrap(), ["delegate Codex Viết test [\"a.ts\"]", "wait [] 50", "wait [\"d1\"] 1"]);
        // An env that cannot delegate (a delegated agent, or tests) refuses.
        let plain = Fake::default();
        assert!(call_tool(&plain, "delegate", &json!({"agent":"codex","task":"x"})).await.is_err());
    }

    #[test]
    fn a_delegated_agent_lists_no_tools_to_delegate_or_hand_off() {
        let names = |v: Value| v.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let parent = names(tools_for(false));
        assert!(["delegate", "wait_delegated", "resolve_delegated", "handoff_to"].iter().all(|t| parent.contains(&t.to_string())));
        let child = names(tools_for(true));
        assert!(!child.iter().any(|t| PARENT_ONLY.contains(&t.as_str())));
        assert!(child.contains(&"report_progress".to_string()) && child.contains(&"get_task_context".to_string()));
    }

    #[tokio::test]
    async fn reserved_token_only_runs_tools_after_binding() {
        let hub = Arc::new(BridgeHub::default());
        let addr = hub.address().await.unwrap();
        let token = hub.reserve();
        let env = Arc::new(Fake::default());
        let args = json!({"topic":"plan","text":"xin chào"});

        assert_eq!(forward(&addr, &token, "write_note", &args).await.unwrap_err(), "Phiên tg-bridge không còn hiệu lực.");
        assert!(env.notes.lock().unwrap().is_empty());
        hub.bind(&token, env.clone()).unwrap();
        assert_eq!(forward(&addr, &token, "write_note", &args).await.unwrap(), "Đã lưu ghi chú \"plan\".");
        assert_eq!(env.notes.lock().unwrap()[0].3, "xin chào");

        assert!(hub.bind(&token, Arc::new(Fake::default())).is_err());
        forward(&addr, &token, "write_note", &args).await.unwrap();
        assert_eq!(env.notes.lock().unwrap().len(), 2);
        hub.unregister(&token);
        assert!(hub.bind(&token, env).is_err());
        assert_eq!(forward(&addr, &token, "write_note", &args).await.unwrap_err(), "Phiên tg-bridge không còn hiệu lực.");
    }

    #[test]
    fn bind_rejects_unknown_registered_and_unregistered_tokens() {
        let hub = BridgeHub::default();
        let env = Arc::new(Fake::default());
        assert!(hub.bind("unknown", env.clone()).is_err());
        let registered = hub.register(env.clone());
        assert!(hub.bind(&registered, env.clone()).is_err());
        let reserved = hub.reserve();
        assert_ne!(registered, reserved);
        hub.unregister(&reserved);
        assert!(hub.bind(&reserved, env).is_err());
    }

    /// The whole path: MCP client → stdio server → loopback hub → tool → back.
    #[tokio::test]
    async fn stdio_server_forwards_to_the_hub_with_its_token() {
        let hub = Arc::new(BridgeHub::default());
        let addr = hub.address().await.unwrap();
        let env = Arc::new(Fake { allow: true, ..Default::default() });
        let token = hub.register(env.clone());
        let (client, server) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server);
        let (addr2, token2) = (addr.clone(), token.clone());
        tokio::spawn(async move { serve_stdio(server_read, server_write, &addr2, &token2, false).await });
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut replies = BufReader::new(client_read).lines();
        for msg in [
            json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_note","arguments":{"topic":"plan","text":"xin chào"}}}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"request_approval","arguments":{"action":"a","reason":"b"}}}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"handoff_to","arguments":{"agent":"nobody","task":"x"}}}),
            json!({"jsonrpc":"2.0","id":5,"method":"nope"}),
        ] {
            client_write.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
        }
        let mut out = Vec::new();
        for _ in 0..6 { out.push(serde_json::from_str::<Value>(&replies.next_line().await.unwrap().unwrap()).unwrap()); }
        assert_eq!(out[0]["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(out[1]["result"]["tools"].as_array().unwrap().len(), 9);
        assert_eq!(out[2]["result"]["content"][0]["text"], "Đã lưu ghi chú \"plan\".");
        assert_eq!(out[3]["result"]["content"][0]["text"], "approved");
        assert_eq!(out[4]["result"]["isError"], true);
        assert_eq!(out[5]["error"]["code"], -32601);
        assert_eq!(env.notes.lock().unwrap()[0].3, "xin chào");
        // A stale token is refused once the run ends.
        hub.unregister(&token);
        assert!(forward(&addr, &token, "read_notes", &json!({})).await.unwrap_err().contains("không còn hiệu lực"));
        assert!(forward(&addr, "guess", "read_notes", &json!({})).await.is_err());
    }
}
