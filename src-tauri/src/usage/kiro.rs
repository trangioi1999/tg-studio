//! Kiro's plan credits, from `kiro-cli chat --no-interactive /usage --v2`.
//!
//! Kiro sends no plan numbers over ACP, and its CLI has no machine-readable usage command
//! (kirodotdev/Kiro#7752), so this reads the report `/usage` prints. The same report is
//! read by CodexBar (MIT), whose notes on its formats this follows: a bar `████ 17%`,
//! `(334.17 of 2000 covered in plan)`, `resets on 2026-12-01` or `on 12/01`, the plan name
//! after a `|` (`| KIRO PRO+`), and `Bonus credits: 1.00/100`. `--v2` keeps Kiro CLI 3 from
//! sending the slash command to the model as a prompt; an older CLI that rejects the flag
//! is asked again without it.

use std::{process::Stdio, time::{Duration, Instant}};

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone};
use tauri::State;
use tokio::sync::Mutex;

use crate::{agents::adapters::AgentKind, store::{AccountLimits, Store}, system::env, usage::LimitWindow};

static LAST_REFRESH: Mutex<Option<Instant>> = Mutex::const_new(None);

/// Drops terminal colour and cursor codes.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' { out.push(c); continue; }
        match chars.peek() {
            Some('[') => {
                chars.next();
                while let Some(&n) = chars.peek() { chars.next(); if ('@'..='~').contains(&n) { break; } }
            }
            Some(']') => { while let Some(n) = chars.next() { if n == '\u{7}' { break; } } }
            _ => {}
        }
    }
    out
}

/// The first number at the start of `text` ("334.17 of …" → 334.17).
fn leading_number(text: &str) -> Option<f64> {
    let end = text.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(text.len());
    text[..end].parse().ok().filter(|v: &f64| v.is_finite() && *v >= 0.0)
}

/// `KIRO PRO+` → `Kiro Pro+`.
fn display_plan(raw: &str) -> String {
    raw.split_whitespace().map(|word| {
        let mut chars = word.chars();
        chars.next().map(|first| first.to_uppercase().chain(chars.flat_map(char::to_lowercase)).collect::<String>()).unwrap_or_default()
    }).collect::<Vec<_>>().join(" ")
}

fn plan_name(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Some(rest) = line.trim().strip_prefix("Plan:") {
            let name = rest.split('|').next()?.trim();
            if !name.is_empty() { return Some(display_plan(name)); }
        }
        if let Some(at) = line.find("KIRO ") {
            if line[..at].trim_end().ends_with('|') {
                let name: String = line[at..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '+').collect();
                return Some(display_plan(name.trim()));
            }
        }
    }
    None
}

fn reset_at(text: &str, now: DateTime<Local>) -> Option<u64> {
    let rest = &text[text.find("resets on ")? + "resets on ".len()..];
    let token: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '/').collect();
    let date = if let Ok(date) = NaiveDate::parse_from_str(&token, "%Y-%m-%d") { date } else {
        let (month, day) = token.split_once('/')?;
        let (month, day): (u32, u32) = (month.parse().ok()?, day.parse().ok()?);
        let this_year = NaiveDate::from_ymd_opt(now.year(), month, day)?;
        if this_year < now.date_naive() { NaiveDate::from_ymd_opt(now.year() + 1, month, day)? } else { this_year }
    };
    let midnight = Local.from_local_datetime(&date.and_hms_opt(0, 0, 0)?).earliest()?;
    u64::try_from(midnight.timestamp_millis()).ok()
}

/// The plan window (`monthly`) and, when the report has them, bonus credits (`bonus`).
/// `None` when the report has no usage numbers (not logged in, unknown format, managed plan).
pub fn parse_usage_text(raw: &str, now: DateTime<Local>) -> Option<Vec<LimitWindow>> {
    let text = strip_ansi(raw);
    let lower = text.to_lowercase();
    if lower.contains("not logged in") || lower.contains("kiro-cli login") || lower.contains("could not retrieve usage") { return None; }
    let percent = text.find('█').and_then(|at| {
        let after = text[at..].trim_start_matches('█').trim_start();
        let number = leading_number(after)?;
        after[after.find(|c: char| !(c.is_ascii_digit() || c == '.'))?..].starts_with('%').then_some(number)
    });
    let covered = text.find(" covered").and_then(|end| {
        let start = text[..end].rfind('(')?;
        let inside = &text[start + 1..end];
        let (used, limit) = inside.split_once(" of ")?;
        Some((leading_number(used.trim())?, leading_number(limit.trim())?))
    });
    let utilization = match (percent, covered) {
        (Some(p), _) => p / 100.0,
        (None, Some((used, limit))) if limit > 0.0 => used / limit,
        _ => return None,
    };
    let plan = plan_name(&text);
    let mut windows = vec![LimitWindow {
        id: "monthly".into(), utilization, resets_at: reset_at(&text, now), status: None,
        used: covered.map(|c| c.0), limit: covered.map(|c| c.1), plan,
    }];
    if let Some(at) = text.find("Bonus credits:") {
        // The numbers may be on the next line of the box, after its border.
        let after = &text[at + "Bonus credits:".len()..];
        let rest = &after[after.find(|c: char| c.is_ascii_digit()).unwrap_or(after.len())..];
        if let Some((used, limit)) = rest.split_once('/') {
            if let (Some(used), Some(limit)) = (leading_number(used.trim()), leading_number(limit.trim())) {
                if limit > 0.0 {
                    windows.push(LimitWindow { id: "bonus".into(), utilization: used / limit, resets_at: None, status: None, used: Some(used), limit: Some(limit), plan: None });
                }
            }
        }
    }
    Some(windows)
}

/** Why a report gave no numbers, in words for the status bar's tooltip. */
pub fn usage_problem(raw: &str) -> String {
    let text = strip_ansi(raw);
    let lower = text.to_lowercase();
    if lower.contains("not logged in") || lower.contains("kiro-cli login") {
        return "Kiro CLI báo chưa đăng nhập. Chạy kiro-cli login trong terminal.".into();
    }
    let tail: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).rev().take(3).collect();
    if tail.is_empty() { return "Lệnh /usage của Kiro không in ra gì.".into(); }
    let tail: Vec<&str> = tail.into_iter().rev().collect();
    format!("Lệnh /usage của Kiro không có số credit. Kiro in ra: {}", tail.join(" · "))
}

fn saved_limits(store: &Store) -> Result<Option<AccountLimits>, String> {
    store.all_limits()
        .map(|limits| limits.into_iter().find(|limits| limits.agent == AgentKind::Kiro))
        .map_err(|e| format!("Không đọc được hạn mức Kiro đã lưu: {e}"))
}

async fn usage_report(kiro: &std::path::Path, v2: bool) -> Result<String, String> {
    let dir = std::env::temp_dir().join("tg-studio-usage");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Không tạo được thư mục tạm {}: {e}", dir.display()))?;
    let mut command = env::command(kiro);
    command.args(["chat", "--no-interactive", "/usage"]);
    if v2 { command.arg("--v2"); }
    command.env("PATH", env::login_path()).env("NO_COLOR", "1")
        .current_dir(&dir).stdin(Stdio::null()).kill_on_drop(true);
    // Kiro waits for the user's MCP servers before it answers (up to its
    // mcp.noInteractiveTimeout), so this can take a while.
    let output = tokio::time::timeout(Duration::from_secs(120), command.output()).await
        .map_err(|_| "Đọc hạn mức Kiro quá 2 phút; đã dừng. Kiro có thể đang chờ MCP server (xem q settings mcp.noInteractiveTimeout).".to_string())?
        .map_err(|e| format!("Không chạy được lệnh đọc hạn mức Kiro: {e}"))?;
    Ok(format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
}

/// Kiro's plan credits from its `/usage` report; at most once a minute, like Claude's.
#[tauri::command]
pub async fn refresh_kiro_limits(store: State<'_, Store>) -> Result<Option<AccountLimits>, String> {
    let mut last = LAST_REFRESH.lock().await;
    if last.is_some_and(|at| at.elapsed() < Duration::from_secs(60)) { return saved_limits(&store); }
    let Some(kiro) = env::which("kiro-cli") else { return Ok(None); };
    *last = Some(Instant::now());
    let now = Local::now();
    let mut report = usage_report(&kiro, true).await?;
    // An older CLI rejects the flag (its wording varies by version): ask again without it.
    if parse_usage_text(&report, now).is_none() && report.contains("--v2") {
        report = usage_report(&kiro, false).await?;
    }
    let Some(windows) = parse_usage_text(&report, now) else { return Err(usage_problem(&report)); };
    let now_ms = u64::try_from(now.timestamp_millis()).map_err(|_| "Đồng hồ hệ thống không hợp lệ.".to_string())?;
    store.set_limits(AgentKind::Kiro, &windows, now_ms).map_err(|e| format!("Không lưu được hạn mức Kiro: {e}"))?;
    saved_limits(&store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(year: i32, month: u32, day: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(year, month, day, 12, 0, 0).single().unwrap()
    }
    fn midnight(year: i32, month: u32, day: u32) -> u64 {
        Local.with_ymd_and_hms(year, month, day, 0, 0, 0).single().unwrap().timestamp_millis() as u64
    }

    #[test]
    fn boxed_report_with_bar_credits_reset_and_bonus() {
        let report = "\u{1b}[1m┏━━━━┓\u{1b}[0m\n┃      | KIRO FREE      ┃\n┃ Monthly credits:  ┃\n┃ ██████████████ 100% (resets on 01/01) ┃\n┃     (0.00 of 50 covered in plan)  ┃\n┃ Bonus credits:  ┃\n┃ 0.00/100 credits used, expires in 88 days ┃\n┗━━━━┛";
        let windows = parse_usage_text(report, local(2026, 11, 13)).unwrap();
        assert_eq!(windows[0], LimitWindow { id: "monthly".into(), utilization: 1.0, resets_at: Some(midnight(2027, 1, 1)), status: None,
            used: Some(0.0), limit: Some(50.0), plan: Some("Kiro Free".into()) });
        assert_eq!(windows[1].id, "bonus");
        assert_eq!((windows[1].used, windows[1].limit), (Some(0.0), Some(100.0)));
    }

    #[test]
    fn estimated_usage_report_keeps_the_plus_of_the_plan() {
        let report = "\u{1b}[1mEstimated Usage\u{1b}[0m | resets on 2026-12-01 | \u{1b}[32mKIRO PRO+\u{1b}[0m\nCredits (334.17 of 2000 covered in plan)\n";
        let windows = parse_usage_text(report, local(2026, 11, 13)).unwrap();
        assert_eq!(windows.len(), 1);
        let w = &windows[0];
        assert_eq!(w.plan.as_deref(), Some("Kiro Pro+"));
        assert_eq!((w.used, w.limit), (Some(334.17), Some(2000.0)));
        assert!((w.utilization - 334.17 / 2000.0).abs() < 1e-9);
        assert_eq!(w.resets_at, Some(midnight(2026, 12, 1)));
    }

    #[test]
    fn kiro_2_12_report_after_mcp_errors_on_windows() {
        // kiro-cli 2.12.3 on Windows, plan through an organization, two MCP servers failing.
        let report = "\u{1b}[31mError:\u{1b}[0m File URI not found: file://C:\\Users\\u\\AppData\\Local\\Programs\\KiroCrew\\prompt.md (resolved to C:\\Users\\u\\prompt.md)\nNot all mcp servers loaded. Configure non-interactive timeout with q settings mcp.noInteractiveTimeout\n------\n\n\u{1b}[1mEstimated Usage\u{1b}[0m | resets on 2026-12-01 | \u{1b}[35mKIRO PRO+\u{1b}[0m\n\u{1b}[1mCredits\u{1b}[0m (334.87 of 2000 covered in plan)\n\u{1b}[45m          \u{1b}[47m                                        \u{1b}[0m 16%\n\nSince your account is through your organization, for account management please contact your account administrator.\n\nTip: to see context window usage, run /context\n";
        let windows = parse_usage_text(report, local(2026, 11, 13)).unwrap();
        assert_eq!(windows.len(), 1);
        let w = &windows[0];
        assert_eq!((w.plan.as_deref(), w.used, w.limit), (Some("Kiro Pro+"), Some(334.87), Some(2000.0)));
        assert!((w.utilization - 334.87 / 2000.0).abs() < 1e-9);
        assert_eq!(w.resets_at, Some(midnight(2026, 12, 1)));
    }

    #[test]
    fn a_report_without_numbers_says_what_kiro_printed() {
        assert!(usage_problem("error: unexpected argument '--v2' found\n\nUsage: kiro-cli chat [OPTIONS]").contains("unexpected argument"));
        assert!(usage_problem("You are not logged in").contains("chưa đăng nhập"));
        assert_eq!(usage_problem("  \n"), "Lệnh /usage của Kiro không in ra gì.");
    }

    #[test]
    fn no_numbers_or_no_login_reads_as_nothing() {
        assert!(parse_usage_text("Plan: KIRO PRO MAX | 1 usage breakdowns", Local::now()).is_none());
        assert!(parse_usage_text("Error: not logged in. Run kiro-cli login", Local::now()).is_none());
        assert!(parse_usage_text("", Local::now()).is_none());
        assert_eq!(plan_name("Plan: KIRO PRO MAX | 1 usage breakdowns").as_deref(), Some("Kiro Pro Max"));
    }
}
