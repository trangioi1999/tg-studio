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
