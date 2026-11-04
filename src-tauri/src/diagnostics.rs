//! A local diagnostics report the user can save and send by hand. Nothing is sent
//! anywhere by the app. Secrets (MCP env values, headers) are left out.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::{detect, mcp, store::Store};

const RUNS: usize = 30;
const STDERR_PER_RUN: usize = 20;

pub fn short(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max { out.push('…'); }
    out
}

/// Runs and MCP servers in the shape the report uses; separate so it can be tested.
pub fn summarize(store: &Store) -> Value {
    let runs: Vec<Value> = store.list_runs(RUNS).unwrap_or_default().into_iter().map(|r| {
        let all: Vec<String> = r.lines.iter().filter(|l| l.kind == "stderr").map(|l| short(&l.line, 400)).collect();
        let stderr = all[all.len().saturating_sub(STDERR_PER_RUN)..].to_vec();
        json!({
            "id": r.id, "agent": r.agent, "status": r.status, "exitCode": r.exit_code,
            "startedAt": r.started_at, "endedAt": r.ended_at, "prompt": short(&r.prompt, 80),
            "task": r.worktree.is_some(), "group": r.group, "usage": r.usage, "stderr": stderr,
        })
    }).collect();
    let servers: Vec<Value> = mcp::load(store).into_iter().map(|s| json!({
        "name": s.name, "transport": s.transport, "agents": s.agents,
        "envNames": s.env.iter().map(|p| p.name.clone()).collect::<Vec<_>>(),
        "headerNames": s.headers.iter().map(|p| p.name.clone()).collect::<Vec<_>>(),
    })).collect();
    json!({ "runs": runs, "mcpServers": servers, "limits": store.all_limits().unwrap_or_default() })
}

#[tauri::command]
pub async fn diagnostics(app: AppHandle, store: State<'_, Store>) -> Result<Value, String> {
    let mut report = summarize(&store);
    report["app"] = json!({ "name": "TG Studio", "version": env!("CARGO_PKG_VERSION") });
    report["os"] = json!({ "family": std::env::consts::OS, "arch": std::env::consts::ARCH });
    report["generatedAt"] = json!(crate::runner::now_ms());
    report["dataDir"] = json!(app.path().app_data_dir().ok().map(|p| p.to_string_lossy().into_owned()));
    report["agents"] = serde_json::to_value(detect::detect_agents().await).map_err(|e| e.to_string())?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{adapters::AgentKind, mcp::{McpServer, NameValue}, store::NewRun};

    #[test]
    fn report_keeps_recent_stderr_and_drops_secrets() {
        let store = Store::open_in_memory().unwrap();
        store.insert_run(&NewRun { id: "a", agent: AgentKind::Claude, prompt: &"x".repeat(200), cwd: "/", started_at: 1 }).unwrap();
        for i in 0..25 { store.append_line("a", "stderr", &format!("lỗi {i}"), 2 + i).unwrap(); }
        store.append_line("a", "log", "not an error", 50).unwrap();
        let server = McpServer { id: "1".into(), name: "gh".into(), transport: "stdio".into(), command: Some("npx".into()), args: vec![],
            env: vec![NameValue { name: "GITHUB_TOKEN".into(), value: "ghp_secret".into() }], url: None,
            headers: vec![NameValue { name: "Authorization".into(), value: "Bearer secret".into() }], agents: vec![AgentKind::Claude] };
        store.save_mcp_server("1", &serde_json::to_string(&server).unwrap()).unwrap();
        let report = summarize(&store);
        let stderr = report["runs"][0]["stderr"].as_array().unwrap();
        assert_eq!(stderr.len(), 20);
        assert_eq!(stderr.last().unwrap(), "lỗi 24");
        assert_eq!(report["runs"][0]["prompt"].as_str().unwrap().chars().count(), 81);
        let text = report.to_string();
        assert!(!text.contains("ghp_secret") && !text.contains("Bearer secret"));
        assert_eq!(report["mcpServers"][0]["envNames"], json!(["GITHUB_TOKEN"]));
    }
}
