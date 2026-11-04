//! Apps opened from Finder/Dock on macOS start with a minimal PATH, so CLIs
//! installed through nvm, Homebrew or npm are invisible to them. We ask the
//! user's login shell for its PATH once and use it for every child process.

use std::path::PathBuf;
use std::sync::OnceLock;

static LOGIN_PATH: OnceLock<String> = OnceLock::new();

pub fn login_path() -> String {
    LOGIN_PATH.get_or_init(read_login_path).clone()
}

#[cfg(unix)]
fn read_login_path() -> String {
    const START: &str = "__TG_PATH__";
    const END: &str = "__END__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = std::process::Command::new(&shell)
        .args(["-ilc", "printf '__TG_PATH__%s__END__' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .output();
    if let Ok(out) = output {
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(start) = text.find(START) {
            let rest = &text[start + START.len()..];
            if let Some(end) = rest.find(END) {
                return rest[..end].to_string();
            }
        }
    }
    std::env::var("PATH").unwrap_or_default()
}

#[cfg(windows)]
fn read_login_path() -> String {
    std::env::var("PATH").unwrap_or_default()
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
