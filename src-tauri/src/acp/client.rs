//! ACP session lifecycle on top of `Transport`. Requests from the agent run in
//! their own tasks, so a permission card waiting on the user never blocks
//! `session/update` notifications or the response to `session/prompt`.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};

use super::transport::{Incoming, RpcError, Transport};

pub const PROTOCOL_VERSION: u64 = 1;
const SETUP_TIMEOUT: Duration = Duration::from_secs(60);

pub type HandlerFuture = Pin<Box<dyn Future<Output = Result<Value, RpcError>> + Send>>;

pub trait ClientHandler: Send + Sync + 'static {
    fn on_notification(&self, method: &str, params: Value);
    fn on_request(&self, method: String, params: Value) -> HandlerFuture;
    /// The agent went away. Called once, after every queued message was delivered.
    fn on_closed(&self);
}

#[derive(Clone)]
pub struct AcpClient {
    transport: Transport,
}

impl AcpClient {
    pub fn start<R, W>(reader: R, writer: W, handler: Arc<dyn ClientHandler>) -> AcpClient
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (transport, mut incoming) = Transport::spawn(reader, writer);
        let replies = transport.clone();
        tokio::spawn(async move {
            while let Some(message) = incoming.recv().await {
                match message {
                    Incoming::Notification { method, params } => {
                        handler.on_notification(&method, params);
                    }
                    Incoming::Request { id, method, params } => {
                        let work = handler.on_request(method, params);
                        let replies = replies.clone();
                        tokio::spawn(async move {
                            let _ = replies.respond(id, work.await);
                        });
                    }
                }
            }
            handler.on_closed();
        });
        AcpClient { transport }
    }

    pub async fn initialize(&self) -> Result<Value, String> {
        let result = self
            .transport
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": {
                        "fs": { "readTextFile": true, "writeTextFile": true },
                        "terminal": true,
                    },
                    "clientInfo": {
                        "name": "tg-studio",
                        "title": "TG Studio",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                }),
                Some(SETUP_TIMEOUT),
            )
            .await
            .map_err(|e| format!("Agent không khởi tạo được: {e}"))?;
        let version = result["protocolVersion"].as_u64();
        if version != Some(PROTOCOL_VERSION) {
            return Err(format!(
                "Agent dùng phiên bản ACP {version:?}, TG Studio cần {PROTOCOL_VERSION}."
            ));
        }
        Ok(result)
    }

    pub async fn new_session(&self, cwd: &Path, mcp_servers: Value) -> Result<String, String> {
        let result = self
            .transport
            .request(
                "session/new",
                json!({ "cwd": cwd.to_string_lossy(), "mcpServers": mcp_servers }),
                Some(SETUP_TIMEOUT),
            )
            .await
            .map_err(|e| format!("Không mở được phiên: {e}"))?;
        result["sessionId"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "Agent không trả về sessionId.".to_string())
    }

    /// Runs one turn and returns its `stopReason`. No timeout: a turn can wait
    /// on the user or run for a long time, and ends when the agent answers or dies.
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<String, String> {
        let result = self
            .transport
            .request(
                "session/prompt",
                json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] }),
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(result["stopReason"].as_str().unwrap_or("end_turn").to_string())
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), String> {
        self.transport
            .notify("session/cancel", json!({ "sessionId": session_id }))
            .map_err(|e| e.to_string())
    }
}

/// Standard reply for a method TG Studio does not implement.
pub fn method_not_found(method: &str) -> RpcError {
    RpcError {
        code: -32601,
        message: format!("Method not found: {method}"),
        data: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::fake::{self, Step};
    use std::sync::Mutex;
    use tokio::sync::{oneshot, Notify};

    #[derive(Default)]
    struct Recorder {
        methods: Mutex<Vec<String>>,
        closed: Notify,
        was_closed: Mutex<bool>,
        hold_permission: Mutex<Option<oneshot::Receiver<Value>>>,
    }

    struct Handler(Arc<Recorder>);

    impl ClientHandler for Handler {
        fn on_notification(&self, method: &str, params: Value) {
            let kind = params["update"]["sessionUpdate"].as_str().unwrap_or("");
            self.0.methods.lock().unwrap().push(format!("{method}:{kind}"));
        }
        fn on_request(&self, method: String, _params: Value) -> HandlerFuture {
            let held = self.0.hold_permission.lock().unwrap().take();
            Box::pin(async move {
                if method == "session/request_permission" {
                    return match held {
                        Some(rx) => Ok(rx.await.unwrap()),
                        None => Ok(json!({ "outcome": { "outcome": "cancelled" } })),
                    };
                }
                Err(method_not_found(&method))
            })
        }
        fn on_closed(&self) {
            *self.0.was_closed.lock().unwrap() = true;
            self.0.closed.notify_waiters();
        }
    }

    fn start(steps: Vec<Step>) -> (AcpClient, Arc<Recorder>, fake::Log) {
        let recorder = Arc::new(Recorder::default());
        let (reader, writer, log) = fake::spawn(steps);
        let client = AcpClient::start(reader, writer, Arc::new(Handler(recorder.clone())));
        (client, recorder, log)
    }

    #[tokio::test]
    async fn full_session_delivers_updates_before_the_turn_ends() {
        let (client, recorder, log) = start(vec![Step::Message("xin chào"), Step::End("end_turn")]);
        client.initialize().await.unwrap();
        let session = client.new_session(Path::new("/tmp/thư mục"), json!([])).await.unwrap();
        assert_eq!(session, fake::SESSION_ID);
        assert_eq!(client.prompt(&session, "làm đi").await.unwrap(), "end_turn");
        tokio::task::yield_now().await;
        assert_eq!(
            *recorder.methods.lock().unwrap(),
            ["session/update:agent_message_chunk"]
        );
        let sent = log.lock().unwrap().clone();
        let new_session = sent.iter().find(|m| m["method"] == "session/new").unwrap();
        assert_eq!(new_session["params"]["cwd"], "/tmp/thư mục");
        let prompt = sent.iter().find(|m| m["method"] == "session/prompt").unwrap();
        assert_eq!(prompt["params"]["prompt"][0]["text"], "làm đi");
    }

    #[tokio::test]
    async fn pending_permission_does_not_block_updates() {
        let (client, recorder, log) = start(vec![
            Step::AskPermission,
            Step::Message("vẫn nhận được"),
            Step::WaitForPermissionReply,
            Step::End("end_turn"),
        ]);
        let (answer, held) = oneshot::channel();
        *recorder.hold_permission.lock().unwrap() = Some(held);
        client.initialize().await.unwrap();
        let session = client.new_session(Path::new("/tmp"), json!([])).await.unwrap();
        let turn = {
            let client = client.clone();
            let session = session.clone();
            tokio::spawn(async move { client.prompt(&session, "x").await })
        };
        for _ in 0..100 {
            if !recorder.methods.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(recorder.methods.lock().unwrap().len(), 1, "update must arrive while waiting");
        assert!(!turn.is_finished());

        let reply = json!({ "outcome": { "outcome": "selected", "optionId": "allow" } });
        answer.send(reply.clone()).unwrap();
        assert_eq!(turn.await.unwrap().unwrap(), "end_turn");
        let sent = log.lock().unwrap().clone();
        assert!(sent.iter().any(|m| m["result"] == reply));
    }

    #[tokio::test]
    async fn unknown_agent_request_gets_method_not_found() {
        let (client, _recorder, log) = start(vec![
            Step::Request("x/unknown"),
            Step::WaitForAnyReply,
            Step::End("end_turn"),
        ]);
        client.initialize().await.unwrap();
        let session = client.new_session(Path::new("/tmp"), json!([])).await.unwrap();
        client.prompt(&session, "x").await.unwrap();
        let sent = log.lock().unwrap().clone();
        assert!(sent.iter().any(|m| m["error"]["code"] == -32601));
    }

    #[tokio::test]
    async fn cancel_is_sent_and_returns_cancelled_stop_reason() {
        let (client, _recorder, log) = start(vec![Step::WaitForCancel, Step::End("cancelled")]);
        client.initialize().await.unwrap();
        let session = client.new_session(Path::new("/tmp"), json!([])).await.unwrap();
        let turn = {
            let client = client.clone();
            let session = session.clone();
            tokio::spawn(async move { client.prompt(&session, "x").await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        client.cancel(&session).unwrap();
        assert_eq!(turn.await.unwrap().unwrap(), "cancelled");
        let sent = log.lock().unwrap().clone();
        assert!(sent.iter().any(|m| m["method"] == "session/cancel" && m["id"].is_null()));
    }

    #[tokio::test]
    async fn agent_crash_fails_the_turn_and_reports_closed() {
        let (client, recorder, _log) = start(vec![Step::Message("sắp chết"), Step::Crash]);
        client.initialize().await.unwrap();
        let session = client.new_session(Path::new("/tmp"), json!([])).await.unwrap();
        assert!(client.prompt(&session, "x").await.is_err());
        for _ in 0..100 {
            if *recorder.was_closed.lock().unwrap() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(*recorder.was_closed.lock().unwrap());
        assert_eq!(recorder.methods.lock().unwrap().len(), 1, "queued update still delivered");
    }

    #[tokio::test]
    async fn wrong_protocol_version_is_refused() {
        let recorder = Arc::new(Recorder::default());
        let (reader, writer, _log) = fake::spawn_with_version(2, vec![]);
        let client = AcpClient::start(reader, writer, Arc::new(Handler(recorder)));
        let error = client.initialize().await.unwrap_err();
        assert!(error.contains("phiên bản ACP"), "{error}");
    }
}
