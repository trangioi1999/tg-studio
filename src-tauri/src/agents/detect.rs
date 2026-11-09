//! Finds which agent CLIs are installed and which version they are.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use crate::agents::adapters::AgentKind;
use crate::system::env;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    id: AgentKind,
    name: &'static str,
    binary: &'static str,
    path: Option<String>,
    version: Option<String>,
    headless: bool,
    /// "ok", "none", or "unknown" when the CLI has no way to tell.
    auth: &'static str,
}

/// Runs every agent at once: one slow CLI must not hold up the others.
#[tauri::command]
pub async fn detect_agents() -> Vec<DetectedAgent> {
    let checks: Vec<_> = AgentKind::ALL.into_iter().map(|kind| tauri::async_runtime::spawn(detect_one(kind))).collect();
    let mut found = Vec::new();
    for check in checks {
        if let Ok(agent) = check.await { found.push(agent); }
    }
    found
}

async fn detect_one(kind: AgentKind) -> DetectedAgent {
    let path = tauri::async_runtime::spawn_blocking(move || env::which(kind.binary()))
        .await
        .ok()
        .flatten();
    let (version, auth) = match &path {
        Some(p) => tokio::join!(version_of(p), auth_of(kind, p)),
        None => (None, "unknown"),
    };
    DetectedAgent {
        id: kind,
        name: kind.display_name(),
        binary: kind.binary(),
        path: path.map(|p| p.display().to_string()),
        version,
        headless: kind.headless_args("").is_some(),
        auth,
    }
}

/// The command that reports login without spending anything. None: no such command is known.
fn auth_command(kind: AgentKind) -> Option<&'static [&'static str]> {
    match kind {
        AgentKind::Claude => Some(&["auth", "status"]),
        AgentKind::Codex => Some(&["login", "status"]),
        // Kiro CLI docs: `whoami` shows the signed-in account (kiro.dev/docs/cli/reference/cli-commands).
        AgentKind::Kiro => Some(&["whoami"]),
        AgentKind::Gemini => None,
    }
}

/// None: the command could not run or did not answer, which says nothing about the login.
fn auth_from_exit(code: Option<i32>) -> &'static str {
    match code {
        Some(0) => "ok",
        Some(_) => "none",
        None => "unknown",
    }
}

/// Like `auth_from_exit`, but a CLI that exits 0 while saying it is signed out counts as signed out.
fn auth_from(code: Option<i32>, output: &str) -> &'static str {
    let said = output.to_lowercase();
    if code == Some(0) && (said.contains("not logged in") || said.contains("not signed in")) { return "none"; }
    auth_from_exit(code)
}

async fn auth_of(kind: AgentKind, path: &Path) -> &'static str {
    let Some(args) = auth_command(kind) else { return "unknown" };
    let run = env::command(path)
        .args(args)
        .env("PATH", env::login_path())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(8), run).await.ok().and_then(|r| r.ok()) {
        Some(out) => auth_from(out.status.code(), &format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))),
        None => "unknown",
    }
}

pub fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

async fn version_of(path: &Path) -> Option<String> {
    version_within(path, Duration::from_secs(8)).await
}

async fn version_within(path: &Path, limit: Duration) -> Option<String> {
    let run = env::command(path)
        .arg("--version")
        .env("PATH", env::login_path())
        .stdin(Stdio::null())
        // A CLI that hangs on --version must not outlive the probe.
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(limit, run).await.ok()?.ok()?;
    let text = if out.stdout.is_empty() { out.stderr } else { out.stdout };
    String::from_utf8_lossy(&text)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[tokio::test]
    async fn a_hanging_version_probe_is_killed_at_the_timeout() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("tg-hang-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("pid");
        let cli = dir.join("hang");
        std::fs::write(&cli, format!("#!/bin/sh\necho $$ > '{}'\nexec sleep 30\n", pid_file.display())).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Long enough for the fake CLI to start and write its pid even under a busy test run.
        assert_eq!(super::version_within(&cli, std::time::Duration::from_secs(2)).await, None);
        let pid = std::fs::read_to_string(&pid_file).unwrap().trim().to_owned();
        let mut alive = true;
        for _ in 0..40 {
            // A killed child may linger as a zombie until it is reaped: that is not running.
            let state = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid]).output().unwrap();
            alive = !String::from_utf8_lossy(&state.stdout).trim().is_empty() && !String::from_utf8_lossy(&state.stdout).contains('Z');
            if !alive { break; }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = std::process::Command::new("kill").arg(&pid).status();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!alive, "the probe outlived its timeout");
    }

    use super::*;

    #[test]
    fn login_comes_from_the_exit_code_only_when_there_is_one() {
        assert_eq!(auth_from_exit(Some(0)), "ok");
        assert_eq!(auth_from_exit(Some(1)), "none");
        assert_eq!(auth_from_exit(None), "unknown");
    }

    #[test]
    fn only_verified_login_commands_are_used() {
        assert_eq!(auth_command(AgentKind::Claude), Some(&["auth", "status"][..]));
        assert_eq!(auth_command(AgentKind::Codex), Some(&["login", "status"][..]));
        assert_eq!(auth_command(AgentKind::Gemini), None);
        assert_eq!(auth_command(AgentKind::Kiro), Some(&["whoami"][..]));
    }

    #[test]
    fn signed_out_text_wins_over_a_zero_exit() {
        assert_eq!(auth_from(Some(0), "Logged in with Builder ID\nEmail: a@b.c"), "ok");
        assert_eq!(auth_from(Some(0), "Not logged in"), "none");
        assert_eq!(auth_from(Some(1), ""), "none");
        assert_eq!(auth_from(None, ""), "unknown");
    }
}
