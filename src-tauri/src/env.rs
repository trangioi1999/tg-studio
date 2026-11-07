//! Apps opened from Finder/Dock on macOS start with a minimal PATH, so CLIs
//! installed through nvm, Homebrew or npm are invisible to them. We ask the
//! user's login shell for its PATH once and use it for every child process.

use std::path::PathBuf;
use std::sync::OnceLock;

static LOGIN_PATH: OnceLock<(String, PathSource)> = OnceLock::new();

/// How the PATH was found, for the diagnostics report: a slow shell startup file used to
/// leave the app with macOS's minimal PATH and no agent at all.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSource {
    pub shell: Option<String>,
    /// "shell", "timeout" (the shell did not answer in time), "failed", or "inherited" (Windows).
    pub outcome: &'static str,
    pub millis: u64,
    /// Well-known install folders added because the shell PATH lacked them.
    pub added: Vec<String>,
}

pub fn login_path() -> String {
    LOGIN_PATH.get_or_init(resolve_path).0.clone()
}

pub fn path_source() -> PathSource {
    LOGIN_PATH.get_or_init(resolve_path).1.clone()
}

fn resolve_path() -> (String, PathSource) {
    let started = std::time::Instant::now();
    let (path, shell, outcome) = read_login_path();
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let (path, added) = with_known_dirs(&path, home.as_deref());
    let added = added.iter().map(|d| d.to_string_lossy().into_owned()).collect();
    (path, PathSource { shell, outcome, millis: started.elapsed().as_millis() as u64, added })
}

/// Folders where agent CLIs and Node usually live, appended (when they exist and are
/// missing) after the shell's own PATH, so its order still wins.
fn known_dirs(home: Option<&std::path::Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = home {
        // nvm: every installed Node, newest first by name.
        let mut nvm: Vec<PathBuf> = std::fs::read_dir(home.join(".nvm/versions/node")).map(|r| r.flatten().map(|e| e.path().join("bin")).collect()).unwrap_or_default();
        nvm.sort();
        nvm.reverse();
        dirs.extend(nvm);
        for rel in [".local/bin", ".npm-global/bin", ".volta/bin", ".bun/bin", ".fnm/aliases/default/bin", ".local/share/fnm/aliases/default/bin",
            "Library/pnpm", ".asdf/shims", ".claude/local", ".cargo/bin", "AppData/Roaming/npm"] {
            dirs.push(home.join(rel));
        }
    }
    #[cfg(unix)]
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    dirs
}

fn with_known_dirs(path: &str, home: Option<&std::path::Path>) -> (String, Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = std::env::split_paths(path).filter(|p| !p.as_os_str().is_empty()).collect();
    let mut added = Vec::new();
    for dir in known_dirs(home) {
        if dir.is_dir() && !entries.contains(&dir) {
            entries.push(dir.clone());
            added.push(dir);
        }
    }
    (std::env::join_paths(&entries).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| path.to_string()), added)
}

/// A shell startup file can wait on something forever, and then nothing could ever be
/// detected. Heavy setups (oh-my-zsh, nvm, conda) on older Macs take several seconds.
#[cfg(unix)]
const SHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// Stdout up to `marker`, or None if it has not appeared in time. Does not wait for the
/// process to end, since something it left in the background can hold the pipe open.
#[cfg(unix)]
fn output_until(mut command: std::process::Command, marker: &str, timeout: std::time::Duration) -> Option<String> {
    use std::{io::Read, process::Stdio, sync::mpsc};
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    let marker = marker.to_string();
    std::thread::spawn(move || {
        let (mut seen, mut buffer) = (Vec::new(), [0; 4096]);
        while let Ok(n) = stdout.read(&mut buffer) {
            if n == 0 { break; }
            seen.extend_from_slice(&buffer[..n]);
            if String::from_utf8_lossy(&seen).contains(&marker) { break; }
        }
        let _ = tx.send(String::from_utf8_lossy(&seen).into_owned());
    });
    let text = rx.recv_timeout(timeout).ok();
    let _ = child.kill();
    std::thread::spawn(move || { let _ = child.wait(); });
    text
}

#[cfg(unix)]
fn read_login_path() -> (String, Option<String>, &'static str) {
    const START: &str = "__TG_PATH__";
    const END: &str = "__END__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut command = std::process::Command::new(&shell);
    command.args(["-ilc", "printf '__TG_PATH__%s__END__' \"$PATH\""]);
    let inherited = std::env::var("PATH").unwrap_or_default();
    let Some(text) = output_until(command, END, SHELL_TIMEOUT) else { return (inherited, Some(shell), "timeout") };
    if let Some(start) = text.find(START) {
        let rest = &text[start + START.len()..];
        if let Some(end) = rest.find(END) {
            return (rest[..end].to_string(), Some(shell), "shell");
        }
    }
    (inherited, Some(shell), "failed")
}

#[cfg(windows)]
fn read_login_path() -> (String, Option<String>, &'static str) {
    (std::env::var("PATH").unwrap_or_default(), None, "inherited")
}

/// Hides the console Windows would otherwise open for each child of this GUI app.
/// The child's output goes through pipes, so that window stays empty and looks hung,
/// and closing it kills the agent. Descendants inherit the hidden console.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Every asynchronous child process starts here, never from `Command::new`.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Like `command`, for code that blocks its thread.
pub fn std_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Gives a child its own process group, so `kill_tree` also reaches what it starts.
pub fn isolate(cmd: &mut tokio::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    #[cfg(not(unix))]
    let _ = cmd;
}

/// Stops a process and its descendants. npm shims and shells are wrappers: killing only
/// them leaves the real program running, still spending tokens or writing files.
pub async fn kill_tree(pid: u32) {
    #[cfg(unix)]
    let mut kill = {
        let mut c = command("kill");
        c.args(["-KILL", "--", &format!("-{pid}")]);
        c
    };
    #[cfg(windows)]
    let mut kill = {
        let mut c = command("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        c
    };
    kill.env("PATH", login_path()).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null()).kill_on_drop(true);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), kill.status()).await;
}

/// A subfolder an agent works from. It is where the agent starts, not a fence.
pub fn scoped_dir(base: &std::path::Path, scope: Option<&str>) -> Result<PathBuf, String> {
    let Some(scope) = scope.filter(|s| !s.is_empty()) else { return Ok(base.to_path_buf()); };
    let relative = std::path::Path::new(scope);
    if relative.is_absolute() || relative.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(format!("Thư mục không hợp lệ: {scope}"));
    }
    let dir = base.join(relative);
    if !dir.is_dir() { return Err(format!("Thư mục {scope} không có ở đây. Nếu nó chưa được commit thì bản nháp chưa có nó.")); }
    Ok(dir)
}

/// Finds an executable on the login PATH (handles .cmd/.exe shims on Windows).
pub fn which(bin: &str) -> Option<PathBuf> {
    let path = login_path();
    for dir in std::env::split_paths(&path) {
        #[cfg(windows)]
        for ext in ["exe", "cmd", "bat"] {
            let candidate = dir.join(format!("{bin}.{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        #[cfg(not(windows))]
        {
            let candidate = dir.join(bin);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    #[test]
    fn known_install_folders_are_added_after_the_shell_path() {
        let home = std::env::temp_dir().join(format!("tg-home-{}", uuid::Uuid::new_v4()));
        for dir in [".nvm/versions/node/v20.11.0/bin", ".nvm/versions/node/v22.3.0/bin", ".local/bin"] { fs::create_dir_all(home.join(dir)).unwrap(); }
        let local = home.join(".local/bin");
        let shell = std::env::join_paths([Path::new("/usr/bin"), local.as_path()]).unwrap();
        let (path, added) = super::with_known_dirs(&shell.to_string_lossy(), Some(&home));
        let entries: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(entries[0], Path::new("/usr/bin"));
        assert_eq!(entries[1], local, "the shell's order wins and nothing is added twice");
        assert_eq!(added[0], home.join(".nvm/versions/node/v22.3.0/bin"), "newest Node first");
        assert_eq!(added[1], home.join(".nvm/versions/node/v20.11.0/bin"));
        assert!(!added.contains(&local));
        assert!(added.iter().all(|d| d.is_dir()), "folders that do not exist are left out");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_scope_stays_inside_its_project() {
        let base = std::env::temp_dir().join(format!("tg-scope-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(base.join("goi/api")).unwrap();
        assert_eq!(super::scoped_dir(&base, None).unwrap(), base);
        assert_eq!(super::scoped_dir(&base, Some("")).unwrap(), base);
        assert_eq!(super::scoped_dir(&base, Some("goi/api")).unwrap(), base.join("goi/api"));
        for bad in ["../x", "goi/../..", "/tmp", "./goi"] {
            assert!(super::scoped_dir(&base, Some(bad)).unwrap_err().contains("không hợp lệ"), "{bad}");
        }
        assert!(super::scoped_dir(&base, Some("khong-co")).unwrap_err().contains("chưa được commit"));
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn output_stops_at_the_marker_and_gives_up_on_a_stuck_shell() {
        use std::time::{Duration, Instant};
        let shell = |script: &str| { let mut c = std::process::Command::new("sh"); c.args(["-c", script]); c };
        let started = Instant::now();
        let text = super::output_until(shell("printf 'a__END__'; sleep 30"), "__END__", Duration::from_secs(10)).unwrap();
        assert!(text.contains("a__END__"));
        assert!(started.elapsed() < Duration::from_secs(5), "không được chờ tiến trình kết thúc");
        let started = Instant::now();
        assert_eq!(super::output_until(shell("sleep 30"), "__END__", Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_tree_stops_descendants() {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut cmd = super::command("sh");
        cmd.args(["-c", "sleep 30 & echo $!; wait"]).stdout(std::process::Stdio::piped()).kill_on_drop(true);
        super::isolate(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let sleeper = lines.next_line().await.unwrap().unwrap();
        super::kill_tree(child.id().unwrap()).await;
        let _ = child.wait().await;
        let mut alive = true;
        for _ in 0..40 {
            alive = super::command("kill").args(["-0", &sleeper]).stderr(std::process::Stdio::null()).status().await.unwrap().success();
            if !alive { break; }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(!alive, "tiến trình con vẫn chạy");
    }

    fn collect(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                collect(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// A GUI app has no console, so on Windows any child started without
    /// CREATE_NO_WINDOW opens an empty console; closing it kills the agent.
    #[test]
    fn child_processes_start_through_the_helpers() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        collect(&src, &mut files);
        assert!(files.len() > 10, "source files not found");
        let needle = ["Command", "::new("].concat();
        let offenders: Vec<_> = files.iter()
            .filter(|path| path.file_name().unwrap() != "env.rs")
            .filter(|path| {
                let text = fs::read_to_string(path).unwrap();
                let production = text.split("#[cfg(test)]").next().unwrap();
                production.contains(&needle)
            })
            .collect();
        assert!(offenders.is_empty(), "dùng env::command thay cho Command::new: {offenders:?}");
    }
}
