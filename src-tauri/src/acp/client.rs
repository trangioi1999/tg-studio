//! ACP session lifecycle on top of `Transport`. Requests from the agent run in
//! their own tasks, so a permission card waiting on the user never blocks
//! `session/update` notifications or the response to `session/prompt`.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};

use super::transport::{Incoming, RpcError, Transport};

pub const PROTOCOL_VERSION: u64 = 1;
const ASKING_MODE: &str = "default";

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
    setup_timeout: Duration,
    /// `configOptions` of the latest opened session (model, effort…), updated by `set_config_option`.
    config: Arc<Mutex<Value>>,
}

impl AcpClient {
    pub fn close(&self) { self.transport.close(); }

    #[cfg(test)]
    pub fn start<R, W>(reader: R, writer: W, handler: Arc<dyn ClientHandler>) -> AcpClient
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::start_with_timeout(reader, writer, handler, Duration::from_secs(60))
    }

    pub fn start_with_timeout<R, W>(reader: R, writer: W, handler: Arc<dyn ClientHandler>, setup_timeout: Duration) -> AcpClient
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (transport, mut incoming) = Transport::spawn(reader, writer);
        let replies = transport.clone();
        tokio::spawn(async move {
            while let Some(message) = incoming.recv().await {
                match message {
                    Incoming::Barrier(barrier) => barrier.release(),
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
        AcpClient { transport, setup_timeout, config: Arc::new(Mutex::new(Value::Null)) }
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
                Some(self.setup_timeout),
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

    /// Agents inherit the permission mode of the user's own CLI settings, where approvals
    /// may be off. The app promises to ask, so its sessions use the agent's asking mode.
    async fn require_approvals(&self, session_id: &str, modes: &Value) -> Result<(), String> {
        let offered = modes["availableModes"].as_array().is_some_and(|all| all.iter().any(|m| m["id"] == ASKING_MODE));
        if !offered || modes["currentModeId"] == ASKING_MODE { return Ok(()); }
        self.transport
            .request("session/set_mode", json!({ "sessionId": session_id, "modeId": ASKING_MODE }), Some(self.setup_timeout))
            .await
            .map(|_| ())
            .map_err(|e| format!("Không bật được chế độ xin duyệt: {e}"))
    }

    pub async fn new_session(&self, cwd: &Path, mcp_servers: Value) -> Result<String, String> {
        let result = self
            .transport
            .request(
                "session/new",
                json!({ "cwd": cwd.to_string_lossy(), "mcpServers": mcp_servers }),
                Some(self.setup_timeout),
            )
            .await
            .map_err(|e| format!("Không mở được phiên: {e}"))?;
        let id = result["sessionId"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "Agent không trả về sessionId.".to_string())?;
        *self.config.lock().unwrap() = result["configOptions"].clone();
        self.require_approvals(&id, &result["modes"]).await?;
        Ok(id)
    }

    /// Reopens an earlier session of this adapter; the agent replays it as updates.
    pub async fn load_session(&self, session_id: &str, cwd: &std::path::Path, mcp_servers: Value) -> Result<(), String> {
        let result = self.transport
            .request(
                "session/load",
                json!({ "sessionId": session_id, "cwd": cwd.to_string_lossy(), "mcpServers": mcp_servers }),
                Some(self.setup_timeout),
            )
            .await
            .map_err(|e| format!("Không nối lại được phiên: {e}"))?;
        *self.config.lock().unwrap() = result["configOptions"].clone();
        self.require_approvals(session_id, &result["modes"]).await
    }

    /// The session settings the agent offers (ACP `configOptions`), as last reported.
    pub fn config_options(&self) -> Value { self.config.lock().unwrap().clone() }

    /// Changes one session setting; the agent answers with every option, since one
    /// change (the model) can change the others (its effort levels).
    pub async fn set_config_option(&self, session_id: &str, config_id: &str, value: &str) -> Result<(), String> {
        let result = self
            .transport
            .request("session/set_config_option", json!({ "sessionId": session_id, "configId": config_id, "value": value }), Some(self.setup_timeout))
            .await
            .map_err(|e| format!("Agent không đổi được {config_id}: {e}"))?;
        if !result["configOptions"].is_null() { *self.config.lock().unwrap() = result["configOptions"].clone(); }
        Ok(())
    }

    /// Runs one turn and returns its `stopReason`. No timeout: a turn can wait
    /// on the user or run for a long time, and ends when the agent answers or dies.
    #[cfg(test)]
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<String, String> {
        let result = self.prompt_turn(session_id, text).await?;
        Ok(result["stopReason"].as_str().unwrap_or("end_turn").to_string())
    }

    /// The whole `session/prompt` result: `stopReason` plus optional `usage`.
    pub async fn prompt_turn(&self, session_id: &str, text: &str) -> Result<Value, String> {
        let result = self
            .transport
            .request(
                "session/prompt",
                json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] }),
                None,
            )
            .await
            .map_err(|e| e.to_string());
        self.transport.drained().await;
        result
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
    async fn setup_requests_use_the_configured_timeout() {
        for initialize in [true, false] {
            let recorder = Arc::new(Recorder::default());
            let (io, _silent_agent) = tokio::io::duplex(4096);
            let (reader, writer) = tokio::io::split(io);
            let client = AcpClient::start_with_timeout(reader, writer, Arc::new(Handler(recorder)), Duration::from_millis(20));
            let error = tokio::time::timeout(Duration::from_secs(2), async {
                if initialize {
                    client.initialize().await.unwrap_err()
                } else {
                    client.new_session(Path::new("/tmp"), json!([])).await.unwrap_err()
                }
            }).await.expect("setup must use the configured timeout");
            assert!(error.contains("Hết thời gian chờ phản hồi ACP"), "{error}");
            client.close();
        }
    }

    #[tokio::test]
    async fn sessions_ask_for_approval_whatever_the_cli_settings_say() {
        let recorder = Arc::new(Recorder::default());
        let modes = json!({"currentModeId":"auto","availableModes":[{"id":"default"},{"id":"auto"}]});
        let (reader, writer, log) = fake::spawn_with_modes(modes, vec![Step::End("end_turn")]);
        let client = AcpClient::start(reader, writer, Arc::new(Handler(recorder)));
        client.initialize().await.unwrap();
        let id = client.new_session(Path::new("/tmp"), json!([])).await.unwrap();
        client.prompt_turn(&id, "p").await.unwrap();
        let methods: Vec<_> = log.lock().unwrap().iter().filter_map(|v| v["method"].as_str().map(String::from)).collect();
        assert_eq!(methods, vec!["initialize", "session/new", "session/set_mode", "session/prompt"]);
        let sent = log.lock().unwrap().iter().find(|v| v["method"] == "session/set_mode").cloned().unwrap();
        assert_eq!(sent["params"]["modeId"], "default");
        assert_eq!(sent["params"]["sessionId"], fake::SESSION_ID);
    }

    #[tokio::test]
    async fn no_mode_change_when_already_asking_or_not_offered() {
        for modes in [json!({"currentModeId":"default","availableModes":[{"id":"default"}]}), json!({"currentModeId":"full","availableModes":[{"id":"full"}]}), json!(null)] {
            let (reader, writer, log) = fake::spawn_with_modes(modes, vec![]);
            let client = AcpClient::start(reader, writer, Arc::new(Handler(Arc::new(Recorder::default()))));
            client.initialize().await.unwrap();
            client.new_session(Path::new("/tmp"), json!([])).await.unwrap();
            assert!(!log.lock().unwrap().iter().any(|v| v["method"] == "session/set_mode"));
        }
    }

    #[tokio::test]
    async fn a_finished_turn_has_every_earlier_update() {
        let steps = std::iter::repeat_n(Step::Message("x"), 300).chain([Step::End("end_turn")]).collect();
        let (client, recorder, _) = start(steps);
        client.initialize().await.unwrap();
        let id = client.new_session(Path::new("/tmp"), json!([])).await.unwrap();
        client.prompt_turn(&id, "p").await.unwrap();
        let seen = recorder.methods.lock().unwrap().len();
        assert!(seen >= 300, "chỉ thấy {seen} update khi lượt đã xong");
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

    #[tokio::test]
    async fn explicit_close_ends_prompt_and_notifies_handler() {
        let (client,recorder,_log)=start(vec![Step::WaitForCancel]);
        client.initialize().await.unwrap();
        let session=client.new_session(Path::new("/tmp"),json!([])).await.unwrap();
        let clone=client.clone();let turn=tokio::spawn(async move {clone.prompt(&session,"task").await});
        client.close();
        assert!(tokio::time::timeout(Duration::from_secs(1),turn).await.unwrap().unwrap().is_err());
        tokio::time::timeout(Duration::from_secs(1),async {
            while !*recorder.was_closed.lock().unwrap() {tokio::task::yield_now().await;}
        }).await.unwrap();
    }
}
