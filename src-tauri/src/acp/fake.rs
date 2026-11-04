//! Scripted in-process ACP agent for tests. It runs over `tokio::io::duplex`,
//! answers setup itself, and plays its steps when `session/prompt` arrives.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::mpsc;

pub const SESSION_ID: &str = "sess_fake";

/// Every message the client sent to the fake agent.
pub type Log = Arc<Mutex<Vec<Value>>>;

#[derive(Debug, Clone)]
pub enum Step {
    Message(&'static str),
    /// Sends any `session/update` payload.
    Update(Value),
    /// Sends `session/request_permission` for a harmless tool.
    AskPermission,
    /// Sends `session/request_permission` with this `toolCall`.
    AskPermissionFor(Value),
    /// Calls any client method with these params.
    Call(&'static str, Value),
    Request(&'static str),
    WaitForPermissionReply,
    WaitForAnyReply,
    WaitForCancel,
    /// Answers the prompt with this stop reason.
    End(&'static str),
    /// Closes the connection without answering.
    Crash,
}

type Reader = ReadHalf<DuplexStream>;
type Writer = WriteHalf<DuplexStream>;

pub fn spawn(steps: Vec<Step>) -> (Reader, Writer, Log) {
    spawn_with_version(1, steps)
}

/// An agent that reports it can reopen earlier sessions.
pub fn spawn_loadable(steps: Vec<Step>) -> (Reader, Writer, Log) {
    spawn_with(1, json!({ "loadSession": true }), steps)
}

pub fn spawn_with_version(version: u64, steps: Vec<Step>) -> (Reader, Writer, Log) {
    spawn_with(version, json!({}), steps)
}

fn spawn_with(version: u64, capabilities: Value, steps: Vec<Step>) -> (Reader, Writer, Log) {
    let (client_side, agent_side) = tokio::io::duplex(1 << 16);
    let (client_reader, client_writer) = tokio::io::split(client_side);
    let (agent_reader, mut agent_writer) = tokio::io::split(agent_side);
    let log: Log = Arc::default();
    let seen = log.clone();

    tokio::spawn(async move {
        let (tx, mut inbox) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(agent_reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                seen.lock().unwrap().push(message.clone());
                if tx.send(message).is_err() {
                    break;
                }
            }
        });

        let mut next_id = 1000u64;
        while let Some(message) = inbox.recv().await {
            let id = message["id"].clone();
            match message["method"].as_str() {
                Some("initialize") => {
                    let result = json!({
                        "protocolVersion": version,
                        "agentCapabilities": capabilities,
                        "authMethods": [],
                    });
                    send(&mut agent_writer, json!({ "jsonrpc": "2.0", "id": id, "result": result })).await;
                }
                Some("session/new") => {
                    let result = json!({ "sessionId": SESSION_ID });
                    send(&mut agent_writer, json!({ "jsonrpc": "2.0", "id": id, "result": result })).await;
                }
                Some("session/load") => {
                    send(&mut agent_writer, json!({ "jsonrpc": "2.0", "id": id, "result": {} })).await;
                }
                Some("session/prompt") => {
                    for step in steps.clone() {
                        if !play(step, &id, &mut agent_writer, &mut inbox, &mut next_id).await {
                            return;
                        }
                    }
                }
                _ => {}
            }
        }
    });

    (client_reader, client_writer, log)
}

async fn send(writer: &mut Writer, message: Value) {
    let mut bytes = serde_json::to_vec(&message).unwrap();
    bytes.push(b'\n');
    let _ = writer.write_all(&bytes).await;
    let _ = writer.flush().await;
}

async fn call(writer: &mut Writer, next_id: &mut u64, method: &str, params: Value) {
    *next_id += 1;
    send(writer, json!({ "jsonrpc": "2.0", "id": *next_id, "method": method, "params": params })).await;
}

/// Returns false when the agent should stop existing.
async fn play(
    step: Step,
    prompt_id: &Value,
    writer: &mut Writer,
    inbox: &mut mpsc::UnboundedReceiver<Value>,
    next_id: &mut u64,
) -> bool {
    let update = |update: Value| {
        json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": SESSION_ID, "update": update },
        })
    };
    match step {
        Step::Message(text) => {
            let body = json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": text },
            });
            send(writer, update(body)).await;
        }
        Step::Update(body) => send(writer, update(body)).await,
        Step::AskPermission => {
            let tool = json!({ "toolCallId": "call_1", "title": "Đọc file", "kind": "read" });
            ask_permission(writer, next_id, tool).await;
        }
        Step::AskPermissionFor(tool) => ask_permission(writer, next_id, tool).await,
        Step::Call(method, params) => call(writer, next_id, method, params).await,
        Step::Request(method) => call(writer, next_id, method, json!({})).await,
        Step::WaitForPermissionReply | Step::WaitForAnyReply => {
            while let Some(message) = inbox.recv().await {
                if message.get("method").is_none() {
                    break;
                }
            }
        }
        Step::WaitForCancel => {
            while let Some(message) = inbox.recv().await {
                if message["method"] == "session/cancel" {
                    break;
                }
            }
        }
        Step::End(reason) => {
            let reply = json!({ "jsonrpc": "2.0", "id": prompt_id, "result": { "stopReason": reason } });
            send(writer, reply).await;
        }
        Step::Crash => {
            let _ = writer.shutdown().await;
            return false;
        }
    }
    true
}

async fn ask_permission(writer: &mut Writer, next_id: &mut u64, tool: Value) {
    let params = json!({
        "sessionId": SESSION_ID,
        "toolCall": tool,
        "options": [
            { "optionId": "allow", "name": "Allow once", "kind": "allow_once" },
            { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
            { "optionId": "reject", "name": "Deny", "kind": "reject_once" },
        ],
    });
    call(writer, next_id, "session/request_permission", params).await;
}
