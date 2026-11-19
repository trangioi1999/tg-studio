//! MCP server registry. Servers enabled for an agent are handed to every session it
//! starts (ACP `session/new`, Claude headless `--mcp-config`), so nothing is written
//! into the agents' own config files.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::State;

use crate::{agents::adapters::AgentKind, store::Store};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameValue {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    /// What agents see; letters, digits, `-` and `_`.
    pub name: String,
    /// "stdio" or "http".
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<NameValue>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Vec<NameValue>,
    /// Agents that get this server.
    #[serde(default)]
    pub agents: Vec<AgentKind>,
}

pub fn validate(s: &McpServer, others: &[McpServer]) -> Result<(), String> {
    if s.name.is_empty() || !s.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Tên server chỉ gồm chữ, số, - và _.".into());
    }
    if others.iter().any(|o| o.id != s.id && o.name == s.name) {
        return Err(format!("Đã có server tên {}.", s.name));
    }
    match s.transport.as_str() {
        "stdio" if s.command.as_deref().is_some_and(|c| !c.trim().is_empty()) => {}
        "stdio" => return Err("Server stdio cần lệnh chạy.".into()),
        "http" if s.url.as_deref().is_some_and(|u| u.starts_with("http://") || u.starts_with("https://")) => {}
        "http" => return Err("Server http cần URL bắt đầu bằng http:// hoặc https://.".into()),
        _ => return Err("Kiểu kết nối phải là stdio hoặc http.".into()),
    }
    if s.env.iter().chain(&s.headers).any(|p| p.name.trim().is_empty() || p.name.contains('=')) {
        return Err("Tên biến môi trường / header không hợp lệ.".into());
    }
    Ok(())
}

/// Servers for one agent's ACP session. HTTP needs the agent to say it supports it in
/// `initialize`; the names of skipped servers are returned so the user can be told.
pub fn for_acp(servers: &[McpServer], agent: AgentKind, init: &Value) -> (Value, Vec<String>) {
    let http_ok = init["agentCapabilities"]["mcpCapabilities"]["http"].as_bool() == Some(true);
    let pairs = |list: &[NameValue]| list.iter().map(|p| json!({"name": p.name, "value": p.value})).collect::<Vec<_>>();
    let mut skipped = Vec::new();
    let mut out = Vec::new();
    for s in servers.iter().filter(|s| s.agents.contains(&agent)) {
        match s.transport.as_str() {
            "stdio" => out.push(json!({"name": s.name, "command": s.command, "args": s.args, "env": pairs(&s.env)})),
            "http" if http_ok => out.push(json!({"type": "http", "name": s.name, "url": s.url, "headers": pairs(&s.headers)})),
            _ => skipped.push(s.name.clone()),
        }
    }
    (Value::Array(out), skipped)
}

/// `--mcp-config` JSON for Claude Code headless runs, or None when nothing is enabled.
pub fn claude_config(servers: &[McpServer]) -> Option<String> {
    let map = |list: &[NameValue]| list.iter().map(|p| (p.name.clone(), Value::String(p.value.clone()))).collect::<Map<_, _>>();
    let entries: Map<String, Value> = servers.iter().filter(|s| s.agents.contains(&AgentKind::Claude)).map(|s| {
        let v = if s.transport == "http" {
            json!({"type": "http", "url": s.url, "headers": map(&s.headers)})
        } else {
            json!({"command": s.command, "args": s.args, "env": map(&s.env)})
        };
        (s.name.clone(), v)
    }).collect();
    (!entries.is_empty()).then(|| json!({"mcpServers": entries}).to_string())
}

/// The `--mcp-config` of a headless Claude run, as a file readable only by this user and
/// removed when dropped: the JSON holds tokens and headers, and every user on the machine
/// can read a process's arguments. Keep it alive until the process exits.
pub struct ConfigFile(std::path::PathBuf);
impl ConfigFile {
    pub fn write(servers: &[McpServer], dir: &std::path::Path) -> Result<Option<Self>, String> {
        let Some(config) = claude_config(servers) else { return Ok(None) };
        let path = dir.join(format!("tg-mcp-{}.json", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let file = Self(path);
        let mut handle = options.open(&file.0).map_err(|e| format!("Không ghi được cấu hình MCP: {e}"))?;
        std::io::Write::write_all(&mut handle, config.as_bytes()).map_err(|e| format!("Không ghi được cấu hình MCP: {e}"))?;
        Ok(Some(file))
    }
    pub fn arg(&self) -> String { self.0.to_string_lossy().into_owned() }
}
impl Drop for ConfigFile {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

pub fn load(store: &Store) -> Vec<McpServer> {
    store.mcp_servers().unwrap_or_default().into_iter().filter_map(|raw| serde_json::from_str(&raw).ok()).collect()
}

#[tauri::command(async)]
pub fn list_mcp_servers(store: State<'_, Store>) -> Vec<McpServer> {
    load(&store)
}

#[tauri::command(async)]
pub fn save_mcp_server(store: State<'_, Store>, server: McpServer) -> Result<McpServer, String> {
    let mut server = server;
    if server.id.trim().is_empty() { server.id = uuid::Uuid::new_v4().to_string(); }
    validate(&server, &load(&store))?;
    let raw = serde_json::to_string(&server).map_err(|e| e.to_string())?;
    store.save_mcp_server(&server.id, &raw).map_err(|e| format!("Không lưu được server: {e}"))?;
    Ok(server)
}

#[tauri::command(async)]
pub fn delete_mcp_server(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.delete_mcp_server(&id).map_err(|e| format!("Không xóa được server: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(name: &str, agents: Vec<AgentKind>) -> McpServer {
        McpServer { id: name.into(), name: name.into(), transport: "stdio".into(), command: Some("npx".into()), args: vec!["-y".into(), "srv".into()],
            env: vec![NameValue { name: "TOKEN".into(), value: "s3cr3t".into() }], url: None, headers: vec![], agents }
    }
    fn http(name: &str) -> McpServer {
        McpServer { id: name.into(), name: name.into(), transport: "http".into(), command: None, args: vec![], env: vec![],
            url: Some("https://mcp.example/x".into()), headers: vec![NameValue { name: "Authorization".into(), value: "Bearer t".into() }], agents: vec![AgentKind::Claude, AgentKind::Codex] }
    }

    #[test]
    fn validation_rejects_bad_servers() {
        assert!(validate(&stdio("docs", vec![]), &[]).is_ok());
        assert!(validate(&http("web"), &[]).is_ok());
        assert!(validate(&stdio("bad name", vec![]), &[]).is_err());
        assert!(validate(&McpServer { command: None, ..stdio("x", vec![]) }, &[]).is_err());
        assert!(validate(&McpServer { url: Some("ftp://x".into()), ..http("y") }, &[]).is_err());
        assert!(validate(&McpServer { transport: "sse".into(), ..http("y") }, &[]).is_err());
        assert!(validate(&McpServer { id: "other".into(), ..stdio("docs", vec![]) }, &[stdio("docs", vec![])]).unwrap_err().contains("Đã có"));
        assert!(validate(&McpServer { env: vec![NameValue { name: "A=B".into(), value: "".into() }], ..stdio("z", vec![]) }, &[]).is_err());
    }

    #[test]
    fn acp_session_gets_enabled_servers_and_http_only_when_supported() {
        let servers = vec![stdio("docs", vec![AgentKind::Codex]), stdio("claude-only", vec![AgentKind::Claude]), http("web")];
        let (value, skipped) = for_acp(&servers, AgentKind::Codex, &json!({"agentCapabilities": {}}));
        assert_eq!(value, json!([{"name":"docs","command":"npx","args":["-y","srv"],"env":[{"name":"TOKEN","value":"s3cr3t"}]}]));
        assert_eq!(skipped, vec!["web"]);
        let (value, skipped) = for_acp(&servers, AgentKind::Claude, &json!({"agentCapabilities": {"mcpCapabilities": {"http": true}}}));
        assert_eq!(value[1], json!({"type":"http","name":"web","url":"https://mcp.example/x","headers":[{"name":"Authorization","value":"Bearer t"}]}));
        assert!(skipped.is_empty());
        assert_eq!(for_acp(&servers, AgentKind::Gemini, &json!({})).0, json!([]));
    }

    /// Any user on the machine can read a process's arguments (`ps auxww`), so the
    /// secrets go in a file only this user can read, gone when the run ends.
    #[test]
    fn claude_config_goes_in_a_private_file_removed_after_the_run() {
        let dir = std::env::temp_dir().join(format!("tg-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(ConfigFile::write(&[stdio("docs", vec![AgentKind::Codex])], &dir).unwrap().is_none());
        let servers = [stdio("docs", vec![AgentKind::Claude])];
        let file = ConfigFile::write(&servers, &dir).unwrap().unwrap();
        let path = std::path::PathBuf::from(file.arg());
        assert!(path.starts_with(&dir) && !file.arg().contains("s3cr3t"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), claude_config(&servers).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        drop(file);
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn claude_headless_config() {
        assert_eq!(claude_config(&[stdio("docs", vec![AgentKind::Codex])]), None);
        let cfg: Value = serde_json::from_str(&claude_config(&[stdio("docs", vec![AgentKind::Claude]), http("web")]).unwrap()).unwrap();
        assert_eq!(cfg["mcpServers"]["docs"], json!({"command":"npx","args":["-y","srv"],"env":{"TOKEN":"s3cr3t"}}));
        assert_eq!(cfg["mcpServers"]["web"], json!({"type":"http","url":"https://mcp.example/x","headers":{"Authorization":"Bearer t"}}));
    }
}
