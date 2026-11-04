//! Turns each agent's JSON output lines into one normalized `Usage` record.
//!
//! Normalization: `input_tokens` is always the *uncached* input. Agents that
//! report total prompt tokens (Codex, Gemini) have the cached part subtracted.

use serde::{Deserialize, Serialize};
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

/// ACP usage_update reports context occupancy, not input/output token counts.
/// Only a reported USD cost can be normalized; never guess token usage from `used`.
pub fn parse_acp(update: &Value) -> Option<Usage> {
    if update["sessionUpdate"] != "usage_update" || update["cost"]["currency"] != "USD" { return None; }
    let cost = update["cost"]["amount"].as_f64().filter(|v| v.is_finite() && *v >= 0.0)?;
    Some(Usage {cost_usd:Some(cost),source:"reported",cumulative:true,..Default::default()})
}

/// Token counts from a `session/prompt` result (`usage`: input, output, cache read/write).
/// Cache writes count as input, as for Claude headless. `cost` is the last `usage_update` cost.
pub fn parse_acp_turn(result: &Value, cost: Option<f64>) -> Option<Usage> {
    let u = result.get("usage").filter(|u| u.is_object())?;
    Some(Usage {
        input_tokens: n(&u["inputTokens"]) + n(&u["cachedWriteTokens"]),
        cached_input_tokens: n(&u["cachedReadTokens"]),
        output_tokens: n(&u["outputTokens"]),
        cost_usd: cost,
        source: if cost.is_some() { "reported" } else { "tokens" },
        // One prompt per task, so the turn total is the run total.
        cumulative: true,
    })
}

/// One plan limit window as the CLI reports it, e.g. Claude's 5-hour and 7-day limits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    /// The CLI's own name: "five_hour", "seven_day", ...
    pub id: String,
    /// Share used, 0..1 (can exceed 1 once over the limit).
    pub utilization: f64,
    /// Epoch milliseconds.
    pub resets_at: Option<u64>,
    /// "allowed", "allowed_warning", "rejected", ...
    pub status: Option<String>,
}

/// Claude Code's `rate_limit_info` (stream-json `rate_limit_event`, or the ACP adapter's
/// `usage_update._meta["_claude/rateLimit"]`). Only windows with a reported utilization count:
/// an API-key login has no plan windows, and then nothing is shown.
pub fn parse_rate_limit(info: &Value) -> Option<Vec<LimitWindow>> {
    let window = |id: &str, w: &Value| -> Option<LimitWindow> {
        let utilization = w.get("utilization")?.as_f64().filter(|u| u.is_finite() && *u >= 0.0)?;
        Some(LimitWindow {
            id: id.to_string(),
            utilization,
            resets_at: w.get("resetsAt").and_then(Value::as_u64).map(|s| s * 1000),
            status: w.get("status").and_then(Value::as_str).map(String::from),
        })
    };
    let mut windows: Vec<LimitWindow> = match info.get("unifiedWindows").and_then(Value::as_object) {
        Some(all) => all.iter().filter_map(|(id, w)| window(id, w)).collect(),
        None => info.get("rateLimitType").and_then(Value::as_str).and_then(|id| window(id, info)).into_iter().collect(),
    };
    // Shortest window first: 5 hours before 7 days.
    let rank = |id: &str| match id { "five_hour" => 0, "seven_day" => 1, _ => 2 };
    windows.sort_by(|a, b| rank(&a.id).cmp(&rank(&b.id)).then(a.id.cmp(&b.id)));
    (!windows.is_empty()).then_some(windows)
}

/// Plan limits from one stdout line of a headless run.
pub fn parse_limits(agent: AgentKind, line: &str) -> Option<Vec<LimitWindow>> {
    if agent != AgentKind::Claude || !line.contains("rate_limit_event") { return None; }
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v["type"] != "rate_limit_event" { return None; }
    parse_rate_limit(&v["rate_limit_info"])
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
    fn acp_cost_only_never_invents_tokens_from_context() {
        use serde_json::json;
        let u = parse_acp(&json!({"sessionUpdate":"usage_update","used":100,"size":200,"cost":{"amount":0.25,"currency":"USD"}})).unwrap();
        assert_eq!((u.input_tokens,u.cached_input_tokens,u.output_tokens), (0,0,0));
        assert_eq!(u.cost_usd,Some(0.25)); assert_eq!(u.source,"reported"); assert!(u.cumulative);
        for v in [json!({"used":100}),json!({"cost":{"currency":"EUR","amount":1}}),json!({"cost":{"currency":"USD","amount":-1}})] {
            let mut v=v; v["sessionUpdate"]=json!("usage_update"); assert!(parse_acp(&v).is_none());
        }
    }

    // Recorded from Claude Code 2.1.318 (`claude -p --output-format stream-json --verbose`).
    const RATE_LIMIT_LINE: &str = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793865600,"rateLimitType":"ccr_promotional","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"seven_day":{"utilization":0.1,"resetsAt":1794348000,"status":"allowed"},"five_hour":{"utilization":0.74,"resetsAt":1793770800,"status":"allowed"}}},"uuid":"00000000-0000-0000-0000-000000000000","session_id":"00000000-0000-0000-0000-000000000000"}"#;

    #[test]
    fn claude_rate_limit_event_windows() {
        let w = parse_limits(AgentKind::Claude, RATE_LIMIT_LINE).unwrap();
        assert_eq!(w, vec![
            LimitWindow { id: "five_hour".into(), utilization: 0.74, resets_at: Some(1_793_770_800_000), status: Some("allowed".into()) },
            LimitWindow { id: "seven_day".into(), utilization: 0.1, resets_at: Some(1_794_348_000_000), status: Some("allowed".into()) },
        ]);
        // Other agents and other lines never report limits.
        assert!(parse_limits(AgentKind::Codex, RATE_LIMIT_LINE).is_none());
        assert!(parse_limits(AgentKind::Claude, r#"{"type":"result","usage":{}}"#).is_none());
        assert!(parse_limits(AgentKind::Claude, "rate_limit_event but not json").is_none());
    }

    #[test]
    fn rate_limit_without_utilization_shows_nothing() {
        // An API-key login: a status, but no plan windows to show.
        assert!(parse_rate_limit(&serde_json::json!({"status":"allowed","rateLimitType":"five_hour"})).is_none());
        assert!(parse_rate_limit(&serde_json::json!({"unifiedWindows":{"five_hour":{"utilization":-1}}})).is_none());
        // Older single-window shape.
        let w = parse_rate_limit(&serde_json::json!({"rateLimitType":"five_hour","utilization":0.5,"resetsAt":10,"status":"allowed_warning"})).unwrap();
        assert_eq!((w[0].id.as_str(), w[0].utilization, w[0].resets_at, w[0].status.as_deref()), ("five_hour", 0.5, Some(10_000), Some("allowed_warning")));
    }

    #[test]
    fn acp_turn_usage_from_prompt_result() {
        let u = parse_acp_turn(&serde_json::json!({"stopReason":"end_turn","usage":{"inputTokens":6,"cachedWriteTokens":100,"cachedReadTokens":50,"outputTokens":7}}), None).unwrap();
        assert_eq!((u.input_tokens,u.cached_input_tokens,u.output_tokens,u.cost_usd,u.source,u.cumulative), (106,50,7,None,"tokens",true));
        assert!(parse_acp_turn(&serde_json::json!({"stopReason":"end_turn"}), Some(1.0)).is_none());
        assert!(parse_acp_turn(&serde_json::json!({"usage":null}), Some(1.0)).is_none());
    }

    #[test]
    fn acp_claude_fixture_usage() {
        // Recorded from @agentclientprotocol/claude-agent-acp@0.100.0: one edit, one shell command.
        let fixture = include_str!("../tests/fixtures/claude-agent-acp/0.100.0/edit-session.jsonl");
        let messages: Vec<Value> = fixture.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["msg"].clone()).collect();
        let cost = messages.iter().filter_map(|m| parse_acp(&m["params"]["update"])).last().and_then(|u| u.cost_usd);
        let result = messages.iter().find(|m| m["result"]["stopReason"].is_string()).unwrap();
        let u = parse_acp_turn(&result["result"], cost).unwrap();
        assert_eq!((u.input_tokens, u.cached_input_tokens, u.output_tokens), (8 + 10_444, 141_566, 575));
        assert_eq!(u.source, "reported");
        assert!((u.cost_usd.unwrap() - 0.00392936).abs() < 1e-9);
    }

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

/// Plan limits from one line of a Codex session log, which has `rate_limits` on its
/// `token_count` events. A limit bucket with no windows yields nothing.
pub fn codex_limits_from_line(line: &str) -> Option<Vec<LimitWindow>> {
    if !line.contains("\"rate_limits\"") { return None; }
    let value: Value = serde_json::from_str(line).ok()?;
    let limits = &value["payload"]["rate_limits"];
    let windows: Vec<LimitWindow> = ["primary", "secondary"].iter().filter_map(|key| {
        let w = limits.get(*key).filter(|w| w.is_object())?;
        let id = match w["window_minutes"].as_u64()? {
            300 => "five_hour".to_string(),
            10080 => "seven_day".to_string(),
            minutes => format!("{minutes}_minutes"),
        };
        Some(LimitWindow {
            id,
            utilization: w["used_percent"].as_f64().filter(|p| p.is_finite() && *p >= 0.0)? / 100.0,
            resets_at: w["resets_at"].as_u64().map(|s| s * 1000),
            status: None,
        })
    }).collect();
    (!windows.is_empty()).then_some(windows)
}

/// The newest Codex plan limits on this machine, with when they were written (epoch ms).
/// Reads the most recent session logs only; a log without limits falls through to the next.
pub fn latest_codex_limits(sessions: &std::path::Path) -> Option<(Vec<LimitWindow>, u64)> {
    let mut logs = Vec::new();
    let mut folders = vec![sessions.to_path_buf()];
    while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                folders.push(path);
            } else if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
                let modified = entry.metadata().and_then(|m| m.modified()).ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64);
                logs.push((modified, path));
            }
        }
    }
    logs.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    logs.into_iter().take(10).find_map(|(modified, path)| {
        let text = std::fs::read(&path).ok()?;
        let text = String::from_utf8_lossy(&text);
        text.lines().rev().find_map(codex_limits_from_line).map(|windows| (windows, modified))
    })
}

#[cfg(test)]
mod codex_limit_tests {
    use super::*;

    const LINE: &str = r#"{"timestamp":"2026-11-05T00:00:00Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex","primary":{"used_percent":99.0,"window_minutes":300,"resets_at":1793828266},"secondary":{"used_percent":32.0,"window_minutes":10080,"resets_at":1794332459},"plan_type":"plus"}}}"#;
    const EMPTY: &str = r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"premium","primary":null,"secondary":null}}}"#;

    #[test]
    fn reads_both_windows() {
        let windows = codex_limits_from_line(LINE).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!((windows[0].id.as_str(), windows[0].utilization, windows[0].resets_at), ("five_hour", 0.99, Some(1793828266000)));
        assert_eq!((windows[1].id.as_str(), windows[1].utilization), ("seven_day", 0.32));
    }

    #[test]
    fn ignores_buckets_without_windows_and_other_lines() {
        assert_eq!(codex_limits_from_line(EMPTY), None);
        assert_eq!(codex_limits_from_line("not json with \"rate_limits\""), None);
        assert_eq!(codex_limits_from_line(r#"{"type":"message"}"#), None);
    }

    #[test]
    fn finds_the_newest_limits_and_skips_a_log_without_any() {
        let root = std::env::temp_dir().join(format!("tg-codex-limits-{}", uuid::Uuid::new_v4()));
        let day = root.join("2026/11/05");
        std::fs::create_dir_all(&day).unwrap();
        assert_eq!(latest_codex_limits(&root), None);
        std::fs::write(day.join("old.jsonl"), format!("{LINE}\n{EMPTY}\n")).unwrap();
        let (windows, at) = latest_codex_limits(&root).unwrap();
        assert_eq!(windows.len(), 2);
        assert!(at > 0);
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(latest_codex_limits(std::path::Path::new("/khong/ton/tai")), None);
    }
}
