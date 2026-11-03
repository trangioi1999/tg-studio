//! One entry per supported agent. Phase 0 runs agents in their headless
//! (non-interactive) mode; phase 1 adds an ACP client for richer control.

use serde::{Deserialize, Serialize};

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
