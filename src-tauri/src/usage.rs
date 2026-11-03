//! Turns each agent's JSON output lines into one normalized `Usage` record.
//!
//! Normalization: `input_tokens` is always the *uncached* input. Agents that
//! report total prompt tokens (Codex, Gemini) have the cached part subtracted.

use serde::Serialize;
use serde_json::Value;

use crate::adapters::AgentKind;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    /// USD when the CLI reports it (Claude Code). Otherwise the UI estimates
    /// it from the price table in `src/app/core/pricing.ts`.
    pub cost_usd: Option<f64>,
    /// "reported" (cost from the CLI) or "tokens" (token counts only).
    pub source: &'static str,
    /// True: a running total for the run, so it replaces earlier numbers.
    /// False: one turn's usage, so it adds to earlier numbers.
    pub cumulative: bool,
}

pub fn parse_line(agent: AgentKind, line: &str) -> Option<Usage> {
    let line = line.trim();
    if !line.starts_with('{') {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    match agent {
        AgentKind::Claude => parse_claude(&v),
        AgentKind::Codex => parse_codex(&v),
        AgentKind::Gemini => parse_gemini(&v),
        AgentKind::Kiro => None,
    }
}

fn n(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

fn first_u64(v: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_u64))
        .unwrap_or(0)
}

/// Last line of `claude -p --output-format stream-json`: `{"type":"result", ...}`.
fn parse_claude(v: &Value) -> Option<Usage> {
    if v.get("type")?.as_str()? != "result" {
        return None;
    }
    let u = v.get("usage")?;
    Some(Usage {
        input_tokens: n(&u["input_tokens"]) + n(&u["cache_creation_input_tokens"]),
        cached_input_tokens: n(&u["cache_read_input_tokens"]),
        output_tokens: n(&u["output_tokens"]),
        cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
        source: "reported",
        cumulative: true,
    })
}

/// `codex exec --json`: usage arrives on each `turn.completed` event.
fn parse_codex(v: &Value) -> Option<Usage> {
    if v.get("type")?.as_str()? != "turn.completed" {
        return None;
    }
    let u = v.get("usage")?;
    let input = n(&u["input_tokens"]);
    let cached = n(&u["cached_input_tokens"]);
    Some(Usage {
        input_tokens: input.saturating_sub(cached),
        cached_input_tokens: cached,
        output_tokens: n(&u["output_tokens"]),
        cost_usd: None,
        source: "tokens",
        cumulative: false,
    })
}

/// Gemini CLI streaming `result` event carries aggregated `stats`, with a
/// per-model token breakdown. Field names are matched loosely on purpose.
fn parse_gemini(v: &Value) -> Option<Usage> {
    if v.get("type")?.as_str()? != "result" {
        return None;
    }
    let stats = v.get("stats")?;
    let mut usage = Usage {
        source: "tokens",
        cumulative: true,
        ..Default::default()
    };
    if let Some(models) = stats.get("models").and_then(Value::as_object) {
        for model in models.values() {
            let t = &model["tokens"];
            let prompt = first_u64(t, &["prompt", "input"]);
            let cached = first_u64(t, &["cached"]);
            usage.input_tokens += prompt.saturating_sub(cached);
            usage.cached_input_tokens += cached;
            usage.output_tokens += first_u64(t, &["candidates", "output"]);
        }
    } else {
        usage.input_tokens = first_u64(stats, &["input_tokens", "prompt_tokens"]);
        usage.output_tokens = first_u64(stats, &["output_tokens", "candidates_tokens"]);
    }
    if usage.input_tokens + usage.cached_input_tokens + usage.output_tokens == 0 {
        return None;
    }
    Some(usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_fixture_usage() {
        let fixture = include_str!("../tests/fixtures/claude/2.1.317/readonly.jsonl");
        let events: Vec<_> = fixture.lines()
            .filter_map(|line| parse_line(AgentKind::Claude, line))
            .collect();
        // The fixture has one result: 4 input + 15379 cache creation,
        // 33208 cache reads, 84 output, and a reported cost of $0.1313696.
        assert_eq!(events, vec![Usage {
            input_tokens: 15_383,
            cached_input_tokens: 33_208,
            output_tokens: 84,
            cost_usd: Some(0.1313696),
            source: "reported",
            cumulative: true,
        }]);
    }

    #[test]
    fn codex_fixture_usage() {
        let fixture = include_str!("../tests/fixtures/codex/0.166.0/readonly.jsonl");
        let events: Vec<_> = fixture.lines()
            .filter_map(|line| parse_line(AgentKind::Codex, line))
            .collect();
        // The fixture has one turn.completed: 31731 total input, including
        // 28800 cached tokens, and 51 output tokens; no reported cost.
        assert_eq!(events, vec![Usage {
            input_tokens: 2_931,
            cached_input_tokens: 28_800,
            output_tokens: 51,
            cost_usd: None,
            source: "tokens",
            cumulative: false,
        }]);
    }

    #[test]
    fn claude_result_line() {
        let line = r#"{"type":"result","subtype":"success","total_cost_usd":0.0123,"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":42}}"#;
        let u = parse_line(AgentKind::Claude, line).unwrap();
        assert_eq!((u.input_tokens, u.cached_input_tokens, u.output_tokens), (15, 100, 42));
        assert_eq!(u.cost_usd, Some(0.0123));
        assert!(u.cumulative);
    }

    #[test]
    fn codex_turn_completed() {
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50}}"#;
        let u = parse_line(AgentKind::Codex, line).unwrap();
        assert_eq!((u.input_tokens, u.cached_input_tokens, u.output_tokens), (600, 400, 50));
        assert_eq!(u.cost_usd, None);
        assert!(!u.cumulative);
    }

    #[test]
    fn gemini_per_model_stats() {
        let line = r#"{"type":"result","stats":{"models":{"gemini-pro":{"tokens":{"prompt":500,"cached":100,"candidates":20}}}}}"#;
        let u = parse_line(AgentKind::Gemini, line).unwrap();
        assert_eq!((u.input_tokens, u.cached_input_tokens, u.output_tokens), (400, 100, 20));
    }

    #[test]
    fn ignores_other_lines() {
        assert!(parse_line(AgentKind::Claude, "plain text").is_none());
        assert!(parse_line(AgentKind::Codex, r#"{"type":"item.completed"}"#).is_none());
        assert!(parse_line(AgentKind::Kiro, r#"{"type":"result"}"#).is_none());
    }
}
