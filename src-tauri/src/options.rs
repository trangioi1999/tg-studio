//! Model and effort choices. ACP agents describe their session settings as
//! `configOptions` (see claude-agent-acp's `session-config-ids.js`); the app reads the
//! model and effort selects from there instead of keeping its own list.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::client::{method_not_found, AcpClient, ClientHandler, HandlerFuture};
use crate::adapters::{setup_timeout, AgentKind};
use crate::env;

/// What the user picked in the composer. `None` keeps the agent's own default.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPrefs {
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl SessionPrefs {
    pub fn is_empty(&self) -> bool { self.model.is_none() && self.effort.is_none() }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSelect {
    pub id: String,
    pub current: String,
    pub options: Vec<Choice>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentOptions {
    pub model: Option<ConfigSelect>,
    pub effort: Option<ConfigSelect>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    pub name: String,
    pub description: String,
    pub kind: String,
    pub source: Option<String>,
    pub plugin: Option<String>,
    pub hint: Option<String>,
    pub insert: String,
}

pub fn parse_commands(agent: AgentKind, update: &Value, cwd: Option<&Path>) -> Vec<AgentCommand> {
    let Some(commands) = update["availableCommands"].as_array() else { return vec![]; };
    commands.iter().filter_map(|command| {
        let name = command["name"].as_str().filter(|name| !name.is_empty())?;
        let mut description = command["description"].as_str().unwrap_or_default();
        let mut source = None;
        let mut plugin = None;
        let mut kind = "command";
        let mut insert = format!("/{name} ");
        match agent {
            AgentKind::Claude => {
                if let Some(text) = description.strip_suffix(" (project)") {
                    description = text;
                    source = Some("project".into());
                    kind = "skill";
                } else if let Some(text) = description.strip_suffix(" (user)") {
                    description = text;
                    source = Some("user".into());
                    kind = "skill";
                } else if name.contains(':') {
                    if let Some((prefix, text)) = description.strip_prefix('(').and_then(|d| d.split_once(") ")) {
                        description = text;
                        source = Some("plugin".into());
                        plugin = Some(prefix.to_string());
                        kind = "skill";
                    }
                }
            }
            AgentKind::Codex => {
                if let Some(skill) = name.strip_prefix('$') {
                    kind = "skill";
                    insert = format!("{name} ");
                    if let Some((prefix, _)) = skill.split_once(':') {
                        source = Some("plugin".into());
                        plugin = Some(prefix.to_string());
                    } else {
                        // Only a skill directory name can identify a project skill.
                        let local = !skill.is_empty() && !skill.contains(['/', '\\']) && skill != "." && skill != ".."
                            && cwd.is_some_and(|dir| dir.join(".agents/skills").join(skill).join("SKILL.md").is_file());
                        source = Some(if local { "project" } else { "user" }.into());
                    }
                }
            }
            _ => {}
        }
        Some(AgentCommand {
            name: name.into(), description: description.into(), kind: kind.into(), source, plugin,
            hint: command["input"]["hint"].as_str().map(str::to_string), insert,
        })
    }).collect()
}

/// Finds a select by its ACP category, then by the ids agents are known to use.
fn select(config: &Value, category: &str, ids: &[&str]) -> Option<ConfigSelect> {
    let all = config.as_array()?;
    let found = all.iter().find(|o| o["category"] == category)
        .or_else(|| all.iter().find(|o| o["id"].as_str().is_some_and(|id| ids.contains(&id))))?;
    if found["type"].as_str().is_some_and(|t| t != "select") { return None; }
    // Options may be flat or grouped (`{ group, name, options }`).
    let flat: Vec<&Value> = found["options"].as_array()?.iter()
        .flat_map(|o| match o["options"].as_array() { Some(group) => group.iter().collect::<Vec<_>>(), None => vec![o] })
        .collect();
    let options: Vec<Choice> = flat.into_iter().filter_map(|o| Some(Choice {
        value: o["value"].as_str()?.to_string(),
        name: o["name"].as_str().or(o["value"].as_str())?.to_string(),
        description: o["description"].as_str().map(str::to_string),
    })).collect();
    if options.is_empty() { return None; }
    Some(ConfigSelect { id: found["id"].as_str()?.to_string(), current: found["currentValue"].as_str().unwrap_or_default().to_string(), options })
}

pub fn parse(config: &Value) -> AgentOptions {
    AgentOptions {
        model: select(config, "model", &["model"]),
        effort: select(config, "thought_level", &["effort", "reasoning_effort", "thought_level"]),
    }
}

/// Applies the picks to an open session. The model goes first because it decides which
/// effort levels exist. Returns notes for the user about picks the agent does not offer.
pub async fn apply(client: &AcpClient, session_id: &str, prefs: &SessionPrefs) -> Vec<String> {
    let mut notes = Vec::new();
    for (wanted, kind) in [(&prefs.model, "model"), (&prefs.effort, "effort")] {
        let Some(wanted) = wanted else { continue };
        let options = parse(&client.config_options());
        let Some(select) = (if kind == "model" { options.model } else { options.effort }) else {
            notes.push(format!("Agent này không cho chọn {}, dùng mặc định.", if kind == "model" { "model" } else { "mức suy nghĩ" }));
            continue;
        };
        if select.current == *wanted { continue; }
        if !select.options.iter().any(|o| o.value == *wanted) {
            notes.push(format!("Không có lựa chọn “{wanted}”, dùng “{}”.", select.current));
            continue;
        }
        if let Err(e) = client.set_config_option(session_id, &select.id, wanted).await { notes.push(e); }
    }
    notes
}

/// Headless (read-only) runs take the picks as CLI flags. `default` means no flag.
pub fn headless_flags(agent: AgentKind, prefs: &SessionPrefs) -> Vec<String> {
    let model = prefs.model.as_deref().filter(|m| !m.is_empty() && *m != "default");
    let effort = prefs.effort.as_deref().filter(|e| !e.is_empty() && *e != "default");
    let mut flags = Vec::new();
    match agent {
        AgentKind::Claude => {
            if let Some(m) = model { flags.extend(["--model".to_string(), m.to_string()]); }
            if let Some(e) = effort { flags.extend(["--effort".to_string(), e.to_string()]); }
        }
        AgentKind::Codex => {
            // codex-acp may name a model with its effort ("gpt-5-codex/high"); the CLI takes them apart.
            if let Some(m) = model {
                let (name, level) = m.split_once('/').map(|(a, b)| (a, Some(b))).unwrap_or((m, None));
                flags.extend(["-m".to_string(), name.to_string()]);
                if let Some(level) = effort.or(level) { flags.extend(["-c".to_string(), format!("model_reasoning_effort=\"{level}\"")]); }
            } else if let Some(e) = effort {
                flags.extend(["-c".to_string(), format!("model_reasoning_effort=\"{e}\"")]);
            }
        }
        AgentKind::Gemini | AgentKind::Kiro => {}
    }
    flags
}

/// Listens to nothing: a probe session never prompts.
struct Silent;
impl ClientHandler for Silent {
    fn on_notification(&self, _: &str, _: Value) {}
    fn on_request(&self, method: String, _: Value) -> HandlerFuture { Box::pin(async move { Err(method_not_found(&method)) }) }
    fn on_closed(&self) {}
}

/// Opens a session without prompting (no tokens are spent) to read what the agent offers.
#[tauri::command]
pub async fn agent_options(agent: AgentKind, cwd: Option<String>) -> Result<AgentOptions, String> {
    probe_session(agent, cwd, Arc::new(Silent), |client, _| async move {
        parse(&client.config_options())
    }).await
}

struct CommandsHandler(std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Value>>>);
impl ClientHandler for CommandsHandler {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/update" && params["update"]["sessionUpdate"] == "available_commands_update" {
            if let Some(sender) = self.0.lock().unwrap().take() {
                let _ = sender.send(params["update"].clone());
            }
        }
    }
    fn on_request(&self, method: String, _: Value) -> HandlerFuture { Box::pin(async move { Err(method_not_found(&method)) }) }
    fn on_closed(&self) {}
}

#[tauri::command]
pub async fn agent_commands(agent: AgentKind, cwd: Option<String>) -> Result<Vec<AgentCommand>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handler = Arc::new(CommandsHandler(std::sync::Mutex::new(Some(sender))));
    probe_session(agent, cwd, handler, move |_, dir| async move {
        wait_commands(agent, &dir, receiver).await
    }).await
}

async fn wait_commands(agent: AgentKind, dir: &Path, receiver: tokio::sync::oneshot::Receiver<Value>) -> Vec<AgentCommand> {
    match tokio::time::timeout(Duration::from_secs(5), receiver).await {
        Ok(Ok(update)) => parse_commands(agent, &update, Some(dir)),
        _ => vec![],
    }
}

/// Both probes share setup and cleanup, including failures; neither sends a prompt.
async fn probe_session<T, F, Fut>(agent: AgentKind, cwd: Option<String>, handler: Arc<dyn ClientHandler>, read: F) -> Result<T, String>
where F: FnOnce(Arc<AcpClient>, PathBuf) -> Fut, Fut: std::future::Future<Output = T> {
    let (program, args) = agent.acp_command(env::which).ok_or_else(|| format!("Không tìm thấy adapter cho {}.", agent.display_name()))?;
    let dir = cwd.map(std::path::PathBuf::from).filter(|d| d.is_dir()).unwrap_or_else(std::env::temp_dir);
    let mut process = env::command(&program);
    process.args(&args).current_dir(&dir).env("PATH", env::login_path())
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    env::isolate(&mut process);
    let mut child = process.spawn().map_err(|e| format!("Không chạy được adapter {}: {e}", program.display()))?;
    let pid = child.id();
    // "Internal error" alone says nothing; the adapter's own log says why. Keep its tail.
    let stderr = child.stderr.take().expect("piped stderr");
    let log = Arc::new(std::sync::Mutex::new(std::collections::VecDeque::<String>::new()));
    let collector = {
        let log = log.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut tail = log.lock().unwrap();
                if tail.len() == STDERR_TAIL { tail.pop_front(); }
                tail.push_back(line);
            }
        })
    };
    let timeout = setup_timeout(&program);
    let client = Arc::new(AcpClient::start_with_timeout(child.stdout.take().expect("piped stdout"), child.stdin.take().expect("piped stdin"), handler, timeout));
    let probe = async {
        client.initialize().await?;
        client.new_session(&dir, serde_json::json!([])).await?;
        Ok::<_, String>(())
    };
    let result = tokio::time::timeout(timeout + Duration::from_secs(5), probe).await
        .unwrap_or_else(|_| Err(format!("{} không trả lời kịp.", agent.display_name())));
    let result = match result {
        Ok(()) => Ok(read(client.clone(), dir).await),
        Err(error) => Err(error),
    };
    client.close();
    if let Some(pid) = pid { env::kill_tree(pid).await; }
    let _ = child.kill().await;
    let _ = child.wait().await;
    collector.abort();
    let tail: Vec<String> = log.lock().unwrap().iter().cloned().collect();
    result.map_err(|e| with_log(e, &tail))
}

const STDERR_TAIL: usize = 12;

/// The error, then the adapter's last log lines (lines that are only noise left out).
fn with_log(error: String, tail: &[String]) -> String {
    let lines: Vec<&str> = tail.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() { return error; }
    format!("{error}\n\nLog của adapter:\n{}", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::fake;
    use serde_json::json;

    fn commands_fixture(agent: AgentKind) -> Value {
        let raw = match agent {
            AgentKind::Claude => include_str!("../tests/fixtures/claude-agent-acp/0.100.0/available-commands.json"),
            _ => include_str!("../tests/fixtures/codex-acp/2.5.0/available-commands.json"),
        };
        serde_json::from_str::<Value>(raw).unwrap()["params"]["update"].clone()
    }

    struct TempRepo(PathBuf);
    impl TempRepo {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("tg-commands-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn skill(&self, path: &str) {
            let path = self.0.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "---\nname: tg-live-skill\ndescription: Skill kiểm tra danh sách lệnh\n---\nChỉ trả lời khi được gọi.\n").unwrap();
        }
    }
    impl Drop for TempRepo {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn claude_commands_fixture_classifies_sources_and_preserves_order_and_hint() {
        let update = commands_fixture(AgentKind::Claude);
        let commands = parse_commands(AgentKind::Claude, &update, None);
        assert_eq!(commands.len(), 9);
        for (command, raw) in commands.iter().zip(update["availableCommands"].as_array().unwrap()) {
            assert_eq!(command.name, raw["name"].as_str().unwrap());
            assert_eq!(command.insert, format!("/{} ", command.name));
        }
        for (index, source) in [(0, "project"), (1, "user"), (2, "plugin"), (3, "plugin")] {
            let command = &commands[index];
            assert_eq!(command.kind, "skill");
            assert_eq!(command.source.as_deref(), Some(source));
            assert!(!command.description.ends_with(&format!(" ({source})")));
            if source == "plugin" {
                assert_eq!(command.plugin.as_deref(), Some("superpowers"));
                assert!(!command.description.starts_with("(superpowers) "));
            } else { assert!(command.plugin.is_none()); }
        }
        for command in &commands[4..] {
            assert_eq!(command.kind, "command");
            assert!(command.source.is_none());
            assert!(command.plugin.is_none());
        }
        assert_eq!(commands[5].hint.as_deref(), update["availableCommands"][5]["input"]["hint"].as_str());
        assert!(commands[0].hint.is_none());
    }

    #[test]
    fn codex_commands_fixture_uses_project_directory_and_plugin_name() {
        let repo = TempRepo::new();
        let update = commands_fixture(AgentKind::Codex);
        assert_eq!(parse_commands(AgentKind::Codex, &update, None)[4].source.as_deref(), Some("user"));
        repo.skill(".agents/skills/tg-codex-skill/SKILL.md");
        let commands = parse_commands(AgentKind::Codex, &update, Some(&repo.0));
        assert_eq!(commands.len(), 6);
        assert_eq!(commands[0].name, "plan");
        assert_eq!(commands[0].kind, "command");
        assert_eq!(commands[0].insert, "/plan ");
        assert!(commands[0].source.is_none());
        assert_eq!(commands[4].kind, "skill");
        assert_eq!(commands[4].source.as_deref(), Some("project"));
        assert_eq!(commands[4].insert, "$tg-codex-skill ");
        assert_eq!(commands[5].source.as_deref(), Some("plugin"));
        assert_eq!(commands[5].plugin.as_deref(), Some("documents"));
        assert_eq!(commands[5].insert, "$documents:documents ");
    }

    #[test]
    fn commands_ignore_missing_names_and_other_agents_keep_commands() {
        assert!(parse_commands(AgentKind::Claude, &Value::Null, None).is_empty());
        let update = json!({"availableCommands":[{}, {"name":""}, {"name":"$skill", "description":"Test (project)"}]});
        for agent in [AgentKind::Gemini, AgentKind::Kiro] {
            let commands = parse_commands(agent, &update, None);
            assert_eq!(commands.len(), 1);
            assert_eq!(commands[0].kind, "command");
            assert_eq!(commands[0].description, "Test (project)");
            assert_eq!(commands[0].insert, "/$skill ");
            assert!(commands[0].source.is_none());
        }
    }

    #[tokio::test]
    async fn commands_handler_retains_only_first_matching_update_including_empty_list() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let handler = CommandsHandler(std::sync::Mutex::new(Some(sender)));
        handler.on_notification("other", json!({"update": commands_fixture(AgentKind::Claude)}));
        handler.on_notification("session/update", json!({"update":{"sessionUpdate":"plan"}}));
        let first = json!({"sessionUpdate":"available_commands_update", "availableCommands":[]});
        handler.on_notification("session/update", json!({"update": first}));
        handler.on_notification("session/update", json!({"update": commands_fixture(AgentKind::Claude)}));
        assert_eq!(receiver.await.unwrap(), first);
    }

    #[tokio::test]
    async fn commands_wait_accepts_delayed_update_and_times_out_when_none_arrives() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            sender.send(commands_fixture(AgentKind::Claude)).unwrap();
        });
        assert_eq!(wait_commands(AgentKind::Claude, &std::env::temp_dir(), receiver).await.len(), 9);
        let (_sender, receiver) = tokio::sync::oneshot::channel();
        assert!(tokio::time::timeout(Duration::from_secs(6), wait_commands(AgentKind::Claude, &std::env::temp_dir(), receiver)).await.unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_agent_commands_lists_project_skill() {
        let repo = TempRepo::new();
        repo.skill(".claude/skills/tg-live-skill/SKILL.md");
        let commands = agent_commands(AgentKind::Claude, Some(repo.0.to_string_lossy().into_owned())).await.unwrap();
        assert!(commands.iter().any(|command| command.name == "tg-live-skill" && command.source.as_deref() == Some("project")));
    }

    fn claude_like() -> Value {
        json!([
            { "id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "default", "options": [{ "value": "default", "name": "Default" }] },
            { "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "default", "options": [
                { "value": "default", "name": "Default (recommended)", "description": "Sonnet" },
                { "value": "opus", "name": "Opus" },
                { "value": "haiku", "name": "Haiku", "description": "Fastest" }
            ] },
            { "id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": "default", "options": [
                { "value": "default", "name": "Default" }, { "value": "low", "name": "Low" }, { "value": "high", "name": "High" }
            ] }
        ])
    }

    #[test]
    fn reads_model_and_effort_by_category() {
        let o = parse(&claude_like());
        let model = o.model.unwrap();
        assert_eq!(model.id, "model");
        assert_eq!(model.current, "default");
        assert_eq!(model.options.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["default", "opus", "haiku"]);
        assert_eq!(model.options[2].description.as_deref(), Some("Fastest"));
        assert_eq!(o.effort.unwrap().options.len(), 3);
    }

    #[test]
    fn grouped_options_ids_without_category_and_nothing_offered() {
        let config = json!([{ "id": "reasoning_effort", "type": "select", "currentValue": "medium", "options": [
            { "group": "g", "name": "Levels", "options": [{ "value": "medium", "name": "Medium" }, { "value": "high", "name": "High" }] }
        ] }]);
        let o = parse(&config);
        assert!(o.model.is_none());
        assert_eq!(o.effort.unwrap().options.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["medium", "high"]);
        assert_eq!(parse(&Value::Null), AgentOptions::default());
        assert_eq!(parse(&json!([{ "id": "model", "type": "boolean", "currentValue": true }])), AgentOptions::default());
    }

    #[test]
    fn errors_carry_the_adapters_last_log_lines() {
        assert_eq!(with_log("Lỗi".into(), &[]), "Lỗi");
        assert_eq!(with_log("Lỗi".into(), &["  ".into(), "spawn claude ENOENT".into()]), "Lỗi\n\nLog của adapter:\nspawn claude ENOENT");
    }

    #[test]
    fn headless_flags_per_agent() {
        let p = |m: Option<&str>, e: Option<&str>| SessionPrefs { model: m.map(String::from), effort: e.map(String::from) };
        assert!(headless_flags(AgentKind::Claude, &p(Some("default"), Some("default"))).is_empty());
        assert_eq!(headless_flags(AgentKind::Claude, &p(Some("opus"), Some("high"))), ["--model", "opus", "--effort", "high"]);
        assert_eq!(headless_flags(AgentKind::Codex, &p(Some("gpt-5-codex/high"), None)), ["-m", "gpt-5-codex", "-c", "model_reasoning_effort=\"high\""]);
        assert_eq!(headless_flags(AgentKind::Codex, &p(None, Some("low"))), ["-c", "model_reasoning_effort=\"low\""]);
        assert!(headless_flags(AgentKind::Gemini, &p(Some("x"), None)).is_empty());
    }

    struct Quiet;
    impl ClientHandler for Quiet {
        fn on_notification(&self, _: &str, _: Value) {}
        fn on_request(&self, method: String, _: Value) -> HandlerFuture { Box::pin(async move { Err(method_not_found(&method)) }) }
        fn on_closed(&self) {}
    }

    #[tokio::test]
    async fn apply_sets_model_then_effort_and_reports_what_is_missing() {
        let (reader, writer, log) = fake::spawn_with_config(claude_like(), vec![]);
        let client = AcpClient::start(reader, writer, Arc::new(Quiet));
        client.initialize().await.unwrap();
        let id = client.new_session(std::path::Path::new("/tmp"), json!([])).await.unwrap();
        let notes = apply(&client, &id, &SessionPrefs { model: Some("opus".into()), effort: Some("high".into()) }).await;
        assert!(notes.is_empty(), "{notes:?}");
        let sets: Vec<(String, String)> = log.lock().unwrap().iter().filter(|m| m["method"] == "session/set_config_option")
            .map(|m| (m["params"]["configId"].as_str().unwrap().into(), m["params"]["value"].as_str().unwrap().into())).collect();
        assert_eq!(sets, [("model".to_string(), "opus".to_string()), ("effort".to_string(), "high".to_string())]);
        assert_eq!(parse(&client.config_options()).model.unwrap().current, "opus");
        // Unknown value: nothing sent, a note instead. Same value: nothing sent.
        let notes = apply(&client, &id, &SessionPrefs { model: Some("gpt-9".into()), effort: Some("high".into()) }).await;
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert_eq!(log.lock().unwrap().iter().filter(|m| m["method"] == "session/set_config_option").count(), 2);
    }

    /// Reads what the real Claude adapter offers, without prompting (no tokens):
    /// `TG_LIVE_ACP=1 cargo test live_claude_config_options -- --ignored --nocapture`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_claude_config_options() {
        if std::env::var("TG_LIVE_ACP").is_err() { return; }
        let agent = if std::env::var("TG_LIVE_AGENT").as_deref() == Ok("codex") { AgentKind::Codex } else { AgentKind::Claude };
        let options = agent_options(agent, None).await.unwrap();
        eprintln!("{}", serde_json::to_string_pretty(&options).unwrap());
        assert!(options.model.is_some_and(|m| m.options.len() > 1), "phải có danh sách model");
    }
}
