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

const GIT_VALUE_FLAGS: &[&str] = &["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"];
const GH_VALUE_FLAGS: &[&str] = &["-R", "--repo", "--hostname"];

fn is_operator(word: &str) -> bool {
    matches!(word, ";" | "&" | "|" | "`" | "(" | ")" | ">" | "<" | "\n" | "\r")
}

/// The arguments of one simple command: up to the next shell operator.
fn arguments(words: &[String]) -> &[String] {
    &words[..words.iter().position(|word| is_operator(word)).unwrap_or(words.len())]
}

/// `-c key=value` and `--config-env=key=VAR` given before git's subcommand: each one
/// can make git run a program (`alias.x=!…`, `core.fsmonitor`, `core.sshCommand`…).
fn git_configs(args: &[String]) -> Vec<(String, Option<String>)> {
    let mut configs = Vec::new();
    let mut index = 0;
    while let Some(word) = args.get(index) {
        if word == "--" || !word.starts_with('-') { break; }
        index += 1;
        let (setting, from_env) = match word.as_str() {
            "-c" => (args.get(index).cloned(), false),
            "--config-env" => (args.get(index).cloned(), true),
            _ => match word.strip_prefix("--config-env=") {
                Some(setting) => (Some(setting.to_string()), true),
                None => (None, false),
            },
        };
        if let Some(setting) = setting {
            let (key, value) = setting.split_once('=').unwrap_or((&setting, ""));
            // A value read from the environment is not visible here.
            configs.push((key.to_lowercase(), (!from_env).then(|| value.to_string())));
        }
        if GIT_VALUE_FLAGS.contains(&word.as_str()) { index += 1; }
    }
    configs
}

fn names_push_or_merge(text: &str) -> bool {
    text.split(|c: char| c.is_whitespace() || c == '!' || c == '\'' || c == '"')
        .any(|word| word == "push" || word == "merge")
}

/// Commands TG Studio refuses even in Auto mode. A guard against mistakes and plain
/// prompt injection, not a sandbox: a shell has endless ways to spell `git push`
/// (a user alias, a script file…). What this reader cannot see through goes to `must_ask`.
pub fn is_forbidden(command: &str) -> bool {
    let Some(words) = tokens(command) else { return false; };
    for (index, word) in words.iter().enumerate() {
        let args = arguments(&words[index + 1..]);
        match program_name(word).as_str() {
            "git" => {
                let configs = git_configs(args);
                // An alias for push/merge, or one whose definition is hidden in a variable.
                if configs.iter().any(|(key, value)| key.starts_with("alias.") && value.as_deref().is_none_or(names_push_or_merge)) {
                    return true;
                }
                let rest = subcommand(args, GIT_VALUE_FLAGS);
                if rest.first().is_some_and(|s| s == "push" || s == "merge") { return true; }
            }
            "gh" => {
                let rest = subcommand(args, GH_VALUE_FLAGS);
                match rest.first().map(String::as_str) {
                    Some("pr") => {
                        let rest = subcommand(&rest[1..], &["-R", "--repo"]);
                        if rest.first().is_some_and(|s| s == "merge") { return true; }
                    }
                    // REST `…/pulls/1/merge`, GraphQL `mergePullRequest`, `/merges`.
                    Some("api") => {
                        if rest[1..].iter().any(|word| word.to_lowercase().contains("merge")) { return true; }
                    }
                    _ => {}
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

/// Characters with which the shell builds a word this reader cannot predict.
fn is_expanded(word: &str) -> bool {
    word.contains(['$', '*', '?', '[', '{', '~'])
}

/// A command that needs a person even in Auto mode, and that no "always" rule covers:
/// quoting this reader cannot follow, a program or a git/gh subcommand that the shell
/// expands at run time, or git `-c`/`--config-env` (configuration that runs programs).
pub fn must_ask(command: &str) -> bool {
    let Some(words) = tokens(command) else { return true; };
    let mut at_start = true;
    for (index, word) in words.iter().enumerate() {
        if is_operator(word) { at_start = true; continue; }
        if at_start {
            if word.contains('$') { return true; }
            // `NAME=value program …`: the program is still to come.
            at_start = word.contains('=') && !word.starts_with('-');
        }
        let args = arguments(&words[index + 1..]);
        match program_name(word).as_str() {
            "git" => {
                if !git_configs(args).is_empty() { return true; }
                if subcommand(args, GIT_VALUE_FLAGS).first().is_some_and(|s| is_expanded(s)) { return true; }
            }
            "gh" => {
                if subcommand(args, GH_VALUE_FLAGS).iter().take(2).any(|s| is_expanded(s)) { return true; }
            }
            _ => {}
        }
        if word.len() < command.len() && word.contains(char::is_whitespace) && must_ask(word) {
            return true;
        }
    }
    false
}

/// The command line of an ACP `terminal/create` (`command` + `args`), quoted so that
/// `sh -c 'git push'` reads as one script.
pub fn terminal_command(params: &Value) -> String {
    let mut words = vec![params["command"].as_str().unwrap_or_default().to_string()];
    words.extend(params["args"].as_array().into_iter().flatten().map(|a| quote_token(a.as_str().unwrap_or_default())));
    words.join(" ")
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

/// Programs driven by a subcommand: a rule always names it, never `git *`.
const SUBCOMMAND_PROGRAMS: &[&str] = &[
    "git", "gh", "npm", "pnpm", "yarn", "cargo", "make", "docker", "kubectl", "go", "pip", "pip3",
    "uv", "dotnet", "mvn", "gradle", "rustup", "brew", "bundle",
];

/// Subcommands that run whatever they are given or configure what runs later.
fn subcommand_runs_anything(program: &str, sub: &str) -> bool {
    let list: &[&str] = match program {
        "git" => &["config", "filter-branch", "bisect", "submodule", "mergetool", "hook", "daemon", "instaweb", "credential", "send-email"],
        "gh" => &["api", "extension", "ext", "alias"],
        "npm" | "pnpm" | "yarn" => &["exec", "x", "dlx", "create", "init", "explore", "config"],
        "cargo" => &["install", "--config"],
        "docker" | "kubectl" => &["run", "exec"],
        _ => &[],
    };
    list.contains(&sub)
}

/// A rule for these names one more word: `npm run build *`, `gh pr view *`.
fn needs_third_word(program: &str, sub: &str) -> bool {
    program == "gh" || (matches!(program, "npm" | "pnpm" | "yarn") && matches!(sub, "run" | "run-script"))
}

/// Options after the rule's words that make the program run something of the agent's choice.
fn runs_program_option(program: &str, sub: &str, args: &[String]) -> bool {
    let has = |options: &[&str]| args.iter().any(|arg| options.iter().any(|option| {
        arg == option || arg.starts_with(&format!("{option}="))
            // `-xcmd`: a short option glued to its value.
            || (option.len() == 2 && arg.starts_with(option) && !arg.starts_with("--"))
    }));
    match program {
        "git" => has(&["-x", "--exec", "--extcmd", "--upload-pack", "--receive-pack", "-O", "--open-files-in-pager", "--tool", "--template", "--config"])
            || (sub == "clone" && has(&["-u", "-c"])),
        "cargo" => has(&["--config", "-Z"]),
        // Variable overrides (`SHELL=…`, `CC=…`) change what the recipes run.
        "make" => args.iter().any(|arg| arg.contains('=') && !arg.starts_with('-'))
            || has(&["-f", "--file", "--makefile", "-E", "--eval", "-C", "--directory", "-I", "--include-dir"]),
        "npm" | "pnpm" | "yarn" => has(&["--script-shell", "--node-options", "--userconfig", "--globalconfig"]),
        _ => false,
    }
}

pub fn rule_for(command: &str) -> Option<String> {
    if is_compound(command) || must_ask(command) { return None; }
    let words = tokens(command)?;
    let first = words.first().filter(|word| !word.is_empty())?;
    // `NAME=value program`: the variable can change what the program runs.
    if runs_anything(first) || first.contains('=') { return None; }
    // A leading flag can be one that runs code (`git -c`, `cargo --config`, `make -f`).
    if words.get(1).is_some_and(|word| word.starts_with('-')) { return None; }
    let word = |index: usize| words.get(index).filter(|word| !word.starts_with('-') && !word.contains('/'));
    let program = program_name(first);
    let mut parts = vec![first];
    if SUBCOMMAND_PROGRAMS.contains(&program.as_str()) {
        let sub = word(1)?;
        if subcommand_runs_anything(&program, sub) { return None; }
        parts.push(sub);
        if needs_third_word(&program, sub) { parts.push(word(2)?); }
        if runs_program_option(&program, sub, &words[parts.len()..]) { return None; }
    } else if let Some(second) = word(1) {
        parts.push(second);
    }
    let rule = parts.iter().map(|word| quote_token(word)).collect::<Vec<_>>().join(" ");
    Some(format!("{rule} *"))
}

pub fn rule_matches(rule: &str, command: &str) -> bool {
    if is_compound(command) || is_compound(rule) || must_ask(command) { return false; }
    let (Some(mut pattern), Some(words)) = (tokens(rule), tokens(command)) else { return false; };
    let wildcard = pattern.last().is_some_and(|word| word == "*");
    if wildcard { pattern.pop(); }
    if pattern.is_empty() || pattern[0].is_empty() || pattern.iter().any(|word| word == "*") {
        return false;
    }
    // Older versions saved rules such as `git *` or `A=1 git *`: they allow nothing now.
    if runs_anything(&pattern[0]) || pattern[0].contains('=') { return false; }
    let program = program_name(&pattern[0]);
    let sub = pattern.get(1).map(String::as_str).unwrap_or_default();
    if SUBCOMMAND_PROGRAMS.contains(&program.as_str()) {
        if sub.is_empty() || sub.starts_with('-') || subcommand_runs_anything(&program, sub) { return false; }
        if needs_third_word(&program, sub) && pattern.len() < 3 { return false; }
    }
    if words.iter().any(|word| word.contains('$')) { return false; }
    let matched = if wildcard { words.starts_with(&pattern) } else { words == pattern };
    matched && !runs_program_option(&program, sub, &words[pattern.len()..])
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
        for (command, rule) in [("npm test --watch=false", "npm test *"),
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
    fn no_broad_rule_when_a_flag_comes_first() {
        for command in ["git -C /repo status", "git --no-pager diff", "git -c core.pager=cat log", "npm --prefix x test",
            "cargo --config x build", "make -f evil.mk", "ls -la", "git", "npm", "cargo", "make", "gh", "gh api repos/o/r",
            "npm run", "npm exec foo", "npx foo", "pnpm dlx foo", "yarn dlx foo", "git config core.fsmonitor x",
            "git submodule foreach x", "git bisect run x", "A=1 git status", "GIT_EXTERNAL_DIFF=x git diff"] {
            let rule = rule_for(command);
            assert!(rule.is_none(), "{command} → {rule:?}");
        }
        assert_eq!(rule_for("npm run build --watch").as_deref(), Some("npm run build *"));
        assert_eq!(rule_for("gh pr view 12").as_deref(), Some("gh pr view *"));
        assert_eq!(rule_for("cargo test --lib").as_deref(), Some("cargo test *"));
        assert_eq!(rule_for("make test").as_deref(), Some("make test *"));
    }

    #[test]
    fn stored_broad_rules_no_longer_allow_anything() {
        // Rules saved by older versions stay in SQLite.
        for (rule, command) in [("git *", "git -c core.fsmonitor=x status"), ("git *", "git status"), ("npm *", "npm test"),
            ("cargo *", "cargo build"), ("make *", "make"), ("A=1 git *", "A=1 git status"), ("gh api *", "gh api x")] {
            assert!(!rule_matches(rule, command), "{rule} / {command}");
        }
    }

    #[test]
    fn options_that_run_a_program_are_never_allowed_by_a_rule() {
        for (rule, command) in [
            ("git status *", "git -c core.fsmonitor=x status"),
            ("git rebase *", "git rebase -x 'sh p' main"), ("git rebase *", "git rebase --exec=x main"),
            ("git grep *", "git grep -O x foo"), ("git fetch *", "git fetch --upload-pack=x"),
            ("git clone *", "git clone -u x url"), ("git clone *", "git clone -c core.fsmonitor=x url"),
            ("git difftool *", "git difftool -x x"),
            ("cargo test *", "cargo test --config 'target.x.runner=\"sh\"'"), ("cargo build *", "cargo build -Zunstable-options"),
            ("make test *", "make test SHELL=/tmp/x"), ("make test *", "make test --eval=x"), ("make test *", "make test -f x"),
            ("npm test *", "npm test --script-shell=/tmp/x"), ("npm test *", "npm test --node-options=--require=x"),
            ("ls *", "ls $(x)"), ("npm test *", "npm test $X"),
        ] {
            assert!(!rule_matches(rule, command), "{rule} / {command}");
            assert_eq!(evaluate(&execute(command), &[rule.into()]), Verdict::Ask, "{command}");
        }
        assert!(rule_matches("git status *", "git status --short"));
        assert!(rule_matches("git commit *", "git commit -c HEAD"));
        assert!(rule_matches("cargo test *", "cargo test --lib policy"));
        assert!(rule_matches("make test *", "make test"));
    }

    #[test]
    fn known_bypasses_of_the_forbidden_list() {
        for command in ["git -c alias.p=push p origin main", "git -c 'alias.p=push --force' p", "git --config-env=alias.p=X p",
            "gh api -X PUT repos/o/r/pulls/1/merge", "gh api graphql -f query='mutation { mergePullRequest(input:{}) { clientMutationId } }'",
            "env git push", "command git push"] {
            assert!(is_forbidden(command), "{command}");
        }
    }

    #[test]
    fn unclear_commands_need_a_person_even_in_auto() {
        for command in ["git $'push' origin main", "git ${X:-push}", "$G push", "git pu* origin", "git -c core.sshCommand=x fetch",
            "git -c alias.x='!sh p' x", "npm test 'unfinished", "git \"$(echo push)\""] {
            assert!(must_ask(command), "{command}");
        }
        for command in ["git status", "npm test", "ls -la src", "cargo test --lib", "echo $HOME", "cat a && git diff"] {
            assert!(!must_ask(command), "{command}");
        }
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
