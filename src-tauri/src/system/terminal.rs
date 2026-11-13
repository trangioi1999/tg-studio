//! User terminals, independent of the agent's ACP terminal tools.
use std::{collections::HashMap, io::{Read, Write}, path::Path, sync::{Arc, Mutex}};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use super::{env, resources::{self, Owner}};

#[derive(Default)]
pub struct Terminals(Arc<Mutex<HashMap<String, Session>>>);

struct Session {
    info: TerminalInfo,
    #[cfg(unix)]
    pid: Option<u32>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Session {
    fn kill(&mut self) -> std::io::Result<()> {
        // portable-pty's Unix killer sends SIGHUP only. A foreground command
        // (or a shell trapping HUP) can survive it; terminate the PTY group.
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            let program = env::which("kill").unwrap_or_else(|| "/bin/kill".into());
            let status = env::std_command(program)
                .args(["-KILL", "--", &format!("-{pid}")])
                .env("PATH", env::login_path())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()?;
            if status.success() { return Ok(()); }
        }
        self.killer.kill()
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub fresh: bool,
}

pub fn shell_for(os_is_windows: bool, shell_env: Option<String>, has_pwsh: bool) -> (String, Vec<String>) {
    if os_is_windows {
        ((if has_pwsh { "pwsh.exe" } else { "powershell.exe" }).into(), vec!["-NoLogo".into()])
    } else {
        (shell_env.filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into()), vec!["-l".into()])
    }
}

fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if cols == 0 || rows == 0 { return Err("Kích thước terminal phải lớn hơn 0.".into()); }
    Ok(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
}

impl Terminals {
    pub fn open(&self, key: &str, cwd: &Path, cols: u16, rows: u16,
        on_output: impl Fn(String) + Send + 'static, on_exit: impl Fn(Option<i32>) + Send + 'static,
    ) -> Result<TerminalInfo, String> {
        let (program, args) = shell_for(cfg!(windows), std::env::var("SHELL").ok(), cfg!(windows) && env::which("pwsh.exe").is_some());
        self.open_with(key, cwd, cols, rows, &program, &args, on_output, on_exit)
    }

    #[allow(clippy::too_many_arguments)]
    fn open_with(&self, key: &str, cwd: &Path, cols: u16, rows: u16, program: &str, args: &[String],
        on_output: impl Fn(String) + Send + 'static, on_exit: impl Fn(Option<i32>) + Send + 'static,
    ) -> Result<TerminalInfo, String> {
        let mut sessions = self.0.lock().map_err(|e| format!("Không mở được terminal: {e}"))?;
        if let Some(session) = sessions.get(key) {
            return Ok(TerminalInfo { fresh: false, ..session.info.clone() });
        }
        if !cwd.is_dir() { return Err(format!("Thư mục không còn: {}", cwd.display())); }
        let pair = portable_pty::native_pty_system().openpty(size(cols, rows)?)
            .map_err(|e| format!("Không tạo được terminal: {e}"))?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| format!("Không đọc được terminal: {e}"))?;
        let writer = pair.master.take_writer().map_err(|e| format!("Không ghi được terminal: {e}"))?;
        let resolved = env::which(program).unwrap_or_else(|| program.into());
        let mut command = CommandBuilder::new(resolved);
        command.args(args);
        command.cwd(cwd);
        command.env("PATH", env::login_path());
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).map_err(|e| format!("Không mở được shell: {e}"))?;
        drop(pair.slave);
        let registration = resources::Registration::new(child.process_id(), Owner::Terminal(key.into()));
        let info = TerminalInfo { id: uuid::Uuid::new_v4().to_string(), shell: Path::new(program).file_name().unwrap_or_default().to_string_lossy().into_owned(), cwd: cwd.to_string_lossy().into_owned(), fresh: true };
        sessions.insert(key.into(), Session { info: info.clone(), #[cfg(unix)] pid: child.process_id(), master: pair.master, writer, killer: child.clone_killer() });
        // Only a weak reference: workers must not keep Terminals alive on app shutdown.
        let state = Arc::downgrade(&self.0);
        let key = key.to_owned();
        let id = info.id.clone();
        std::thread::spawn(move || {
            let mut pending = Vec::new();
            let mut buffer = [0; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = utf8_chunks(&mut pending, &buffer[..n]);
                        if !data.is_empty() { on_output(data); }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break, // Unix PTYs may return EIO at EOF.
                }
            }
            if !pending.is_empty() { on_output(String::from_utf8_lossy(&pending).into_owned()); }
        });
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|status| i32::try_from(status.exit_code()).ok());
            drop(registration);
            if let Some(state) = state.upgrade() {
                let mut sessions = state.lock().unwrap_or_else(|e| e.into_inner());
                // A close followed by reopen must not remove the replacement session.
                if sessions.get(&key).is_some_and(|session| session.info.id == id) { sessions.remove(&key); }
            }
            on_exit(code);
        });
        Ok(info)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.0.lock().map_err(|e| format!("Không ghi được terminal: {e}"))?;
        let session = sessions.values_mut().find(|s| s.info.id == id).ok_or("Terminal đã đóng.")?;
        session.writer.write_all(data.as_bytes()).and_then(|_| session.writer.flush()).map_err(|e| format!("Không ghi được terminal: {e}"))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.0.lock().map_err(|e| format!("Không đổi được kích thước terminal: {e}"))?;
        let session = sessions.values().find(|s| s.info.id == id).ok_or("Terminal đã đóng.")?;
        session.master.resize(size(cols, rows)?).map_err(|e| format!("Không đổi được kích thước terminal: {e}"))
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.0.lock().map_err(|e| format!("Không đóng được terminal: {e}"))?;
        let key = sessions.iter().find(|(_, s)| s.info.id == id).map(|(key, _)| key.clone());
        if let Some(key) = key {
            // Keep the entry if kill fails, so closing can be retried.
            sessions.get_mut(&key).unwrap().kill().map_err(|e| format!("Không dừng được terminal: {e}"))?;
            sessions.remove(&key);
        }
        Ok(())
    }
}

impl Drop for Terminals {
    fn drop(&mut self) {
        let mut sessions = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut session) in sessions.drain() { let _ = session.kill(); }
    }
}

fn utf8_chunks(pending: &mut Vec<u8>, read: &[u8]) -> String {
    pending.extend_from_slice(read);
    let mut output = String::new();
    let mut consumed = 0;
    while consumed < pending.len() {
        match std::str::from_utf8(&pending[consumed..]) {
            Ok(text) => { output.push_str(text); consumed = pending.len(); }
            Err(error) => {
                let end = consumed + error.valid_up_to();
                output.push_str(std::str::from_utf8(&pending[consumed..end]).expect("valid UTF-8 prefix"));
                consumed = end;
                match error.error_len() {
                    Some(len) => { output.push('\u{fffd}'); consumed += len; }
                    None => break,
                }
            }
        }
    }
    pending.drain(..consumed);
    output
}

#[derive(Serialize, Clone)]
struct Output { id: String, data: String }
#[derive(Serialize, Clone)]
struct Exit { id: String, code: Option<i32> }

#[tauri::command]
pub fn terminal_open(app: AppHandle, state: State<Terminals>, key: String, cwd: String, cols: u16, rows: u16) -> Result<TerminalInfo, String> {
    // Hold this gate until open returns its id: even immediate output/exit gets the correct id.
    let id = Arc::new(Mutex::new(String::new()));
    let mut assigned = id.lock().map_err(|e| format!("Không mở được terminal: {e}"))?;
    let output_id = id.clone();
    let exit_id = id.clone();
    let output_app = app.clone();
    let info = state.open(&key, Path::new(&cwd), cols, rows, move |data| {
        let id = output_id.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let _ = output_app.emit("terminal-output", Output { id, data });
    }, move |code| {
        let id = exit_id.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let _ = app.emit("terminal-exit", Exit { id, code });
    })?;
    *assigned = info.id.clone();
    Ok(info)
}

#[tauri::command]
pub fn terminal_write(state: State<Terminals>, id: String, data: String) -> Result<(), String> { state.write(&id, &data) }
#[tauri::command]
pub fn terminal_resize(state: State<Terminals>, id: String, cols: u16, rows: u16) -> Result<(), String> { state.resize(&id, cols, rows) }
#[tauri::command]
pub fn terminal_close(state: State<Terminals>, id: String) -> Result<(), String> { state.close(&id) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_for_windows_prefers_pwsh() {
        assert_eq!(shell_for(true, Some("ignored".into()), true), ("pwsh.exe".into(), vec!["-NoLogo".into()]));
    }
    #[test]
    fn shell_for_windows_falls_back() {
        assert_eq!(shell_for(true, None, false), ("powershell.exe".into(), vec!["-NoLogo".into()]));
    }
    #[test]
    fn shell_for_unix_uses_env_shell_login() {
        assert_eq!(shell_for(false, Some("/bin/bash".into()), false), ("/bin/bash".into(), vec!["-l".into()]));
    }
    #[test]
    fn shell_for_unix_default_zsh() {
        assert_eq!(shell_for(false, None, false), ("/bin/zsh".into(), vec!["-l".into()]));
    }
    #[test]
    fn utf8_chunks_split_on_char_boundary() {
        let mut pending = vec![];
        let bytes = "xin chào 🙂".as_bytes();
        let mut output = utf8_chunks(&mut pending, &bytes[..7]);
        assert_eq!(pending, vec![0xc3]);
        for byte in &bytes[7..] { output.push_str(&utf8_chunks(&mut pending, &[*byte])); }
        assert_eq!(output, "xin chào 🙂");
        assert!(pending.is_empty());
    }
    #[test]
    fn utf8_chunks_recovers_after_invalid_bytes() {
        let mut pending = vec![];
        assert_eq!(utf8_chunks(&mut pending, b"a\xffb"), "a\u{fffd}b");
        assert!(pending.is_empty());
    }
    #[test]
    fn open_missing_dir_errors() {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let result = Terminals::default().open("missing", &path, 80, 24, |_| {}, |_| {});
        assert_eq!(result.err().unwrap(), format!("Thư mục không còn: {}", path.display()));
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::{sync::mpsc, time::{Duration, Instant}};
        struct Dir(std::path::PathBuf);
        impl Dir {
            fn new() -> Self {
                let path = std::env::temp_dir().join(format!("tg-pty-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir(&path).unwrap();
                Self(path.canonicalize().unwrap())
            }
        }
        impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
        fn open(terminals: &Terminals, dir: &Dir) -> (TerminalInfo, mpsc::Receiver<String>, mpsc::Receiver<Option<i32>>) {
            let (output, rx) = mpsc::channel();
            let (exit, ex) = mpsc::channel();
            let info = terminals.open_with("thread", &dir.0, 80, 24, "/bin/sh", &[], move |s| { let _ = output.send(s); }, move |code| { let _ = exit.send(code); }).unwrap();
            (info, rx, ex)
        }
        fn wait_output(rx: &mpsc::Receiver<String>, expected: &str) {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut output = String::new();
            while !output.contains(expected) {
                output.push_str(&rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).expect("PTY output before deadline"));
            }
        }
        #[test]
        fn open_runs_shell_in_cwd() {
            let terminals = Terminals::default();
            let dir = Dir::new();
            let (info, rx, _) = open(&terminals, &dir);
            assert!(info.fresh);
            terminals.write(&info.id, "pwd\n").unwrap();
            wait_output(&rx, dir.0.to_str().unwrap());
            terminals.resize(&info.id, 101, 37).unwrap();
            terminals.write(&info.id, "stty size\n").unwrap();
            wait_output(&rx, "37 101");
            terminals.write(&info.id, "printf '%s' \"$TERM\"\n").unwrap();
            wait_output(&rx, "xterm-256color");
        }
        #[test]
        fn open_same_key_returns_same_id() {
            let terminals = Terminals::default();
            let dir = Dir::new();
            let (first, _, _) = open(&terminals, &dir);
            let (second, _, _) = open(&terminals, &dir);
            assert_eq!(first.id, second.id);
            assert!(!second.fresh);
        }
        #[test]
        fn close_ends_the_process() {
            let terminals = Terminals::default();
            let dir = Dir::new();
            let (info, _, exit) = open(&terminals, &dir);
            terminals.close(&info.id).unwrap();
            exit.recv_timeout(Duration::from_secs(5)).unwrap();
            terminals.close(&info.id).unwrap();
            assert!(terminals.write(&info.id, "pwd\n").is_err());
        }
        #[test]
        fn close_stops_shell_even_when_hangup_is_ignored() {
            let terminals = Terminals::default();
            let dir = Dir::new();
            let (info, rx, exit) = open(&terminals, &dir);
            terminals.write(&info.id, "trap '' HUP\nprintf 'rea%s\\n' dy; while :; do sleep 1; done\n").unwrap();
            wait_output(&rx, "ready");
            terminals.close(&info.id).unwrap();
            exit.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        #[test]
        fn drop_ends_the_process() {
            let terminals = Terminals::default();
            let dir = Dir::new();
            let (_, _, exit) = open(&terminals, &dir);
            drop(terminals);
            exit.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        #[test]
        fn exited_shell_can_reopen() {
            let terminals = Terminals::default();
            let dir = Dir::new();
            let (first, _, exit) = open(&terminals, &dir);
            terminals.write(&first.id, "exit 7\n").unwrap();
            assert_eq!(exit.recv_timeout(Duration::from_secs(5)).unwrap(), Some(7));
            let (second, _, _) = open(&terminals, &dir);
            assert!(second.fresh);
            assert_ne!(first.id, second.id);
        }
    }
}
