//! Scripted in-process `claude -p --input-format stream-json` for tests, in the style
//! of `fake.rs`: it answers `initialize` itself, sends a line with `session_id` right
//! after, and plays its steps whenever a `{"type":"user",…}` line arrives.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::mpsc;

pub const SESSION_ID: &str = "c94c12db-0fd1-41cd-a4d9-97a7904e4b71";

/// Every line the client wrote to the fake's stdin.
pub type Log = Arc<Mutex<Vec<Value>>>;

type Reader = ReadHalf<DuplexStream>;
type Writer = WriteHalf<DuplexStream>;

#[derive(Debug, Clone)]
pub enum ClaudeStep {
    /// A `text_delta` stream event of the main agent.
    Text(&'static str),
    /// Any stdout line.
    Line(Value),
    /// A `can_use_tool` control request; waits for the client's `control_response`.
    Ask { tool: &'static str, input: Value },
    /// A `can_use_tool` control request that Claude withdraws at once (`control_cancel_request`).
    AskWithdrawn { tool: &'static str, input: Value },
    /// Waits for a `control_request` of this subtype from the client and answers it.
    WaitForControl(&'static str),
    /// Ends the turn: `stop` is the result subtype (`success`, `error_max_turns`…).
    Result { stop: &'static str, usage: Value, cost: f64 },
    /// What the fake answers to `get_context_usage` from now on (default `{}`).
    ContextUsage(Value),
    /// Closes stdout without ending the turn.
    Crash,
}

/// What `initialize` answers, trimmed from Claude CLI 2.1.332.
pub fn init_response() -> Value {
    json!({
        "commands": [
            { "name": "review", "description": "Review a pull request", "argumentHint": "[pr]" },
            { "name": "tg-demo-skill", "description": "Demo skill của dự án (project)", "argumentHint": "" },
        ],
        "agents": [{ "name": "claude", "description": "Catch-all" }],
        "models": [
            { "value": "default", "resolvedModel": "claude-opus-5-5", "displayName": "Default (recommended)", "description": "Opus 5.5" },
            { "value": "sonnet", "resolvedModel": "claude-sonnet-5-5", "displayName": "Sonnet 5.5", "description": "Efficient" },
        ],
        "account": { "subscriptionType": "Claude API", "apiProvider": "firstParty" },
        "current_permission_mode": "default",
        "capabilities": [],
    })
}

pub fn fake_claude(steps: Vec<ClaudeStep>) -> (Reader, Writer, Log) {
    let (client_side, agent_side) = tokio::io::duplex(1 << 16);
    let (client_reader, client_writer) = tokio::io::split(client_side);
    let (agent_reader, mut out) = tokio::io::split(agent_side);
    let log: Log = Arc::default();
    let seen = log.clone();

    tokio::spawn(async move {
        let (tx, mut inbox) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(agent_reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                seen.lock().unwrap().push(message.clone());
                if tx.send(message).is_err() { break; }
            }
        });

        let mut context = json!({});
        while let Some(message) = inbox.recv().await {
            match message["type"].as_str() {
                Some("control_request") => {
                    let id = message["request_id"].clone();
                    let body = match message["request"]["subtype"].as_str() {
                        Some("initialize") => init_response(),
                        Some("get_context_usage") => context.clone(),
                        _ => json!({}),
                    };
                    send(&mut out, success(&id, body)).await;
                    if message["request"]["subtype"] == "initialize" {
                        send(&mut out, json!({ "type": "system", "subtype": "hook_started", "hook_name": "SessionStart:startup", "session_id": SESSION_ID })).await;
                    }
                }
                Some("user") => {
                    for step in steps.clone() {
                        if let ClaudeStep::ContextUsage(reply) = &step { context = reply.clone(); continue; }
                        if !play(step, &mut out, &mut inbox).await { return; }
                    }
                }
                _ => {}
            }
        }
        // stdin closed: the CLI exits, which closes stdout.
        let _ = out.shutdown().await;
    });

    (client_reader, client_writer, log)
}

fn success(id: &Value, response: Value) -> Value {
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": id, "response": response } })
}

async fn send(writer: &mut Writer, message: Value) {
    let mut bytes = serde_json::to_vec(&message).unwrap();
    bytes.push(b'\n');
    let _ = writer.write_all(&bytes).await;
    let _ = writer.flush().await;
}

/// Returns false when the fake should stop existing.
async fn play(step: ClaudeStep, out: &mut Writer, inbox: &mut mpsc::UnboundedReceiver<Value>) -> bool {
    match step {
        ClaudeStep::Text(text) => {
            send(out, json!({
                "type": "stream_event",
                "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": text } },
                "parent_tool_use_id": null,
                "session_id": SESSION_ID,
            })).await;
        }
        ClaudeStep::Line(line) => send(out, line).await,
        ClaudeStep::Ask { tool, input } => {
            let id = uuid::Uuid::new_v4().to_string();
            send(out, json!({
                "type": "control_request",
                "request_id": id,
                "request": { "subtype": "can_use_tool", "tool_name": tool, "input": input, "tool_use_id": format!("toolu_{id}") },
            })).await;
            while let Some(message) = inbox.recv().await {
                if message["type"] == "control_response" && message["response"]["request_id"] == id.as_str() { break; }
            }
        }
        ClaudeStep::AskWithdrawn { tool, input } => {
            let id = uuid::Uuid::new_v4().to_string();
            send(out, json!({
                "type": "control_request",
                "request_id": id,
                "request": { "subtype": "can_use_tool", "tool_name": tool, "input": input, "tool_use_id": format!("toolu_{id}") },
            })).await;
            send(out, json!({ "type": "control_cancel_request", "request_id": id })).await;
        }
        ClaudeStep::WaitForControl(subtype) => {
            while let Some(message) = inbox.recv().await {
                if message["type"] == "control_request" && message["request"]["subtype"] == subtype {
                    send(out, success(&message["request_id"], json!({}))).await;
                    break;
                }
            }
        }
        ClaudeStep::Result { stop, usage, cost } => {
            let failed = stop.starts_with("error");
            send(out, json!({
                "type": "result",
                "subtype": stop,
                "is_error": failed,
                "result": if failed { Value::Null } else { json!("xong") },
                "errors": if failed { json!([stop]) } else { json!([]) },
                "stop_reason": "end_turn",
                "session_id": SESSION_ID,
                "total_cost_usd": cost,
                "usage": usage,
                "modelUsage": { "claude-opus-5-5": { "contextWindow": 1_000_000, "costUSD": cost } },
            })).await;
        }
        ClaudeStep::ContextUsage(_) => {}
        ClaudeStep::Crash => {
            let _ = out.shutdown().await;
            return false;
        }
    }
    true
}
