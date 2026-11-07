//! Subscription limits reported by Claude's local /usage command.

use std::{process::Stdio, time::{Duration, Instant}};

use chrono::{DateTime, Datelike, Local, NaiveDateTime, TimeZone};
use tauri::State;
use tokio::sync::Mutex;

use crate::{adapters::AgentKind, env, store::{AccountLimits, Store}, usage::LimitWindow};

// Hold the lock through the request so concurrent refreshes share its saved result.
static LAST_REFRESH: Mutex<Option<Instant>> = Mutex::const_new(None);

fn reset_time(text: &str, now: DateTime<Local>) -> Option<u64> {
    let date = text.split(" (").next()?.trim();
    let in_year = |year| {
        let date = NaiveDateTime::parse_from_str(
            &format!("{year} {date}"), "%Y %b %e at %I:%M%P",
        ).ok()?;
        Local.from_local_datetime(&date).single()
    };
    let mut reset = in_year(now.year())?;
    if now.signed_duration_since(reset) > chrono::Duration::days(1) {
        reset = in_year(now.year() + 1)?;
    }
    u64::try_from(reset.timestamp_millis()).ok()
}

pub fn parse_usage_text(text: &str, now: DateTime<Local>) -> Option<Vec<LimitWindow>> {
    let windows: Vec<_> = text.lines().filter_map(|line| {
        let (name, value) = line.trim().split_once(": ")?;
        let id = match name {
            "Current session" => "five_hour".to_string(),
            "Current week (all models)" => "seven_day".to_string(),
            _ => {
                let model = name.strip_prefix("Current week (")?.strip_suffix(" only)")?;
                if model.trim().is_empty() { return None; }
                format!("seven_day_{}", model.to_lowercase().split_whitespace().collect::<Vec<_>>().join("_"))
            }
        };
        let (percent, rest) = value.split_once("% used")?;
        let percent: f64 = percent.trim().parse().ok()?;
        if !percent.is_finite() || percent < 0.0 { return None; }
        let rest = rest.trim();
        let resets_at = if rest.is_empty() {
            None
        } else {
            Some(reset_time(rest.strip_prefix("· resets ")?, now)?)
        };
        Some(LimitWindow { id, utilization: percent / 100.0, resets_at, status: None })
    }).collect();
    (!windows.is_empty()).then_some(windows)
}

pub fn parse_usage_output(json: &str, now: DateTime<Local>) -> Option<Vec<LimitWindow>> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    if value.get("type")?.as_str()? != "result"
        || value.get("is_error")?.as_bool()?
        || value.get("local_command")?.as_str()? != "usage"
    {
        return None;
    }
    parse_usage_text(value.get("result")?.as_str()?, now)
}

fn saved_limits(store: &Store) -> Result<Option<AccountLimits>, String> {
    store.all_limits()
        .map(|limits| limits.into_iter().find(|limits| limits.agent == AgentKind::Claude))
        .map_err(|e| format!("Không đọc được hạn mức Claude đã lưu: {e}"))
}

#[tauri::command]
pub async fn refresh_claude_limits(store: State<'_, Store>) -> Result<Option<AccountLimits>, String> {
    let mut last = LAST_REFRESH.lock().await;
    if last.is_some_and(|at| at.elapsed() < Duration::from_secs(60)) {
        return saved_limits(&store);
    }
    let Some(claude) = env::which("claude") else { return Ok(None); };
    // Never the home folder: Claude looks around its working folder at startup, and macOS
    // then asks for Desktop, Documents, Downloads, Photos… on behalf of TG Studio. The
    // limits belong to the account, so an empty folder of our own is enough.
    let dir = std::env::temp_dir().join("tg-studio-usage");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Không tạo được thư mục tạm {}: {e}", dir.display()))?;
    let mut command = env::command(claude);
    // Not saved as a session: this runs every few minutes and would fill `claude --resume`.
    command.args(["-p", "/usage", "--output-format", "json", "--no-session-persistence"])
        .env("PATH", env::login_path())
        .current_dir(&dir)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    *last = Some(Instant::now());
    let output = tokio::time::timeout(Duration::from_secs(30), command.output()).await
        .map_err(|_| "Đọc hạn mức Claude quá 30 giây; đã dừng tiến trình.".to_string())?
        .map_err(|e| format!("Không chạy được lệnh đọc hạn mức Claude: {e}"))?;
    if !output.status.success() { return Ok(None); }
    let now = Local::now();
    let Some(windows) = parse_usage_output(&String::from_utf8_lossy(&output.stdout), now) else {
        return Ok(None);
    };
    let now_ms = u64::try_from(now.timestamp_millis())
        .map_err(|_| "Đồng hồ hệ thống không hợp lệ.".to_string())?;
    store.set_limits(AgentKind::Claude, &windows, now_ms)
        .map_err(|e| format!("Không lưu được hạn mức Claude: {e}"))?;
    saved_limits(&store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(year, month, day, hour, minute, 0).single().unwrap()
    }

    #[test]
    fn real_fixture_has_local_reset_times() {
        let windows = parse_usage_output(
            include_str!("../tests/fixtures/claude/2.1.319/usage-command.json"),
            local(2026, 11, 7, 12, 0),
        ).unwrap();
        assert_eq!(windows, vec![
            LimitWindow { id: "five_hour".into(), utilization: 0.08,
                resets_at: Some(local(2026, 11, 7, 18, 59).timestamp_millis() as u64), status: None },
            LimitWindow { id: "seven_day".into(), utilization: 0.18,
                resets_at: Some(local(2026, 11, 9, 3, 59).timestamp_millis() as u64), status: None },
        ]);
    }

    #[test]
    fn model_windows_can_have_no_reset() {
        let windows = parse_usage_text("Current week (Sonnet only): 25% used\nCurrent week (Opus 4 only): 110% used", Local::now()).unwrap();
        assert_eq!(windows[0], LimitWindow { id: "seven_day_sonnet".into(), utilization: 0.25, resets_at: None, status: None });
        assert_eq!(windows[1].id, "seven_day_opus_4");
        assert_eq!(windows[1].utilization, 1.1);
    }

    #[test]
    fn midnight_and_noon_are_distinct() {
        let now = local(2026, 11, 7, 0, 0);
        for (suffix, hour) in [("am", 0), ("pm", 12)] {
            let text = format!("Current session: 8% used · resets Nov 7 at 12:05{suffix} (Asia/Saigon)");
            assert_eq!(parse_usage_text(&text, now).unwrap()[0].resets_at,
                Some(local(2026, 11, 7, hour, 5).timestamp_millis() as u64));
        }
    }

    #[test]
    fn resets_roll_into_next_year_only_after_one_day() {
        let text = "Current session: 8% used · resets Jan 2 at 1:00pm (Asia/Saigon)";
        assert_eq!(parse_usage_text(text, local(2026, 12, 31, 12, 0)).unwrap()[0].resets_at,
            Some(local(2027, 1, 2, 13, 0).timestamp_millis() as u64));
        assert_eq!(parse_usage_text(text, local(2026, 1, 3, 13, 0)).unwrap()[0].resets_at,
            Some(local(2026, 1, 2, 13, 0).timestamp_millis() as u64));
    }

    #[test]
    fn api_key_and_invalid_lines_have_no_limits() {
        for text in ["You are using an API key.", "Current session: NaN% used", "Current session: -1% used",
            "Current session: 8% used · resets Bad 99 at 1:00pm (UTC)"] {
            assert_eq!(parse_usage_text(text, Local::now()), None);
        }
    }

    #[test]
    fn only_successful_local_usage_results_are_accepted() {
        let fixture = include_str!("../tests/fixtures/claude/2.1.319/usage-command.json");
        for (key, value) in [("is_error", serde_json::json!(true)),
            ("type", serde_json::json!("system")), ("local_command", serde_json::json!("help")),
            ("result", serde_json::json!("You are using an API key."))] {
            let mut output: serde_json::Value = serde_json::from_str(fixture).unwrap();
            output[key] = value;
            assert_eq!(parse_usage_output(&output.to_string(), Local::now()), None);
        }
        assert_eq!(parse_usage_output("not json", Local::now()), None);
    }
}
