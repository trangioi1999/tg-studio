//! One entry per supported agent. Phase 0 runs agents in their headless
//! (non-interactive) mode; phase 1 adds an ACP client for richer control.

use serde::{Deserialize, Serialize};
use std::{path::{Path, PathBuf}, time::Duration};

/// npm may need to download the adapter before its first ACP reply.
pub fn setup_timeout(program: &Path) -> Duration {
    // Also recognize Windows paths when checking configuration on macOS/Unix.
    let normalized = program.to_string_lossy().replace('\\', "/");
    let is_npx = Path::new(&normalized).file_stem().is_some_and(|stem| stem == "npx");
    Duration::from_secs(if is_npx { 300 } else { 60 })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Gemini,
    Kiro,
}

impl AgentKind {
    pub const ALL: [AgentKind; 4] = [
        AgentKind::Claude,
        AgentKind::Codex,
        AgentKind::Gemini,
        AgentKind::Kiro,
    ];

    pub fn display_name(self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude Code",
            AgentKind::Codex => "Codex",
            AgentKind::Gemini => "Gemini CLI",
            AgentKind::Kiro => "Kiro CLI",
        }
    }

    pub fn binary(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Gemini => "gemini",
            AgentKind::Kiro => "kiro-cli",
        }
    }

    /// Resolve an ACP executable without involving a shell.
    pub fn acp_command(self, which: impl Fn(&str) -> Option<PathBuf>) -> Option<(PathBuf, Vec<String>)> {
        let (binary, package) = match self {
            AgentKind::Claude => ("claude-agent-acp", "@agentclientprotocol/claude-agent-acp@0.100.0"),
            AgentKind::Codex => ("codex-acp", "@agentclientprotocol/codex-acp@2.5.0"),
            AgentKind::Kiro => return which("kiro-cli").map(|path| (path, vec!["acp".into()])),
            AgentKind::Gemini => return which("gemini").map(|path| (path, vec!["--experimental-acp".into()])),
        };
        which(binary).map(|path| (path, vec![]))
            .or_else(|| which("npx").map(|path| (path, vec!["-y".into(), package.into()])))
    }

    /// Continues the CLI's own session. Writing stays blocked, as in `headless_args`.
    pub fn resume_args(self, args: Vec<String>, session: &str) -> Vec<String> {
        match self {
            AgentKind::Claude => args.into_iter().chain(["--resume".to_string(), session.to_string()]).collect(),
            // `exec resume` has no --sandbox flag; its config override does the same.
            AgentKind::Codex => {
                let prompt = args.last().cloned().unwrap_or_default();
                ["exec", "resume", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"read-only\"", session].into_iter()
                    .map(String::from).chain([prompt]).collect()
            }
            AgentKind::Gemini | AgentKind::Kiro => args,
        }
    }

    /// A headless run's arguments and what to write to its stdin. Claude keeps one process
    /// for a whole conversation and reads every question from stdin (`headless_input`).
    /// Rust refuses line breaks in arguments to a batch file, which is what npm installs on
    /// Windows, so such a Codex prompt goes through stdin; otherwise it stays an argument.
    pub fn headless_invocation(self, prompt: &str, program: &Path) -> Option<(Vec<String>, Option<String>)> {
        let args = self.headless_args(prompt)?;
        if let Some(input) = self.headless_input(prompt) { return Some((args, Some(input))); }
        let batch = program.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
        if !batch || !prompt.contains(['\r', '\n']) { return Some((args, None)); }
        let mut args = args;
        *args.last_mut()? = "-".into();
        Some((args, Some(prompt.to_string())))
    }

    /// One question for a live headless session, as the line its stdin expects. `None`: the
    /// agent takes its prompt as an argument and answers once.
    pub fn headless_input(self, prompt: &str) -> Option<String> {
        match self {
            AgentKind::Claude => Some(format!("{}\n", serde_json::json!({"type": "user", "message": {"role": "user", "content": prompt}}))),
            _ => None,
        }
    }

    /// Arguments for a read-only run that prints JSON lines. It runs in the user's real
    /// folder, so writing must be blocked by the CLI: its own defaults come from the user's
    /// settings, where approvals may be off. `None`: no blocking flag has been verified for
    /// this agent, so it is reachable through ACP tasks only.
    pub fn headless_args(self, prompt: &str) -> Option<Vec<String>> {
        let p = prompt.to_string();
        match self {
            AgentKind::Claude => Some([
                "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                "--include-partial-messages", "--permission-mode", "plan",
            ].into_iter().map(String::from).collect()),
            AgentKind::Codex => Some(vec!["exec".into(), "--json".into(), "--sandbox".into(), "read-only".into(), "--skip-git-repo-check".into(), p]),
            AgentKind::Gemini | AgentKind::Kiro => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn read_only_runs_are_blocked_from_writing_by_the_cli() {
        for shim in ["/usr/bin/agent", "agent.cmd"] {
            for prompt in ["một dòng", "một\nhai"] {
                let (claude, _) = AgentKind::Claude.headless_invocation(prompt, Path::new(shim)).unwrap();
                assert!(claude.windows(2).any(|w| w == ["--permission-mode", "plan"]), "{claude:?}");
                let (codex, _) = AgentKind::Codex.headless_invocation(prompt, Path::new(shim)).unwrap();
                assert!(codex.windows(2).any(|w| w == ["--sandbox", "read-only"]), "{codex:?}");
            }
        }
        assert_eq!(AgentKind::Gemini.headless_args("x"), None, "chưa kiểm chứng được cờ chặn ghi");
        assert_eq!(AgentKind::Kiro.headless_args("x"), None);
    }

    #[test]
    fn resuming_a_read_only_run_stays_read_only() {
        let (args, _) = AgentKind::Claude.headless_invocation("câu hai", Path::new("/bin/claude")).unwrap();
        let args = AgentKind::Claude.resume_args(args, "s1");
        assert!(args.windows(2).any(|w| w == ["--resume", "s1"]));
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "plan"]));
        let (args, _) = AgentKind::Codex.headless_invocation("câu hai", Path::new("/bin/codex")).unwrap();
        assert_eq!(AgentKind::Codex.resume_args(args, "s1"), ["exec", "resume", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"read-only\"", "s1", "câu hai"]);
    }

    /// One Claude process takes every question of a conversation as JSON lines on stdin.
    const CLAUDE_ASK: [&str; 10] = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "plan", ""];

    #[test]
    fn claude_questions_go_through_stdin_as_json_lines() {
        for shim in [Path::new("/usr/bin/claude"), Path::new(r"C:\npm\claude.cmd")] {
            let (args, stdin) = AgentKind::Claude.headless_invocation("một\nhai \"ba\"", shim).unwrap();
            assert_eq!(args, CLAUDE_ASK[..9]);
            let line = stdin.unwrap();
            assert!(line.ends_with('\n') && line.matches('\n').count() == 1, "một câu là đúng một dòng: {line:?}");
            let v: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
            assert_eq!(v, serde_json::json!({"type": "user", "message": {"role": "user", "content": "một\nhai \"ba\""}}));
        }
        assert_eq!(AgentKind::Claude.headless_input("câu hai"), Some(AgentKind::Claude.headless_invocation("câu hai", Path::new("/bin/claude")).unwrap().1.unwrap()));
        assert_eq!(AgentKind::Codex.headless_input("x"), None, "Codex không nhận câu tiếp qua stdin");
    }

    #[test]
    fn codex_line_breaks_reach_a_batch_shim_through_stdin() {
        assert_eq!(AgentKind::Codex.headless_invocation("một\r\nhai", Path::new("codex.CMD")).unwrap(), (vec!["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-"].into_iter().map(String::from).collect(), Some("một\r\nhai".to_string())));
        let (args, stdin) = AgentKind::Codex.headless_invocation("một\nhai", Path::new("/usr/bin/codex")).unwrap();
        assert_eq!(args.last().map(String::as_str), Some("một\nhai"));
        assert_eq!(stdin, None);
        assert_eq!(AgentKind::Kiro.headless_invocation("một\nhai", Path::new("kiro.cmd")), None);
    }

    #[test]
    fn setup_timeout_is_longer_through_npx() {
        assert_eq!(setup_timeout(&PathBuf::from("/bin/npx")), std::time::Duration::from_secs(300));
        assert_eq!(setup_timeout(&PathBuf::from(r"C:\n\npx.cmd")), std::time::Duration::from_secs(300));
        assert_eq!(setup_timeout(&PathBuf::from("/bin/codex-acp")), std::time::Duration::from_secs(60));
    }

    #[test]
    fn acp_prefers_dedicated_adapters() {
        for (agent, binary) in [(AgentKind::Claude, "claude-agent-acp"), (AgentKind::Codex, "codex-acp")] {
            let command = agent.acp_command(|name| Some(PathBuf::from(format!("/bin/{name}")))).unwrap();
            assert_eq!(command, (PathBuf::from(format!("/bin/{binary}")), vec![]));
        }
    }

    #[test]
    fn acp_fallback_uses_pinned_packages() {
        for (agent, package) in [(AgentKind::Claude, "@agentclientprotocol/claude-agent-acp@0.100.0"), (AgentKind::Codex, "@agentclientprotocol/codex-acp@2.5.0")] {
            assert_eq!(agent.acp_command(|name| (name == "npx").then(|| PathBuf::from("/bin/npx"))),
                Some((PathBuf::from("/bin/npx"), vec!["-y".into(), package.into()])));
        }
    }

    #[test]
    fn acp_native_agents_and_missing_commands() {
        for (agent, binary, flag) in [(AgentKind::Kiro, "kiro-cli", "acp"), (AgentKind::Gemini, "gemini", "--experimental-acp")] {
            assert_eq!(agent.acp_command(|name| (name == binary).then(|| PathBuf::from(binary))),
                Some((PathBuf::from(binary), vec![flag.into()])));
        }
        for agent in AgentKind::ALL { assert_eq!(agent.acp_command(|_| None), None); }
    }
}
