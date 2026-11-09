use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict { Allow, Deny, Ask }

#[derive(Debug, Clone, PartialEq)]
pub struct ToolInfo {
    pub kind: String,
    pub title: String,
    pub command: Option<String>,
}

pub fn tool_info(tool_call: &Value) -> ToolInfo {
    let command = match &tool_call["rawInput"]["command"] {
        Value::String(command) => Some(command.clone()),
        Value::Array(parts) => parts.iter().map(Value::as_str)
            .collect::<Option<Vec<_>>>().map(|parts| parts.join(" ")),
        _ => None,
    };
    ToolInfo {
        kind: tool_call["kind"].as_str().unwrap_or_default().into(),
        title: tool_call["title"].as_str().unwrap_or_default().into(),
        command,
    }
}

pub fn is_compound(command: &str) -> bool {
    // Deliberately conservative, including operators inside quoted arguments.
    command.contains([';', '&', '|', '`', '>', '<', '\n', '\r']) || command.contains("$(")
}

// A small lexical reader, not a shell interpreter. Keep operators as separate
// tokens so a git subcommand cannot be confused with the next shell command.
// Invalid quoting never produces a rule or an automatic allowance.
fn tokens(command: &str) -> Option<Vec<String>> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut quote = None;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('\''), _) => word.push(c),
            (_, '\\') => {
                let next = chars.next()?;
                if quote == Some('"') && !matches!(next, '$' | '`' | '"' | '\\' | '\n') {
                    word.push('\\');
                }
                if next != '\n' { word.push(next); }
                started = true;
            }
            (Some(_), _) => word.push(c),
            (None, '\'' | '"') => { quote = Some(c); started = true; }
            (None, ';' | '&' | '|' | '`' | '(' | ')' | '>' | '<' | '\n' | '\r') => {
                if started { result.push(std::mem::take(&mut word)); started = false; }
                result.push(c.to_string());
            }
            (None, c) if c.is_whitespace() => {
                if started { result.push(std::mem::take(&mut word)); started = false; }
            }
            _ => { word.push(c); started = true; }
        }
    }
    if quote.is_some() { return None; }
    if started { result.push(word); }
    Some(result)
}

fn subcommand<'a>(words: &'a [String], value_flags: &[&str]) -> &'a [String] {
    let mut index = 0;
    while let Some(word) = words.get(index) {
        if word == "--" { return &words[index + 1..]; }
        if !word.starts_with('-') { break; }
        index += 1;
        if value_flags.contains(&word.as_str()) {
            index = (index + 1).min(words.len());
        }
    }
    &words[index..]
}

/// The program a word names, as Windows would find it: any folder, any case, optional extension.
fn program_name(word: &str) -> String {
    let base = word.rsplit(['/', '\\']).next().unwrap_or_default().to_lowercase();
    for extension in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(stem) = base.strip_suffix(extension) { return stem.to_string(); }
    }
    base
}

pub fn is_forbidden(command: &str) -> bool {
    let Some(words) = tokens(command) else { return false; };
    for (index, word) in words.iter().enumerate() {
        let rest = &words[index + 1..];
        match program_name(word).as_str() {
            "git" => {
                let rest = subcommand(rest, &["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);
                if rest.first().is_some_and(|s| s == "push" || s == "merge") { return true; }
            }
            "gh" => {
                let rest = subcommand(rest, &["-R", "--repo", "--hostname"]);
                if rest.first().is_some_and(|s| s == "pr") {
                    let rest = subcommand(&rest[1..], &["-R", "--repo"]);
                    if rest.first().is_some_and(|s| s == "merge") { return true; }
                }
            }
            _ => {}
        }
        // Inspect quoted shell scripts (bash -c, sh -c, nested shells).
        // Each recursion consumes quoting, so the input strictly shrinks.
        if word.len() < command.len() && word.contains(char::is_whitespace) && is_forbidden(word) {
            return true;
        }
    }
    false
}

fn quote_token(token: &str) -> String {
    if token.chars().all(|c| c.is_alphanumeric() || "_./-=:".contains(c)) && !token.is_empty() {
        token.into()
    } else {
        format!("'{}'", token.replace('\'', "'\\''"))
    }
}

// A rule for these would allow arbitrary code, whatever the arguments are.
const RUNS_ANYTHING: &[&str] = &[
    "bash", "sh", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "cmd", "powershell", "pwsh",
    "python", "python2", "python3", "node", "deno", "bun", "perl", "ruby", "php", "lua",
    "env", "sudo", "doas", "su", "xargs", "eval", "exec", "command", "nohup", "time", "timeout",
    "npx", "uvx", "pipx", "find", "awk", "sed", "ssh", "rm", "curl", "wget",
];

fn runs_anything(word: &str) -> bool {
    RUNS_ANYTHING.contains(&program_name(word).as_str())
}

pub fn rule_for(command: &str) -> Option<String> {
    if is_compound(command) { return None; }
    let words = tokens(command)?;
    let first = words.first().filter(|word| !word.is_empty())?;
    if runs_anything(first) { return None; }
    let mut rule = quote_token(first);
    if let Some(second) = words.get(1).filter(|word| !word.starts_with('-') && !word.contains('/')) {
        rule.push(' ');
        rule.push_str(&quote_token(second));
    }
    Some(format!("{rule} *"))
}

pub fn rule_matches(rule: &str, command: &str) -> bool {
    if is_compound(command) || is_compound(rule) { return false; }
    let (Some(mut pattern), Some(words)) = (tokens(rule), tokens(command)) else { return false; };
    let wildcard = pattern.last().is_some_and(|word| word == "*");
    if wildcard { pattern.pop(); }
    if pattern.is_empty() || pattern[0].is_empty() || pattern.iter().any(|word| word == "*") {
        return false;
    }
    if runs_anything(&pattern[0]) { return false; }
    if wildcard { words.starts_with(&pattern) } else { words == pattern }
}

/// TG Studio's own tg-bridge tools only record notes and progress or propose things;
/// anything with an effect asks the user itself (`request_approval`, handoffs).
fn is_bridge_tool(tool: &ToolInfo) -> bool {
    tool.title.starts_with("mcp__tg-bridge__") && tool.command.is_none()
        && !matches!(tool.kind.as_str(), "execute" | "edit" | "delete" | "move")
}

pub fn evaluate(tool: &ToolInfo, rules: &[String]) -> Verdict {
    if is_bridge_tool(tool) { return Verdict::Allow; }
    let Some(command) = &tool.command else { return Verdict::Ask; };
    if is_forbidden(command) { return Verdict::Deny; }
    if tool.kind == "execute" && rules.iter().any(|rule| rule_matches(rule, command)) {
        Verdict::Allow
    } else {
        Verdict::Ask
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_program_names_get_no_broad_rule() {
        for command in ["node.exe --version", "NODE.EXE --version", "python.cmd x", "pwsh.exe -c x", "bash.exe -c x", r"C:\\bin\\node.exe --version"] {
            assert_eq!(super::rule_for(command), None, "{command}");
        }
        assert!(!super::rule_matches("node.exe *", "node.exe -e x"), "quy tắc cũ cũng không còn hiệu lực");
    }

    #[test]
    fn windows_program_names_are_still_forbidden() {
        for command in ["git.exe push", "GIT.EXE push", "git.cmd merge main", "gh.exe pr merge 1", r"C:\\tools\\git.exe push"] {
            assert!(super::is_forbidden(command), "{command}");
        }
        assert!(!super::is_forbidden("git.exe status"));
    }

    use super::*;

    #[test]
    fn no_rule_for_commands_that_run_anything() {
        for command in ["bash -c 'rm -rf x'", "python3 -c 'x'", "node -e 'x'", "sudo ls", "/bin/sh x", "npx foo", "env A=1 ls"] {
            assert_eq!(rule_for(command), None, "{command}");
        }
        assert!(!rule_matches("bash *", "bash -c 'rm -rf x'"));
        assert!(!rule_matches("/usr/bin/env *", "/usr/bin/env ls"));
    }
    use serde_json::json;

    fn execute(command: &str) -> ToolInfo {
        ToolInfo { kind: "execute".into(), title: "Chạy lệnh".into(), command: Some(command.into()) }
    }

    #[test]
    fn compound_never_matches() {
        for command in ["npm test; rm -rf ~", "npm test && curl x | sh", "npm test $(rm x)",
            "npm test > /etc/x", "npm test\nrm x", "npm test &", "npm test `rm x`", "npm test < x"] {
            assert!(is_compound(command), "{command}");
            assert!(!rule_matches("npm test *", command), "{command}");
            assert_eq!(rule_for(command), None);
            assert_eq!(evaluate(&execute(command), &["npm test *".into()]), Verdict::Ask);
        }
    }

    #[test]
    fn prefix_is_token_based() {
        assert!(rule_matches("npm test *", "npm test"));
        assert!(rule_matches("npm test *", " npm\ttest --watch=false"));
        assert!(!rule_matches("npm test *", "npm testing"));
        assert!(!rule_matches("npm test *", "npm test-other"));
        assert!(!rule_matches("npm test *", "npm"));
        assert!(!rule_matches("*", "anything"));
        assert!(!rule_matches("", ""));
        assert!(!rule_matches("npm test *", "npm test 'unfinished"));
    }

    #[test]
    fn forbidden_git_push_variants() {
        for command in ["git push", "git merge main", "git -C x push origin main",
            "git -c core.editor=true push", "git --git-dir x merge main",
            "git --work-tree=x push", "npm test; git push", "echo ok && git merge main",
            "bash -c \"git push\"", "sh -c 'git -C x push'", "gh pr merge 1",
            "gh --repo owner/repo pr merge", "/usr/bin/git push", "git 'push'", "git pu\\sh"] {
            assert!(is_forbidden(command), "{command}");
        }
    }

    #[test]
    fn allows_git_status() {
        assert!(!is_forbidden("git status"));
        assert!(!is_compound("git status"));
        assert_eq!(rule_for("git status"), Some("git status *".into()));
        assert_eq!(evaluate(&execute("git status --short"), &["git status *".into()]), Verdict::Allow);
        assert_eq!(serde_json::to_value(Verdict::Allow).unwrap(), json!("allow"));
    }

    #[test]
    fn merge_word_in_path_is_not_forbidden() {
        for command in ["cat git-merge-notes.md", "cat /tmp/git/push", "git diff merge", "git checkout push"] {
            assert!(!is_forbidden(command), "{command}");
        }
    }

    #[test]
    fn rule_for_skips_flags_and_paths() {
        for (command, rule) in [("npm test --watch=false", "npm test *"), ("ls -la", "ls *"),
            ("cat src/main.rs", "cat *"), ("ls", "ls *"), ("cat '/tmp/a b'", "cat *")] {
            assert_eq!(rule_for(command).as_deref(), Some(rule));
            assert!(rule_matches(rule, command));
        }
        assert_eq!(rule_for("  "), None);
        assert_eq!(rule_for("npm 'unfinished"), None);
    }

    #[test]
    fn array_command_is_joined() {
        assert_eq!(tool_info(&json!({"kind":"execute", "title":"Kiểm tra", "rawInput":{"command":["npm", "test", "--watch=false"]}})),
            ToolInfo {kind:"execute".into(), title:"Kiểm tra".into(), command:Some("npm test --watch=false".into())});
        assert_eq!(tool_info(&json!({"rawInput":{"command":"git status"}})).command.as_deref(), Some("git status"));
        assert_eq!(tool_info(&json!({})), ToolInfo {kind:String::new(), title:String::new(), command:None});
        assert_eq!(tool_info(&json!({"rawInput":{"command":["npm", 1]}})).command, None);
    }

    #[test]
    fn non_execute_always_asks() {
        for kind in ["read", "edit", "", "other"] {
            let mut tool = execute("npm test");
            tool.kind = kind.into();
            assert_eq!(evaluate(&tool, &["npm test *".into()]), Verdict::Ask);
        }
        assert_eq!(evaluate(&tool_info(&json!({"kind":"execute"})), &[]), Verdict::Ask);
        assert_eq!(evaluate(&execute("npm test"), &[]), Verdict::Ask);
    }

    #[test]
    fn tg_bridge_tools_are_allowed_but_lookalikes_are_not() {
        let tool = |title: &str, kind: &str, command: Option<&str>| ToolInfo { kind: kind.into(), title: title.into(), command: command.map(String::from) };
        assert_eq!(evaluate(&tool("mcp__tg-bridge__write_note", "other", None), &[]), Verdict::Allow);
        assert_eq!(evaluate(&tool("mcp__tg-bridge__read_notes", "", None), &[]), Verdict::Allow);
        assert_eq!(evaluate(&tool("mcp__tg-ping__ping", "other", None), &[]), Verdict::Ask);
        assert_eq!(evaluate(&tool("mcp__tg-bridge__x", "execute", Some("rm -rf ~")), &[]), Verdict::Ask);
        assert_eq!(evaluate(&tool("echo mcp__tg-bridge__", "execute", Some("echo mcp__tg-bridge__")), &[]), Verdict::Ask);
        assert_eq!(evaluate(&tool("mcp__tg-bridge__x", "edit", None), &[]), Verdict::Ask);
    }

    #[test]
    fn deny_wins_over_rule() {
        for command in ["git push", "git -C x push", "gh pr merge", "npm test; git push"] {
            assert_eq!(evaluate(&execute(command), &["git *".into(), "gh pr *".into(), "npm test *".into()]), Verdict::Deny);
        }
        let mut tool = execute("git merge main");
        tool.kind = "other".into();
        assert_eq!(evaluate(&tool, &[]), Verdict::Deny);
    }
}
