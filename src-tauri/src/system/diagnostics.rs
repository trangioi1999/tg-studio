//! A local diagnostics report the user can save and send by hand. Nothing is sent
//! anywhere by the app. Secrets (MCP env values, headers) are left out.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::{agents::detect, integrations::mcp, store::Store};

const RUNS: usize = 30;
const STDERR_PER_RUN: usize = 20;

pub fn short(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max { out.push('…'); }
    out
}

/// The home folder as `~`, so the report does not carry the user's name.
pub fn tilde(text: &str, home: &str) -> String {
    if home.len() > 1 { text.replace(home, "~") } else { text.to_string() }
}

const TOKEN_PREFIXES: &[&str] = &[
    "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "sk-", "sk_live_", "sk_test_", "rk_live_",
    "xoxb-", "xoxp-", "xoxa-", "xoxs-", "AKIA", "ASIA", "AIza", "eyJ", "npm_", "hf_",
];
const SECRET_NAMES: &[&str] = &["token", "secret", "password", "passwd", "pwd", "apikey", "api_key", "api-key", "_key", "credential"];

fn token_char(c: char) -> bool { c.is_ascii_alphanumeric() || "_-.+/=".contains(c) }
fn value_end(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && !chars[i].is_whitespace() && !"'\"@,;)".contains(chars[i]) { i += 1; }
    i
}

/// Hides what looks like a credential: known token prefixes, `Bearer …`, and the value of
/// `NAME=…` / `name: …` when the name says secret. A best effort for a report the user
/// sends by hand, not a guarantee.
pub fn redact(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let starts = |i: usize, word: &str, ci: bool| {
        let w: Vec<char> = word.chars().collect();
        i + w.len() <= chars.len() && chars[i..i + w.len()].iter().zip(&w).all(|(a, b)| if ci { a.eq_ignore_ascii_case(b) } else { a == b })
    };
    while i < chars.len() {
        let boundary = i == 0 || !chars[i - 1].is_ascii_alphanumeric();
        if boundary {
            if let Some(prefix) = TOKEN_PREFIXES.iter().find(|p| starts(i, p, false)) {
                let mut end = i + prefix.chars().count();
                while end < chars.len() && token_char(chars[end]) { end += 1; }
                if end - i >= prefix.chars().count() + 8 { out.push_str("***"); i = end; continue; }
            }
            if let Some(scheme) = ["bearer ", "basic ", "token "].iter().find(|p| starts(i, p, true)) {
                let start = i + scheme.len();
                let end = value_end(&chars, start);
                if end > start {
                    out.extend(&chars[i..start]);
                    out.push_str("***");
                    i = end;
                    continue;
                }
            }
        }
        if chars[i] == '=' || chars[i] == ':' {
            let mut key = i;
            while key > 0 && (chars[key - 1].is_ascii_alphanumeric() || "_-".contains(chars[key - 1])) { key -= 1; }
            let name: String = chars[key..i].iter().collect::<String>().to_lowercase();
            if SECRET_NAMES.iter().any(|s| name.contains(s)) {
                let mut start = i + 1;
                if chars[i] == ':' { while start < chars.len() && chars[start] == ' ' { start += 1; } }
                let end = value_end(&chars, start);
                if end > start {
                    out.extend(&chars[i..start]);
                    out.push_str("***");
                    i = end;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Runs and MCP servers in the shape the report uses; separate so it can be tested.
pub fn summarize(store: &Store, home: &str) -> Value {
    let clean = |text: &str, max: usize| short(&tilde(&redact(text), home), max);
    let runs: Vec<Value> = store.list_runs(RUNS).unwrap_or_default().into_iter().map(|r| {
        let all: Vec<String> = r.lines.iter().filter(|l| l.kind == "stderr").map(|l| clean(&l.line, 400)).collect();
        let stderr = all[all.len().saturating_sub(STDERR_PER_RUN)..].to_vec();
        json!({
            "id": r.id, "agent": r.agent, "status": r.status, "exitCode": r.exit_code,
            "startedAt": r.started_at, "endedAt": r.ended_at, "prompt": clean(&r.prompt, 80),
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
    let home = detect::home_dir().unwrap_or_default();
    let mut report = summarize(&store, &home);
    report["app"] = json!({ "name": "TG Studio", "version": env!("CARGO_PKG_VERSION") });
    report["os"] = json!({ "family": std::env::consts::OS, "arch": std::env::consts::ARCH });
    report["generatedAt"] = json!(crate::system::clock::now_ms());
    report["dataDir"] = json!(app.path().app_data_dir().ok().map(|p| tilde(&p.to_string_lossy(), &home)));
    report["agents"] = serde_json::to_value(detect::detect_agents().await).map_err(|e| e.to_string())?;
    // Why an agent is not found is almost always the PATH. The home folder is shortened to ~.
    let tilde = |p: &str| if !home.is_empty() && p.starts_with(&home) { format!("~{}", &p[home.len()..]) } else { p.to_string() };
    let source = crate::system::env::path_source();
    report["path"] = json!({
        "shell": source.shell, "outcome": source.outcome, "millis": source.millis,
        "added": source.added.iter().map(|p| tilde(p)).collect::<Vec<_>>(),
        "entries": std::env::split_paths(&crate::system::env::login_path()).map(|p| tilde(&p.to_string_lossy())).collect::<Vec<_>>(),
    });
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{agents::adapters::AgentKind, integrations::mcp::{McpServer, NameValue}, store::NewRun};

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
        let report = summarize(&store, "");
        let stderr = report["runs"][0]["stderr"].as_array().unwrap();
        assert_eq!(stderr.len(), 20);
        assert_eq!(stderr.last().unwrap(), "lỗi 24");
        assert_eq!(report["runs"][0]["prompt"].as_str().unwrap().chars().count(), 81);
        let text = report.to_string();
        assert!(!text.contains("ghp_secret") && !text.contains("Bearer secret"));
        assert_eq!(report["mcpServers"][0]["envNames"], json!(["GITHUB_TOKEN"]));
    }

    /// Stderr holds whole commands ("Đã tự động từ chối lệnh bị cấm: …"), tokens included.
    #[test]
    fn stderr_and_prompt_lose_tokens_and_the_home_folder() {
        let store = Store::open_in_memory().unwrap();
        store.insert_run(&NewRun { id: "a", agent: AgentKind::Claude, prompt: "dùng token ghp_abcdefghijklmnopqrstuvwxyz0123456789 nhé", cwd: "/", started_at: 1 }).unwrap();
        let lines = [
            "Đã tự động từ chối lệnh bị cấm: git push https://x:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r",
            "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' https://api",
            "OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234 npm test",
            "slack xoxb-1234-5678-abcdefgh aws AKIAABCDEFGHIJKLMNOP github_pat_11ABCDEFG0123456789_abcdef",
            "--password=hunter2 api_key: zzz123secret",
            "không đọc được /Users/alice/project/a.ts",
        ];
        for (i, line) in lines.iter().enumerate() { store.append_line("a", "stderr", line, 2 + i as u64).unwrap(); }
        let report = summarize(&store, "/Users/alice");
        let text = report.to_string();
        for secret in ["ghp_abc", "eyJhbGci", "sk-proj", "xoxb-1234", "AKIAABCD", "github_pat_11", "hunter2", "zzz123secret", "alice"] {
            assert!(!text.contains(secret), "{secret} còn trong {text}");
        }
        assert!(text.contains("~/project/a.ts") && text.contains("npm test") && text.contains("git push"), "{text}");
    }
}
