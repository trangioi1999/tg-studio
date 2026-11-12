//! Project settings and cancellable, bounded shell commands shared by hooks and composites.
use std::{path::Path, process::Stdio, sync::{Arc, Mutex}, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::{store::Store, system::env};
use super::{compose::CheckResult, project::OpenedProjects};

pub const HOOK_TIMEOUT: Duration = Duration::from_secs(600);
pub(super) const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectSettings {
    pub setup: String,
    pub check: String,
    pub auto_fix: bool,
    pub max_fix_rounds: u8,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self { setup: String::new(), check: String::new(), auto_fix: true, max_fix_rounds: 2 }
    }
}

fn settings_key(root: &Path) -> Result<String, String> {
    let root = dunce::canonicalize(root).map_err(|e| format!("Không mở được thư mục dự án: {e}"))?;
    Ok(format!("project:{}", root.display()))
}

pub fn load(store: &Store, root: &Path) -> ProjectSettings {
    let mut settings: ProjectSettings = settings_key(root).ok()
        .and_then(|key| store.setting(&key).ok().flatten())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    settings.max_fix_rounds = settings.max_fix_rounds.clamp(1, 5);
    settings
}

pub fn save(store: &Store, root: &Path, settings: &ProjectSettings) -> Result<(), String> {
    let key = settings_key(root)?;
    let mut settings = settings.clone();
    settings.max_fix_rounds = settings.max_fix_rounds.clamp(1, 5);
    let json = serde_json::to_string(&settings).map_err(|e| format!("Không mã hóa được thiết lập dự án: {e}"))?;
    store.set_setting(&key, &json).map_err(|e| format!("Không lưu được thiết lập dự án: {e}"))
}

/// kill_on_drop stops the shell; this guard also stops its descendants and pipe readers.
/// Cleanup is synchronous so dropping the future does not depend on another Tokio task
/// getting polled (in particular when the runtime is shutting down).
struct ScriptCleanup {
    pid: Option<u32>,
    readers: Vec<tokio::task::AbortHandle>,
}

impl Drop for ScriptCleanup {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            #[cfg(unix)]
            let mut kill = {
                let mut c = env::std_command("kill");
                c.args(["-KILL", "--", &format!("-{pid}")]);
                c
            };
            #[cfg(windows)]
            let mut kill = {
                let mut c = env::std_command("taskkill");
                c.args(["/PID", &pid.to_string(), "/T", "/F"]);
                c
            };
            let _ = kill.env("PATH", env::login_path()).stdin(Stdio::null())
                .stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        for reader in &self.readers { reader.abort(); }
    }
}

pub async fn run_script(cwd: &Path, command: &str, extra_env: &[(&str, &Path)], timeout: Duration) -> Result<CheckResult, String> {
    if command.trim().is_empty() { return Err("Hãy nhập lệnh kiểm tra, ví dụ npm test.".into()); }
    #[cfg(windows)]
    let mut cmd = {
        let shell = env::which("pwsh").or_else(|| env::which("powershell"))
            .ok_or("Không tìm thấy PowerShell để chạy lệnh.")?;
        let mut c = env::command(shell);
        c.args(["-NoProfile", "-Command", command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = { let mut c = env::command("sh"); c.args(["-c", command]); c };
    cmd.current_dir(cwd).env("PATH", env::login_path()).stdin(Stdio::null())
        .stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (key, value) in extra_env { cmd.env(key, value); }
    env::isolate(&mut cmd);
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("Không chạy được lệnh: {e}"))?;
    let pid = child.id();
    let mut cleanup = ScriptCleanup { pid, readers: Vec::new() };
    let tail = Arc::new(Mutex::new(Tail::default()));
    let readers = [
        tokio::spawn(read_tail(child.stdout.take().expect("piped stdout"), tail.clone())),
        tokio::spawn(read_tail(child.stderr.take().expect("piped stderr"), tail.clone())),
    ];
    cleanup.readers = readers.iter().map(|reader| reader.abort_handle()).collect();
    let code = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status.code(),
        Ok(Err(e)) => return Err(format!("Lệnh lỗi khi chạy: {e}")),
        Err(_) => {
            if let Some(pid) = pid { env::kill_tree(pid).await; }
            cleanup.pid = None;
            let _ = child.kill().await;
            None
        }
    };
    // A background process can keep the pipes open after the command itself has ended.
    for reader in readers {
        let abort = reader.abort_handle();
        if tokio::time::timeout(Duration::from_secs(2), reader).await.is_err() { abort.abort(); }
    }
    let (bytes, truncated) = {
        let tail = tail.lock().map_err(|_| "Không đọc được kết quả lệnh.")?;
        (tail.bytes.clone(), tail.dropped)
    };
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if code.is_none() && started.elapsed() >= timeout {
        if !text.is_empty() && !text.ends_with('\n') { text.push('\n'); }
        text.push_str(&format!("Đã dừng lệnh sau {} giây.", timeout.as_secs()));
    }
    Ok(CheckResult { code, output: text, truncated, duration_ms: started.elapsed().as_millis() as u64 })
}

/// The end of a command's output, where test summaries are. A noisy command must not
/// fill memory during the minutes it runs.
#[derive(Default)]
struct Tail { bytes: Vec<u8>, dropped: bool }

async fn read_tail(mut pipe: impl tokio::io::AsyncRead + Unpin, tail: Arc<Mutex<Tail>>) {
    use tokio::io::AsyncReadExt;
    let mut buffer = [0; 8192];
    while let Ok(n) = pipe.read(&mut buffer).await {
        if n == 0 { break; }
        let Ok(mut tail) = tail.lock() else { break };
        tail.bytes.extend_from_slice(&buffer[..n]);
        if tail.bytes.len() > OUTPUT_LIMIT {
            let extra = tail.bytes.len() - OUTPUT_LIMIT;
            tail.bytes.drain(..extra);
            tail.dropped = true;
        }
    }
}

pub async fn run_setup(root: &Path, worktree: &Path, command: &str) -> Result<CheckResult, String> {
    run_script(worktree, command, &[("TG_ROOT_PATH", root), ("TG_WORKTREE_PATH", worktree)], HOOK_TIMEOUT).await
}

#[tauri::command(async)]
pub fn project_settings(projects: State<'_, OpenedProjects>, store: State<'_, Store>, root: String) -> Result<ProjectSettings, String> {
    let root = projects.root(&root)?;
    Ok(load(&store, &root))
}

#[tauri::command(async)]
pub fn set_project_settings(projects: State<'_, OpenedProjects>, store: State<'_, Store>, root: String, settings: ProjectSettings) -> Result<(), String> {
    let root = projects.root(&root)?;
    save(&store, &root, &settings)
}

async fn check_run(store: &Store, run_id: &str) -> Result<Option<CheckResult>, String> {
    let (root, wt) = store.run_worktree(run_id)
        .map_err(|e| format!("Không tìm thấy bản nháp của lượt chạy: {e}"))?;
    // The stored worktree is unscoped. Use the run's scope, as start_task does.
    let scope = store.live_run_scope(run_id)
        .map_err(|e| format!("Không đọc được lượt chạy: {e}"))?
        .ok_or("Lượt chạy không còn hoặc đã bị xóa.")?;
    let settings = load(store, &root);
    if settings.check.trim().is_empty() { return Ok(None); }
    let cwd = env::scoped_dir(&wt.path, scope.as_deref())?;
    run_script(&cwd, &settings.check, &[("TG_ROOT_PATH", &root), ("TG_WORKTREE_PATH", &wt.path)], HOOK_TIMEOUT)
        .await.map(Some)
}

#[tauri::command(async)]
pub async fn run_project_check(store: State<'_, Store>, run_id: String) -> Result<Option<CheckResult>, String> {
    check_run(&store, &run_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, time::Instant};

    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("tg-hooks-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn settings_default_when_missing() {
        let dir = Dir::new();
        let s = load(&Store::open_in_memory().unwrap(), &dir.0);
        assert_eq!(s, ProjectSettings { setup: "".into(), check: "".into(), auto_fix: true, max_fix_rounds: 2 });
    }

    #[test]
    fn settings_roundtrip() {
        let dir = Dir::new();
        let store = Store::open_in_memory().unwrap();
        let s = ProjectSettings { setup: "cp x y".into(), check: "npm test".into(), auto_fix: false, max_fix_rounds: 3 };
        save(&store, &dir.0.join("."), &s).unwrap();
        assert_eq!(load(&store, &dir.0), s);
        let key = format!("project:{}", dunce::canonicalize(&dir.0).unwrap().display());
        let json: serde_json::Value = serde_json::from_str(&store.setting(&key).unwrap().unwrap()).unwrap();
        assert_eq!(json["autoFix"], false);
        assert_eq!(json["maxFixRounds"], 3);
    }

    #[test]
    fn settings_clamp_rounds() {
        let dir = Dir::new();
        let store = Store::open_in_memory().unwrap();
        for (value, expected) in [(9, 5), (0, 1)] {
            save(&store, &dir.0, &ProjectSettings { max_fix_rounds: value, ..Default::default() }).unwrap();
            assert_eq!(load(&store, &dir.0).max_fix_rounds, expected);
        }
    }

    #[test]
    fn settings_bad_json_is_default() {
        let dir = Dir::new();
        let store = Store::open_in_memory().unwrap();
        let key = format!("project:{}", dunce::canonicalize(&dir.0).unwrap().display());
        store.set_setting(&key, "{bad").unwrap();
        assert_eq!(load(&store, &dir.0), ProjectSettings::default());
        store.set_setting(&key, r#"{"check":"npm test"}"#).unwrap();
        assert_eq!(load(&store, &dir.0), ProjectSettings { check: "npm test".into(), ..Default::default() });
        store.set_setting(&key, r#"{"maxFixRounds":9}"#).unwrap();
        assert_eq!(load(&store, &dir.0).max_fix_rounds, 5);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn setup_sees_root_and_worktree_env() {
        let root = Dir::new();
        let wt = Dir::new();
        let result = run_setup(&root.0, &wt.0, "echo \"$TG_ROOT_PATH:$TG_WORKTREE_PATH\"").await.unwrap();
        assert_eq!(result.code, Some(0));
        assert!(result.output.contains(root.0.to_str().unwrap()));
        assert!(result.output.contains(wt.0.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn setup_can_copy_ignored_file() {
        let root = Dir::new();
        let wt = Dir::new();
        fs::write(root.0.join(".gitignore"), ".env\n").unwrap();
        fs::write(root.0.join(".env"), "SECRET=test").unwrap();
        let result = run_setup(&root.0, &wt.0, "cp \"$TG_ROOT_PATH/.env\" .").await.unwrap();
        assert_eq!(result.code, Some(0));
        assert_eq!(fs::read_to_string(wt.0.join(".env")).unwrap(), "SECRET=test");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn script_timeout_kills() {
        let dir = Dir::new();
        // Measure script timeout independently of the machine's login profiles.
        env::login_path();
        let started = Instant::now();
        let result = run_script(&dir.0, "sleep 30", &[], Duration::from_secs(1)).await.unwrap();
        assert_eq!(result.code, None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_script_future_kills_child() {
        let dir = Dir::new();
        let mut script = Box::pin(run_script(&dir.0, "echo ready > ready; sh -c 'sleep 2; touch done'", &[], Duration::from_secs(30)));
        // Login PATH discovery may block the first poll. Wait for a shell-written
        // marker so this exercises a running child, not a future before spawn.
        tokio::select! {
            result = &mut script => panic!("script ended early: {result:?}"),
            ready = tokio::time::timeout(Duration::from_secs(10), async {
                while !dir.0.join("ready").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }) => ready.expect("script must have started"),
        }
        drop(script);
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(!dir.0.join("done").exists());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn project_check_uses_saved_command_and_scoped_run_directory() {
        use crate::{agents::adapters::AgentKind, store::NewRun, workspace::worktree::Worktree};
        let root = Dir::new();
        let wt = Dir::new();
        fs::create_dir(wt.0.join("sub")).unwrap();
        let store = Store::open_in_memory().unwrap();
        let run = NewRun { id: "run", agent: AgentKind::Claude, prompt: "", cwd: root.0.to_str().unwrap(), started_at: 0 };
        store.insert_run_with_worktree(&run, root.0.to_str().unwrap(), &Worktree {
            run_id: "run".into(), path: wt.0.clone(), branch: "".into(), base: "".into(),
        }, None).unwrap();
        store.set_run_thread("run", "thread", Some("sub")).unwrap();
        assert!(check_run(&store, "run").await.unwrap().is_none());
        save(&store, &root.0, &ProjectSettings {
            check: "printf '%s\n' \"$TG_ROOT_PATH\" \"$TG_WORKTREE_PATH\"; pwd; exit 3".into(),
            ..Default::default()
        }).unwrap();
        let result = check_run(&store, "run").await.unwrap().unwrap();
        assert_eq!(result.code, Some(3));
        assert!(result.output.contains(root.0.to_str().unwrap()));
        assert!(result.output.contains(wt.0.join("sub").to_str().unwrap()));
        assert!(check_run(&store, "missing").await.is_err());
        store.delete_runs(&["run".into()], 1).unwrap();
        assert!(check_run(&store, "run").await.is_err());
    }

}
