//! SQLite run history. Callers handle storage errors without stopping a run.

use std::{
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use rusqlite::{params, types::Type, Connection, Error, Result};
use serde::Serialize;
use tauri::State;

use crate::{agents::adapters::AgentKind, usage::{LimitWindow, Usage}, workspace::worktree::Worktree};

mod runs;
mod schema;
mod settings;
mod usage;
mod worktrees;

const RESTORED_RUNS: usize = 100;

pub struct Store(Mutex<Connection>);

pub struct NewRun<'a> {
    pub id: &'a str,
    pub agent: AgentKind,
    pub prompt: &'a str,
    pub cwd: &'a str,
    pub started_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredLine {
    pub kind: String,
    pub line: String,
}

/// USD per 1M tokens from `from_ms` on; all None means "no price" from then on.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRow {
    pub agent: AgentKind,
    pub from_ms: u64,
    pub input: Option<f64>,
    pub cached_input: Option<f64>,
    pub output: Option<f64>,
}

/// One run for the usage ledger: what it was and what it used in the end.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub id: String,
    pub agent: AgentKind,
    pub prompt: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub status: String,
    pub group: Option<String>,
    pub usage: Option<Usage>,
}

/// The latest plan limits an agent's CLI reported, kept across app restarts.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLimits {
    pub agent: AgentKind,
    pub windows: Vec<LimitWindow>,
    /// When the CLI reported them (epoch ms).
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRun {
    pub id: String,
    pub agent: AgentKind,
    pub prompt: String,
    pub cwd: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub status: String,
    pub exit_code: Option<i32>,
    pub usage: Option<Usage>,
    pub lines: Vec<StoredLine>,
    pub worktree: Option<String>,
    /// Runs started together on one prompt (parallel mode) share this id.
    pub group: Option<String>,
    /// The conversation this run belongs to. None for runs from before conversations existed.
    pub thread: Option<String>,
    /// The project folder: the repository of a code task, the folder of a read-only run.
    pub project: String,
    /// The subfolder of the project the conversation is about, with `/`. None: all of it.
    pub scope: Option<String>,
    /// The run that delegated this one through tg-bridge `delegate`.
    pub parent: Option<String>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| Error::ToSqlConversionFailure(Box::new(e)))?;
        }
        Self::initialize(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Store> {
        Self::initialize(Connection::open_in_memory()?)
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.0.lock().map_err(|_| Error::InvalidQuery)
    }
}

#[tauri::command]
pub async fn account_limits(store: State<'_, Store>) -> std::result::Result<Vec<AccountLimits>, String> {
    // Codex keeps its plan limits in its session logs, so they are current even when it ran elsewhere.
    let found = tauri::async_runtime::spawn_blocking(|| {
        let sessions = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from)
            .or_else(|| crate::agents::detect::home_dir().map(|home| std::path::Path::new(&home).join(".codex")))?
            .join("sessions");
        crate::usage::latest_codex_limits(&sessions)
    }).await.ok().flatten();
    if let Some((windows, at)) = found {
        if let Err(e) = store.set_limits(AgentKind::Codex, &windows, at) { eprintln!("Không lưu được hạn mức Codex: {e}"); }
    }
    store.all_limits().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_runs(store: State<'_, Store>) -> std::result::Result<Vec<StoredRun>, String> {
    store.list_runs(RESTORED_RUNS).map_err(|e| e.to_string())
}

/// Folds a run's usage events like the UI does: cumulative replaces, a turn adds.
fn replay(events: impl Iterator<Item = Result<Usage>>) -> Result<Option<Usage>> {
    let mut total: Option<Usage> = None;
    for next in events {
        let mut next = next?;
        if !next.cumulative {
            if let Some(prev) = &total {
                next.input_tokens += prev.input_tokens;
                next.cached_input_tokens += prev.cached_input_tokens;
                next.output_tokens += prev.output_tokens;
                next.cost_usd = match (prev.cost_usd, next.cost_usd) {
                    (None, None) => None,
                    (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
                };
            }
        }
        total = Some(next);
    }
    Ok(total)
}

fn usage_from_row(row: &rusqlite::Row<'_>) -> Result<Usage> {
    let source: String = row.get(4)?;
    Ok(Usage {
        input_tokens: unsigned(row.get(0)?, 0)?, cached_input_tokens: unsigned(row.get(1)?, 1)?,
        output_tokens: unsigned(row.get(2)?, 2)?, cost_usd: row.get(3)?,
        source: if source == "reported" { "reported" } else { "tokens" },
        cumulative: row.get(5)?,
    })
}

fn agent_key(agent: AgentKind) -> Result<String> {
    serde_json::to_value(agent)
        .map_err(|e| Error::ToSqlConversionFailure(Box::new(e)))?
        .as_str().map(str::to_owned).ok_or(Error::InvalidQuery)
}


// SQLite INTEGER is signed; reject out-of-range values instead of truncating.
fn sql_integer(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|e| Error::ToSqlConversionFailure(Box::new(e)))
}

fn unsigned(value: i64, column: usize) -> Result<u64> {
    u64::try_from(value)
        .map_err(|e| Error::FromSqlConversionFailure(column, Type::Integer, Box::new(e)))
}

#[cfg(test)]
mod tests;
