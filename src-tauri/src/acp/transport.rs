use std::{
    collections::HashMap,
    error::Error,
    fmt,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot, watch},
};

#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Lỗi RPC {}: {}", self.code, self.message)
    }
}

impl Error for RpcError {}

#[derive(Debug, Clone, PartialEq)]
pub enum TransportError {
    Closed,
    Timeout,
    Rpc(RpcError),
    Io(String),
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => write!(f, "Kết nối ACP đã đóng"),
            Self::Timeout => write!(f, "Hết thời gian chờ phản hồi ACP"),
            Self::Rpc(error) => error.fmt(f),
            Self::Io(message) => write!(f, "Lỗi đọc/ghi ACP: {message}"),
        }
    }
}

impl Error for TransportError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Rpc(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
}

type Reply = Result<Value, TransportError>;

struct State {
    next_id: u64,
    pending: HashMap<u64, oneshot::Sender<Reply>>,
    outgoing: Option<mpsc::UnboundedSender<Value>>,
    incoming: Option<mpsc::UnboundedSender<Incoming>>,
    closed: watch::Sender<bool>,
}

impl State {
    fn send(&self, message: Value) -> Result<(), TransportError> {
        self.outgoing.as_ref().ok_or(TransportError::Closed)?
            .send(message).map_err(|_| TransportError::Closed)
    }

    fn close(&mut self, error: TransportError) {
        self.outgoing.take();
        self.incoming.take();
        for (_, sender) in self.pending.drain() {
            let _ = sender.send(Err(error.clone()));
        }
        let _ = self.closed.send(true);
    }

    fn receive(&mut self, message: Value) {
        if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return;
        }
        if let Some(method) = message.get("method") {
            let Some(method) = method.as_str() else { return };
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let incoming = match message.get("id") {
                Some(id) if id.is_null() || id.is_string() || id.is_number() => Incoming::Request {
                    id: id.clone(), method: method.into(), params,
                },
                Some(_) => return,
                None => Incoming::Notification { method: method.into(), params },
            };
            if let Some(sender) = &self.incoming {
                let _ = sender.send(incoming);
            }
            return;
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else { return };
        let reply = match (message.get("result"), message.get("error")) {
            (Some(result), None) => Ok(result.clone()),
            (None, Some(error)) => {
                let (Some(code), Some(message)) = (
                    error.get("code").and_then(Value::as_i64),
                    error.get("message").and_then(Value::as_str),
                ) else { return };
                Err(TransportError::Rpc(RpcError {
                    code, message: message.into(), data: error.get("data").cloned(),
                }))
            }
            _ => return,
        };
        // Unknown IDs include responses arriving after a timeout.
        if let Some(sender) = self.pending.remove(&id) {
            let _ = sender.send(reply);
        }
    }
}

#[derive(Clone)]
pub struct Transport {
    shared: Arc<Mutex<State>>,
}

// Also removes a pending entry when the caller cancels the request future.
struct PendingRequest {
    shared: Arc<Mutex<State>>,
    id: u64,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        self.shared.lock().unwrap().pending.remove(&self.id);
    }
}

impl Transport {
    pub fn spawn<R, W>(reader: R, mut writer: W) -> (Self, mpsc::UnboundedReceiver<Incoming>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();
        let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel();
        let (closed_tx, mut read_closed) = watch::channel(false);
        let mut write_closed = read_closed.clone();
        let shared = Arc::new(Mutex::new(State {
            next_id: 0,
            pending: HashMap::new(),
            outgoing: Some(outgoing_tx),
            incoming: Some(incoming_tx),
            closed: closed_tx,
        }));
        let read_state = shared.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            let mut line = Vec::new();
            loop {
                line.clear();
                tokio::select! {
                    biased;
                    _ = read_closed.changed() => break,
                    result = reader.read_until(b'\n', &mut line) => match result {
                        Ok(0) => {
                            read_state.lock().unwrap().close(TransportError::Closed);
                            break;
                        }
                        Ok(_) => {
                            // No size limit: ACP payloads can exceed a megabyte.
                            if let Ok(message) = serde_json::from_slice(&line) {
                                read_state.lock().unwrap().receive(message);
                            }
                        }
                        Err(error) => {
                            read_state.lock().unwrap().close(TransportError::Io(error.to_string()));
                            break;
                        }
                    }
                }
            }
        });
        let write_state = shared.clone();
        tokio::spawn(async move {
            let writing = async {
                while let Some(message) = outgoing_rx.recv().await {
                    let mut bytes = serde_json::to_vec(&message)
                        .map_err(|error| TransportError::Io(error.to_string()))?;
                    bytes.push(b'\n');
                    writer.write_all(&bytes).await
                        .map_err(|error| TransportError::Io(error.to_string()))?;
                    writer.flush().await
                        .map_err(|error| TransportError::Io(error.to_string()))?;
                }
                Ok::<(), TransportError>(())
            };
            tokio::select! {
                biased;
                _ = write_closed.changed() => {},
                result = writing => {
                    write_state.lock().unwrap().close(result.err().unwrap_or(TransportError::Closed));
                }
            }
        });
        (Self { shared }, incoming_rx)
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Option<Duration>) -> Reply {
        let (sender, receiver) = oneshot::channel();
        let id = {
            let mut state = self.shared.lock().unwrap();
            if state.outgoing.is_none() {
                return Err(TransportError::Closed);
            }
            let id = state.next_id;
            state.next_id = id.checked_add(1)
                .ok_or_else(|| TransportError::Io("Đã hết ID yêu cầu ACP".into()))?;
            state.send(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))?;
            // Insertion and enqueue share the lock, so a fast response cannot be lost.
            state.pending.insert(id, sender);
            id
        };
        let _pending = PendingRequest { shared: self.shared.clone(), id };
        match timeout {
            Some(duration) => tokio::time::timeout(duration, receiver).await
                .map_err(|_| TransportError::Timeout)?
                .unwrap_or(Err(TransportError::Closed)),
            None => receiver.await.unwrap_or(Err(TransportError::Closed)),
        }
    }

    /// Success means queued; asynchronous write errors close the transport.
    pub fn notify(&self, method: &str, params: Value) -> Result<(), TransportError> {
        self.shared.lock().unwrap().send(json!({"jsonrpc":"2.0", "method":method, "params":params}))
    }

    pub fn respond(&self, id: Value, result: Result<Value, RpcError>) -> Result<(), TransportError> {
        let message = match result {
            Ok(value) => json!({"jsonrpc":"2.0", "id":id, "result":value}),
            Err(error) => {
                let mut value = json!({"code":error.code, "message":error.message});
                if let Some(data) = error.data {
                    value["data"] = data;
                }
                json!({"jsonrpc":"2.0", "id":id, "error":value})
            }
        };
        self.shared.lock().unwrap().send(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    use tokio::time::{timeout, Duration};

    fn pair() -> (Transport, tokio::sync::mpsc::UnboundedReceiver<Incoming>, BufReader<tokio::io::ReadHalf<DuplexStream>>, tokio::io::WriteHalf<DuplexStream>) {
        let (local, peer) = tokio::io::duplex(4096);
        let (reader, writer) = tokio::io::split(local);
        let (peer_reader, peer_writer) = tokio::io::split(peer);
        let (transport, incoming) = Transport::spawn(reader, writer);
        (transport, incoming, BufReader::new(peer_reader), peer_writer)
    }

    async fn read(reader: &mut BufReader<tokio::io::ReadHalf<DuplexStream>>) -> Value {
        let mut line = String::new();
        timeout(Duration::from_secs(5), reader.read_line(&mut line)).await.unwrap().unwrap();
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        serde_json::from_str(&line).unwrap()
    }

    async fn send(writer: &mut tokio::io::WriteHalf<DuplexStream>, value: Value) {
        writer.write_all(format!("{value}\n").as_bytes()).await.unwrap();
    }

    fn request(transport: &Transport, method: &'static str) -> tokio::task::JoinHandle<Result<Value, TransportError>> {
        let transport = transport.clone();
        tokio::spawn(async move { transport.request(method, json!({}), Some(Duration::from_secs(5))).await })
    }

    #[tokio::test]
    async fn responses_match_ids_out_of_order() {
        let (transport, _incoming, mut reader, mut writer) = pair();
        let first = request(&transport, "first");
        let a = read(&mut reader).await;
        let second = request(&transport, "second");
        let b = read(&mut reader).await;
        assert_eq!(a, json!({"jsonrpc":"2.0", "id":0, "method":"first", "params":{}}));
        assert_eq!(b["id"], 1);
        send(&mut writer, json!({"jsonrpc":"2.0", "id":b["id"], "result":"B"})).await;
        send(&mut writer, json!({"jsonrpc":"2.0", "id":a["id"], "result":"A"})).await;
        assert_eq!(first.await.unwrap(), Ok(json!("A")));
        assert_eq!(second.await.unwrap(), Ok(json!("B")));
    }

    #[tokio::test]
    async fn rpc_error_is_returned() {
        let (transport, _incoming, mut reader, mut writer) = pair();
        let pending = request(&transport, "fail");
        let msg = read(&mut reader).await;
        send(&mut writer, json!({"jsonrpc":"2.0", "id":msg["id"], "error":{"code":-32000,"message":"Lỗi", "data":{"why":1}}})).await;
        assert_eq!(pending.await.unwrap(), Err(TransportError::Rpc(RpcError { code: -32000, message: "Lỗi".into(), data: Some(json!({"why":1})) })));
    }

    #[tokio::test]
    async fn incoming_request_and_notification_are_delivered() {
        let (_transport, mut incoming, _reader, mut writer) = pair();
        send(&mut writer, json!({"jsonrpc":"2.0", "id":"agent-1", "method":"permission", "params":{"x":1}})).await;
        send(&mut writer, json!({"jsonrpc":"2.0", "method":"update"})).await;
        assert_eq!(incoming.recv().await, Some(Incoming::Request { id: json!("agent-1"), method: "permission".into(), params: json!({"x":1}) }));
        assert_eq!(incoming.recv().await, Some(Incoming::Notification { method: "update".into(), params: Value::Null }));
    }

    #[tokio::test]
    async fn respond_writes_result_and_error_shapes() {
        let (transport, _incoming, mut reader, _writer) = pair();
        transport.respond(json!("id"), Ok(json!({"ok":true}))).unwrap();
        assert_eq!(read(&mut reader).await, json!({"jsonrpc":"2.0", "id":"id", "result":{"ok":true}}));
        transport.respond(json!(2), Err(RpcError { code: -32601, message: "Không có phương thức".into(), data: None })).unwrap();
        assert_eq!(read(&mut reader).await, json!({"jsonrpc":"2.0", "id":2, "error":{"code":-32601,"message":"Không có phương thức"}}));
        transport.respond(Value::Null, Err(RpcError { code: -32000, message: "Lỗi".into(), data: Some(json!({"x":1})) })).unwrap();
        assert_eq!(read(&mut reader).await, json!({"jsonrpc":"2.0", "id":null, "error":{"code":-32000,"message":"Lỗi","data":{"x":1}}}));
    }

    #[tokio::test]
    async fn messages_are_single_newline_terminated_lines() {
        let (transport, _incoming, mut reader, mut writer) = pair();
        let params = json!({"text":"Dòng một\nDòng hai 🌿"});
        transport.notify("update", params.clone()).unwrap();
        assert_eq!(read(&mut reader).await, json!({"jsonrpc":"2.0","method":"update","params":params}));
        transport.respond(json!(3), Ok(params.clone())).unwrap();
        assert_eq!(read(&mut reader).await["result"], params);
        let cloned = transport.clone();
        let expected = params.clone();
        let pending = tokio::spawn(async move { cloned.request("echo", expected, None).await });
        let msg = read(&mut reader).await;
        assert_eq!(msg["params"], params);
        send(&mut writer, json!({"jsonrpc":"2.0","id":msg["id"],"result":params})).await;
        assert_eq!(pending.await.unwrap(), Ok(params));
    }

    #[tokio::test]
    async fn timeout_clears_pending_and_late_response_is_ignored() {
        let (transport, _incoming, mut reader, mut writer) = pair();
        assert_eq!(transport.request("slow", json!({}), Some(Duration::from_millis(10))).await, Err(TransportError::Timeout));
        assert!(transport.shared.lock().unwrap().pending.is_empty());
        let old = read(&mut reader).await;
        send(&mut writer, json!({"jsonrpc":"2.0","id":old["id"],"result":"late"})).await;
        let pending = request(&transport, "next");
        let next = read(&mut reader).await;
        assert_eq!(next["id"], 1);
        send(&mut writer, json!({"jsonrpc":"2.0","id":next["id"],"result":"fresh"})).await;
        assert_eq!(pending.await.unwrap(), Ok(json!("fresh")));
    }

    #[tokio::test]
    async fn eof_fails_pending_requests_with_closed() {
        let (transport, mut incoming, mut reader, mut writer) = pair();
        let a = request(&transport, "a");
        read(&mut reader).await;
        let b = request(&transport, "b");
        read(&mut reader).await;
        writer.shutdown().await.unwrap();
        assert_eq!(a.await.unwrap(), Err(TransportError::Closed));
        assert_eq!(b.await.unwrap(), Err(TransportError::Closed));
        assert_eq!(incoming.recv().await, None);
    }

    #[tokio::test]
    async fn request_after_close_returns_closed() {
        let (transport, mut incoming, _reader, mut writer) = pair();
        writer.shutdown().await.unwrap();
        assert_eq!(incoming.recv().await, None);
        assert_eq!(transport.request("closed", Value::Null, None).await, Err(TransportError::Closed));
        assert_eq!(transport.notify("closed", Value::Null), Err(TransportError::Closed));
        assert_eq!(transport.respond(json!(0), Ok(Value::Null)), Err(TransportError::Closed));
    }

    #[tokio::test]
    async fn malformed_line_is_skipped_and_reading_continues() {
        let (transport, mut incoming, mut reader, mut writer) = pair();
        let pending = request(&transport, "test");
        let msg = read(&mut reader).await;
        writer.write_all(b"not json\n\n[]\n{\"jsonrpc\":\"1.0\",\"method\":\"bad\"}\n").await.unwrap();
        send(&mut writer, json!({"jsonrpc":"2.0","id":msg["id"],"error":{"code":"bad"}})).await;
        send(&mut writer, json!({"jsonrpc":"2.0","method":"good","params":{}})).await;
        send(&mut writer, json!({"jsonrpc":"2.0","id":msg["id"],"result":null})).await;
        assert_eq!(incoming.recv().await, Some(Incoming::Notification { method: "good".into(), params: json!({}) }));
        assert_eq!(pending.await.unwrap(), Ok(Value::Null));
    }

    #[tokio::test]
    async fn large_line_over_1mb_round_trips() {
        let (transport, _incoming, mut reader, mut writer) = pair();
        let payload = json!({"text":"Việt 🌿\n".repeat(150_000)});
        assert!(payload.to_string().len() > 1024 * 1024);
        let expected = payload.clone();
        let pending = tokio::spawn(async move { transport.request("echo", expected, Some(Duration::from_secs(5))).await });
        let msg = read(&mut reader).await;
        assert_eq!(msg["params"], payload);
        send(&mut writer, json!({"jsonrpc":"2.0","id":msg["id"],"result":msg["params"]})).await;
        assert_eq!(pending.await.unwrap(), Ok(payload));
    }
}
