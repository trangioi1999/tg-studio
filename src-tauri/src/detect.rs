//! Finds which agent CLIs are installed and which version they are.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use crate::adapters::AgentKind;
use crate::env;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    id: AgentKind,
    name: &'static str,
    binary: &'static str,
    path: Option<String>,
    version: Option<String>,
    headless: bool,
}

#[tauri::command]
pub async fn detect_agents() -> Vec<DetectedAgent> {
    let mut found = Vec::new();
    for kind in AgentKind::ALL {
        let path = tauri::async_runtime::spawn_blocking(move || env::which(kind.binary()))
            .await
            .ok()
            .flatten();
        let version = match &path {
            Some(p) => version_of(p).await,
            None => None,
        };
        found.push(DetectedAgent {
            id: kind,
            name: kind.display_name(),
            binary: kind.binary(),
            path: path.map(|p| p.display().to_string()),
            version,
            headless: kind.headless_args("").is_some(),
        });
    }
    found
}

#[tauri::command]
pub fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

async fn version_of(path: &Path) -> Option<String> {
    let run = tokio::process::Command::new(path)
        .arg("--version")
        .env("PATH", env::login_path())
        .stdin(Stdio::null())
        .output();
    let out = tokio::time::timeout(Duration::from_secs(8), run).await.ok()?.ok()?;
    let text = if out.stdout.is_empty() { out.stderr } else { out.stdout };
    String::from_utf8_lossy(&text)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}
