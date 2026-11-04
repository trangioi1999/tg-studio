//! ACP filesystem access and pipe-backed terminals scoped to a run's worktree.
use super::transport::RpcError;
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::{Component, Path, PathBuf}, process::Stdio, sync::Arc};
use tokio::{io::{AsyncRead, AsyncReadExt}, sync::{mpsc, watch, Mutex}};

fn error(code: i64, message: impl Into<String>) -> RpcError {
    RpcError { code, message: message.into(), data: None }
}
fn invalid(message: impl Into<String>) -> RpcError { error(-32602, message) }
fn failed(message: impl Into<String>) -> RpcError { error(-32000, message) }
fn string<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params.get(key).and_then(Value::as_str).filter(|s| !s.contains('\0'))
        .ok_or_else(|| invalid(format!("Tham số {key} phải là chuỗi hợp lệ")))
}
fn number(params: &Value, key: &str, default: usize) -> Result<usize, RpcError> {
    match params.get(key) {
        None => Ok(default),
        Some(value) => value.as_u64().and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| invalid(format!("Tham số {key} phải là số nguyên không âm"))),
    }
}

pub struct Sandbox { root: PathBuf }
impl Sandbox {
    pub fn new(root: &Path) -> Result<Self, String> {
        let root = dunce::canonicalize(root).map_err(|e| format!("Không mở được worktree: {e}"))?;
        if !root.is_dir() { return Err("Worktree phải là thư mục".into()); }
        Ok(Self { root })
    }
    pub fn resolve(&self, path: &str) -> Result<PathBuf, RpcError> {
        let path = Path::new(path);
        if !path.is_absolute() { return Err(invalid("Đường dẫn phải là tuyệt đối")); }
        // Resolve existing ancestors as we walk, including symlinks before '..'.
        // symlink_metadata also detects dangling symlinks: never treat them as new files.
        let mut resolved = PathBuf::new();
        for part in path.components() {
            match part {
                Component::CurDir => continue,
                Component::ParentDir => { resolved.pop(); }
                _ => resolved.push(part.as_os_str()),
            }
            // A bare Windows drive prefix ("C:") is not a path that can be checked.
            if matches!(part, Component::Prefix(_)) { continue; }
            match fs::symlink_metadata(&resolved) {
                Ok(_) => resolved = dunce::canonicalize(&resolved).map_err(|e| failed(format!("Không xác minh được đường dẫn: {e}")))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(failed(format!("Không xác minh được đường dẫn: {e}"))),
            }
        }
        if !resolved.starts_with(&self.root) { return Err(failed("Đường dẫn nằm ngoài worktree")); }
        Ok(resolved)
    }
    pub fn read_text_file(&self, params: &Value) -> Result<Value, RpcError> {
        let path = self.resolve(string(params, "path")?)?;
        let line = number(params, "line", 1)?;
        if line == 0 { return Err(invalid("Số dòng phải bắt đầu từ 1")); }
        let limit = number(params, "limit", usize::MAX)?;
        let content = fs::read_to_string(path).map_err(|e| failed(format!("Không đọc được tệp: {e}")))?;
        let content: String = content.split_inclusive('\n').skip(line - 1).take(limit).collect();
        Ok(json!({"content": content}))
    }
    pub fn write_text_file(&self, params: &Value) -> Result<Value, RpcError> {
        let path = self.resolve(string(params, "path")?)?;
        let content = params.get("content").and_then(Value::as_str)
            .ok_or_else(|| invalid("Tham số content phải là chuỗi"))?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| failed(format!("Không tạo được thư mục: {e}")))?;
        }
        fs::write(path, content).map_err(|e| failed(format!("Không ghi được tệp: {e}")))?;
        Ok(json!({}))
    }
}

struct Output { text: String, truncated: bool, limit: usize }
impl Output {
    fn append(&mut self, text: &str) {
        self.text.push_str(text);
        if self.text.len() > self.limit {
            let mut start = self.text.len() - self.limit;
            while !self.text.is_char_boundary(start) { start += 1; }
            self.text.drain(..start);
            self.truncated = true;
        }
    }
}
type Exit = Result<Value, RpcError>;
struct Terminal {
    output: Arc<Mutex<Output>>,
    exit: watch::Receiver<Option<Exit>>,
    kill: mpsc::UnboundedSender<()>,
}
impl Terminal {
    async fn wait(&self) -> Exit {
        let mut exit = self.exit.clone();
        loop {
            if let Some(result) = exit.borrow().clone() { return result; }
            exit.changed().await.map_err(|_| failed("Mất kết nối với tiến trình terminal"))?;
        }
    }
    async fn stop(&self) -> Result<(), RpcError> {
        let _ = self.kill.send(());
        self.wait().await.map(|_| ())
    }
}

#[derive(Clone)]
pub struct Terminals {
    sandbox: Arc<Sandbox>,
    terminals: Arc<Mutex<HashMap<String, Arc<Terminal>>>>,
}
impl Terminals {
    pub fn new(sandbox: Arc<Sandbox>) -> Self {
        Self { sandbox, terminals: Arc::new(Mutex::new(HashMap::new())) }
    }
    pub async fn create(&self, params: &Value) -> Result<Value, RpcError> {
        let command = string(params, "command")?;
        if command.is_empty() { return Err(invalid("Lệnh không được để trống")); }
        // Windows only finds .exe by itself, and CLIs installed through npm are .cmd shims.
        let mut cmd = crate::env::command(crate::env::which(command).unwrap_or_else(|| command.into()));
        if let Some(args) = params.get("args") {
            for arg in args.as_array().ok_or_else(|| invalid("args phải là mảng"))? {
                cmd.arg(arg.as_str().filter(|s| !s.contains('\0')).ok_or_else(|| invalid("Mỗi argument phải là chuỗi hợp lệ"))?);
            }
        }
        if let Some(env) = params.get("env") {
            for entry in env.as_array().ok_or_else(|| invalid("env phải là mảng"))? {
                let name = string(entry, "name")?;
                if name.is_empty() || name.contains('=') { return Err(invalid("Tên biến môi trường không hợp lệ")); }
                cmd.env(name, string(entry, "value")?);
            }
        }
        let cwd = match params.get("cwd") {
            None => self.sandbox.root.clone(),
            Some(_) => self.sandbox.resolve(string(params, "cwd")?)?,
        };
        let limit = number(params, "outputByteLimit", 1024 * 1024)?;
        let mut child = cmd.current_dir(cwd).env("PATH", crate::env::login_path())
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true)
            .spawn().map_err(|e| failed(format!("Không khởi chạy được terminal: {e}")))?;
        let output = Arc::new(Mutex::new(Output { text: String::new(), truncated: false, limit }));
        let stdout = child.stdout.take().expect("stdout pipe");
        let stderr = child.stderr.take().expect("stderr pipe");
        let out_task = tokio::spawn(read_pipe(stdout, output.clone()));
        let err_task = tokio::spawn(read_pipe(stderr, output.clone()));
        let (exit_tx, exit) = watch::channel(None);
        let (kill, mut kill_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            // Only this task owns Child; waiting never holds the terminal table lock.
            let mut killed = false;
            let status = tokio::select! {
                status = child.wait() => status,
                _ = kill_rx.recv() => {
                    killed = true;
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            // Descendants can inherit pipes after the direct child exits. A stop
            // must also interrupt pipe draining, otherwise release can hang.
            let out_abort = out_task.abort_handle();
            let err_abort = err_task.abort_handle();
            if killed {
                out_abort.abort();
                err_abort.abort();
            }
            let reads = async move { tokio::join!(out_task, err_task) };
            tokio::pin!(reads);
            let (out, err) = tokio::select! {
                result = &mut reads => result,
                _ = kill_rx.recv() => {
                    out_abort.abort();
                    err_abort.abort();
                    reads.await
                }
            };
            let result = async {
                let status = status.map_err(|e| failed(format!("Không chờ được terminal: {e}")))?;
                for read in [out, err] {
                    if read.as_ref().is_err_and(|e| e.is_cancelled()) { continue; }
                    read.map_err(|e| failed(format!("Không thu được đầu ra terminal: {e}")))??;
                }
                #[cfg(unix)]
                let signal = {
                    use std::os::unix::process::ExitStatusExt;
                    status.signal().map(|s| s.to_string())
                };
                #[cfg(not(unix))]
                let signal: Option<String> = None;
                Ok(json!({"exitCode":status.code(), "signal":signal}))
            }.await;
            let _ = exit_tx.send(Some(result));
        });
        let id = uuid::Uuid::new_v4().to_string();
        self.terminals.lock().await.insert(id.clone(), Arc::new(Terminal { output, exit, kill }));
        Ok(json!({"terminalId":id}))
    }
    async fn get(&self, params: &Value) -> Result<Arc<Terminal>, RpcError> {
        let id = string(params, "terminalId")?;
        self.terminals.lock().await.get(id).cloned().ok_or_else(|| failed("Không tìm thấy terminal"))
    }
    pub async fn output(&self, params: &Value) -> Result<Value, RpcError> {
        let terminal = self.get(params).await?;
        let output = terminal.output.lock().await;
        let mut result = json!({"output":output.text, "truncated":output.truncated});
        if let Some(exit) = terminal.exit.borrow().clone() { result["exitStatus"] = exit?; }
        Ok(result)
    }
    pub async fn wait_for_exit(&self, params: &Value) -> Result<Value, RpcError> { self.get(params).await?.wait().await }
    pub async fn kill(&self, params: &Value) -> Result<Value, RpcError> {
        self.get(params).await?.stop().await?;
        Ok(json!({}))
    }
    pub async fn release(&self, params: &Value) -> Result<Value, RpcError> {
        let id = string(params, "terminalId")?;
        let terminal = self.terminals.lock().await.remove(id).ok_or_else(|| failed("Không tìm thấy terminal"))?;
        terminal.stop().await?;
        Ok(json!({}))
    }
    pub async fn kill_all(&self) {
        let terminals: Vec<_> = self.terminals.lock().await.drain().map(|(_, t)| t).collect();
        for terminal in &terminals { let _ = terminal.kill.send(()); }
        for terminal in terminals { let _ = terminal.wait().await; }
    }
}

async fn read_pipe(mut pipe: impl AsyncRead + Unpin, output: Arc<Mutex<Output>>) -> Result<(), RpcError> {
    let mut buffer = [0; 8192];
    let mut pending = Vec::new();
    loop {
        let count = pipe.read(&mut buffer).await.map_err(|e| failed(format!("Không đọc được đầu ra terminal: {e}")))?;
        pending.extend_from_slice(&buffer[..count]);
        // Keep incomplete UTF-8 separately for each pipe; chunks may split a character.
        loop {
            match std::str::from_utf8(&pending) {
                Ok(text) => { output.lock().await.append(text); pending.clear(); break; }
                Err(e) => {
                    let valid = e.valid_up_to();
                    output.lock().await.append(std::str::from_utf8(&pending[..valid]).expect("valid prefix"));
                    pending.drain(..valid);
                    match e.error_len() {
                        Some(len) => { output.lock().await.append("�"); pending.drain(..len); }
                        None => break,
                    }
                }
            }
        }
        if count == 0 {
            if !pending.is_empty() { output.lock().await.append("�"); }
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, time::Duration};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("tg thư mục {}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(dunce::canonicalize(path).unwrap())
        }
        fn sandbox(&self) -> Sandbox { Sandbox::new(&self.0).unwrap() }
        fn path(&self, name: &str) -> String { self.0.join(name).to_str().unwrap().into() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[tokio::test]
    async fn pipe_preserves_split_utf8_and_replaces_invalid_bytes() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, reader) = tokio::io::duplex(1);
        let output = Arc::new(Mutex::new(Output { text: String::new(), truncated: false, limit: 100 }));
        let read = read_pipe(reader, output.clone());
        let write = async move {
            for byte in "ế🙂".as_bytes().iter().copied().chain([0xff, b'z', 0xe2]) {
                writer.write_all(&[byte]).await.unwrap();
            }
        };
        let (result, ()) = tokio::join!(read, write);
        result.unwrap();
        assert_eq!(output.lock().await.text, "ế🙂�z�");
    }
    #[test]
    fn text_content_can_contain_nul() {
        let f = Fixture::new();
        let p = json!({"path": f.path("file"), "content": "a\0b"});
        f.sandbox().write_text_file(&p).unwrap();
        assert_eq!(f.sandbox().read_text_file(&p).unwrap()["content"], "a\0b");
    }
    #[test]
    fn rejects_relative_path() {
        let f = Fixture::new();
        assert_eq!(f.sandbox().resolve("a.txt").unwrap_err().code, -32602);
    }
    #[test]
    fn rejects_parent_escape() {
        let f = Fixture::new();
        for path in [f.path("../outside"), f.path("new/../../outside")] {
            assert_eq!(f.sandbox().resolve(&path).unwrap_err().code, -32000);
        }
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_on_read_and_write() {
        let f = Fixture::new(); let outside = Fixture::new();
        fs::write(outside.0.join("secret"), "original").unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret"), f.0.join("link")).unwrap();
        let p = json!({"path": f.path("link"), "content":"changed"});
        assert_eq!(f.sandbox().read_text_file(&p).unwrap_err().code, -32000);
        assert_eq!(f.sandbox().write_text_file(&p).unwrap_err().code, -32000);
        assert_eq!(fs::read_to_string(outside.0.join("secret")).unwrap(), "original");
        std::os::unix::fs::symlink(outside.0.join("missing"), f.0.join("dangling")).unwrap();
        assert!(f.sandbox().write_text_file(&json!({"path": f.path("dangling"), "content":"bad"})).is_err());
        assert!(!outside.0.join("missing").exists());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_write_through_symlinked_dir() {
        let f = Fixture::new(); let outside = Fixture::new();
        std::os::unix::fs::symlink(&outside.0, f.0.join("link")).unwrap();
        assert!(f.sandbox().write_text_file(&json!({"path": f.path("link/new/file"), "content":"bad"})).is_err());
        assert!(!outside.0.join("new").exists());
    }
    #[test]
    fn allows_new_file_in_new_dir() {
        let f = Fixture::new(); let s = f.sandbox();
        let p = json!({"path":f.path("new/deep/file"), "content":"xin chào\n"});
        assert_eq!(s.write_text_file(&p).unwrap(), json!({}));
        assert_eq!(s.read_text_file(&p).unwrap(), json!({"content":"xin chào\n"}));
    }
    #[test]
    fn read_line_and_limit() {
        let f = Fixture::new(); fs::write(f.0.join("file"), "one\ntwo\nthree\n").unwrap();
        let s = f.sandbox();
        assert_eq!(s.read_text_file(&json!({"path":f.path("file"),"line":2,"limit":1})).unwrap()["content"], "two\n");
        assert_eq!(s.read_text_file(&json!({"path":f.path("file"),"line":9})).unwrap()["content"], "");
        assert_eq!(s.read_text_file(&json!({"path":f.path("file"),"limit":0})).unwrap()["content"], "");
        for params in [json!({}), json!({"path":f.path("file"),"line":0}), json!({"path":f.path("file"),"limit":-1})] {
            assert_eq!(s.read_text_file(&params).unwrap_err().code, -32602);
        }
    }
    #[test]
    fn root_path_with_space_and_unicode() {
        let f = Fixture::new(); let s = f.sandbox();
        assert_eq!(s.resolve(&f.path("tệp mới")).unwrap(), f.0.join("tệp mới"));
        assert_eq!(s.resolve(f.0.to_str().unwrap()).unwrap(), f.0);
    }
    async fn wait(t: &Terminals, p: &Value) -> Value {
        tokio::time::timeout(Duration::from_secs(5), t.wait_for_exit(p)).await.unwrap().unwrap()
    }
    #[cfg(unix)]
    async fn shell(t: &Terminals, script: &str, extra: Value) -> Value {
        let mut p = json!({"command":"/bin/sh", "args":["-c",script]});
        p.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        t.create(&p).await.unwrap()
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_runs_and_reports_exit() {
        let f = Fixture::new(); let t = Terminals::new(Arc::new(f.sandbox()));
        let p = shell(&t, "printf '%s' \"$TG_TEST\"; printf 'stderr' >&2; pwd; printf '%s' \"$PATH\"; exit 7", json!({"env":[{"name":"TG_TEST","value":"hello"},{"name":"PATH","value":"bad"}]})).await;
        assert_eq!(wait(&t,&p).await, json!({"exitCode":7,"signal":null}));
        let o = t.output(&p).await.unwrap(); let text = o["output"].as_str().unwrap();
        for expected in ["hello", "stderr", f.0.to_str().unwrap(), &crate::env::login_path()] { assert!(text.contains(expected), "{text}"); }
        assert_eq!(o["truncated"], false);
        assert_eq!(o["exitStatus"]["exitCode"], 7);
    }
    #[tokio::test]
    async fn terminal_cwd_outside_is_rejected() {
        let f = Fixture::new(); let outside = Fixture::new(); let t = Terminals::new(Arc::new(f.sandbox()));
        assert_eq!(t.create(&json!({"command":"irrelevant", "cwd":outside.0})).await.unwrap_err().code, -32000);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn output_truncates_on_char_boundary() {
        let f = Fixture::new(); let t = Terminals::new(Arc::new(f.sandbox()));
        let p = shell(&t, "printf 'aế🙂z'", json!({"outputByteLimit":6})).await;
        wait(&t,&p).await;
        let o = t.output(&p).await.unwrap();
        assert_eq!(o["output"], "🙂z"); assert_eq!(o["truncated"], true);
        let p = shell(&t, "printf 'abc'", json!({"outputByteLimit":0})).await;
        wait(&t,&p).await;
        assert_eq!(t.output(&p).await.unwrap()["output"], "");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn kill_stops_long_process() {
        let f = Fixture::new(); let t = Terminals::new(Arc::new(f.sandbox()));
        let p = shell(&t, "exec sleep 30", json!({})).await;
        assert_eq!(t.kill(&p).await.unwrap(), json!({}));
        assert!(wait(&t,&p).await["signal"].is_string());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn release_removes_terminal() {
        let f = Fixture::new(); let t = Terminals::new(Arc::new(f.sandbox()));
        let p = shell(&t, "exec sleep 30", json!({})).await;
        assert_eq!(t.release(&p).await.unwrap(), json!({}));
        assert_eq!(t.output(&p).await.unwrap_err().code, -32000);
    }
    #[tokio::test]
    async fn unknown_terminal_is_error() {
        let f = Fixture::new(); let t = Terminals::new(Arc::new(f.sandbox())); let p = json!({"terminalId":"missing"});
        assert_eq!(t.output(&p).await.unwrap_err().code, -32000);
        assert_eq!(t.wait_for_exit(&p).await.unwrap_err().code, -32000);
        assert_eq!(t.kill(&p).await.unwrap_err().code, -32000);
        assert_eq!(t.release(&p).await.unwrap_err().code, -32000);
        assert_eq!(t.output(&json!({})).await.unwrap_err().code, -32602);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn wait_for_exit_is_shared_with_output() {
        let f = Fixture::new(); let t = Terminals::new(Arc::new(f.sandbox()));
        let p = shell(&t, "printf ready; exec sleep 30", json!({})).await;
        let operations = async {
            assert!(t.output(&p).await.unwrap().get("exitStatus").is_none());
            t.kill(&p).await.unwrap();
        };
        let (a,b,()) = tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(t.wait_for_exit(&p), t.wait_for_exit(&p), operations) }).await.unwrap();
        assert_eq!(a.unwrap(), b.unwrap());
        assert!(t.output(&p).await.unwrap().get("exitStatus").is_some());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn kill_returns_when_descendant_keeps_pipes_open() {
        let f = Fixture::new(); let t = Terminals::new(Arc::new(f.sandbox()));
        let p = shell(&t, "sleep 2 & printf ready; exit 0", json!({})).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while t.output(&p).await.unwrap()["output"] != "ready" {
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        tokio::time::timeout(Duration::from_millis(500), t.kill(&p)).await.unwrap().unwrap();
        assert!(t.output(&p).await.unwrap().get("exitStatus").is_some());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn kill_all_stops_every_terminal() {
        let f = Fixture::new(); let t = Terminals::new(Arc::new(f.sandbox()));
        let a = shell(&t,"exec sleep 30",json!({})).await;
        let b = shell(&t,"exec sleep 30",json!({})).await;
        tokio::time::timeout(Duration::from_secs(5),t.kill_all()).await.unwrap();
        assert!(t.output(&a).await.is_err()); assert!(t.output(&b).await.is_err());
    }
    #[tokio::test]
    async fn invalid_terminal_parameters_are_rejected() {
        let f = Fixture::new(); let t = Terminals::new(Arc::new(f.sandbox()));
        for p in [json!({}),json!({"command":"x","args":[1]}),json!({"command":"x","env":[{"name":"A=B","value":"x"}]}),json!({"command":"x","outputByteLimit":-1}),json!({"command":"x","cwd":1})] {
            assert_eq!(t.create(&p).await.unwrap_err().code,-32602);
        }
    }
}
