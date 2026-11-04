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

    /// Arguments for a one-shot headless run that prints JSON lines.
    /// `None` means the agent is only reachable through ACP (phase 1).
    pub fn headless_args(self, prompt: &str) -> Option<Vec<String>> {
        let p = prompt.to_string();
        match self {
            AgentKind::Claude => Some(vec![
                "-p".into(),
                p,
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
            ]),
            AgentKind::Codex => Some(vec!["exec".into(), "--json".into(), p]),
            // Check `gemini --help` if your version names the streaming format differently.
            AgentKind::Gemini => Some(vec![
                "-p".into(),
                p,
                "--output-format".into(),
                "stream-json".into(),
            ]),
            AgentKind::Kiro => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
