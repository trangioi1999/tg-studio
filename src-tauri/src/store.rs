//! SQLite run history. Callers handle storage errors without stopping a run.

use std::{
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use rusqlite::{params, types::Type, Connection, Error, Result};
use serde::Serialize;
use tauri::State;

use crate::{adapters::AgentKind, usage::{LimitWindow, Usage}, worktree::Worktree};

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

    fn initialize(mut conn: Connection) -> Result<Store> {
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let tx = conn.transaction()?;
        let version: u32 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
        match version {
            0 => tx.execute_batch("
                CREATE TABLE runs (
                    id TEXT PRIMARY KEY, agent TEXT NOT NULL, prompt TEXT NOT NULL,
                    cwd TEXT NOT NULL, status TEXT NOT NULL, exit_code INTEGER,
                    started_at INTEGER NOT NULL, ended_at INTEGER,
                    model TEXT, step TEXT, worktree TEXT, task_id TEXT
                );
                CREATE TABLE usage_events (
                    id INTEGER PRIMARY KEY, run_id TEXT REFERENCES runs(id), at INTEGER NOT NULL,
                    input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL, cost_usd REAL,
                    cumulative INTEGER NOT NULL, source TEXT NOT NULL, raw TEXT
                );
                CREATE TABLE run_lines (
                    id INTEGER PRIMARY KEY, run_id TEXT REFERENCES runs(id),
                    kind TEXT NOT NULL, line TEXT NOT NULL, at INTEGER NOT NULL
                );
                CREATE INDEX run_lines_run_id ON run_lines(run_id);
                CREATE INDEX usage_events_run_id_at ON usage_events(run_id, at, id);
                PRAGMA user_version = 1;
            ")?,
            1..=3 => {},
            _ => return Err(Error::InvalidQuery),
        }
        if version < 2 {
            tx.execute_batch("ALTER TABLE runs ADD COLUMN repo TEXT;
                ALTER TABLE runs ADD COLUMN branch TEXT;
                ALTER TABLE runs ADD COLUMN base TEXT;
                CREATE TABLE permission_rules (
                    repo TEXT NOT NULL, agent TEXT NOT NULL, rule TEXT NOT NULL,
                    PRIMARY KEY (repo, agent, rule)
                );
                PRAGMA user_version = 2;")?;
        }
        if version < 3 {
            tx.execute_batch("CREATE TABLE account_limits (
                    agent TEXT PRIMARY KEY, windows TEXT NOT NULL, at INTEGER NOT NULL
                );
                PRAGMA user_version = 3;")?;
        }
        tx.commit()?;
        Ok(Store(Mutex::new(conn)))
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.0.lock().map_err(|_| Error::InvalidQuery)
    }

    pub fn insert_run(&self, run: &NewRun<'_>) -> Result<()> {
        let agent = serde_json::to_value(run.agent)
            .map_err(|e| Error::ToSqlConversionFailure(Box::new(e)))?;
        self.connection()?.execute(
            "INSERT INTO runs (id, agent, prompt, cwd, started_at, status) VALUES (?1, ?2, ?3, ?4, ?5, 'running')",
            params![run.id, agent.as_str(), run.prompt, run.cwd, sql_integer(run.started_at)?],
        )?;
        Ok(())
    }

    /// Keeps only the newest report per agent; an older one never overwrites it.
    pub fn set_limits(&self, agent: AgentKind, windows: &[LimitWindow], at: u64) -> Result<()> {
        let text = serde_json::to_string(windows).map_err(|e| Error::ToSqlConversionFailure(Box::new(e)))?;
        self.connection()?.execute(
            "INSERT INTO account_limits (agent, windows, at) VALUES (?1, ?2, ?3)
             ON CONFLICT(agent) DO UPDATE SET windows = excluded.windows, at = excluded.at WHERE excluded.at >= account_limits.at",
            params![agent_key(agent)?, text, sql_integer(at)?],
        )?;
        Ok(())
    }

    pub fn all_limits(&self) -> Result<Vec<AccountLimits>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare("SELECT agent, windows, at FROM account_limits ORDER BY agent")?;
        let rows = stmt.query_map([], |row| {
            let agent: String = row.get(0)?;
            let agent = serde_json::from_value(serde_json::Value::String(agent))
                .map_err(|e| Error::FromSqlConversionFailure(0, Type::Text, Box::new(e)))?;
            let windows: String = row.get(1)?;
            let windows = serde_json::from_str(&windows)
                .map_err(|e| Error::FromSqlConversionFailure(1, Type::Text, Box::new(e)))?;
            Ok(AccountLimits { agent, windows, at: unsigned(row.get(2)?, 2)? })
        })?;
        rows.collect()
    }

    pub fn add_rule(&self, repo: &str, agent: AgentKind, rule: &str) -> Result<()> {
        let agent = agent_key(agent)?;
        self.connection()?.execute(
            "INSERT OR IGNORE INTO permission_rules (repo, agent, rule) VALUES (?1, ?2, ?3)",
            params![repo, agent, rule],
        )?;
        Ok(())
    }

    pub fn rules_for(&self, repo: &str, agent: AgentKind) -> Result<Vec<String>> {
        let agent = agent_key(agent)?;
        let conn = self.connection()?;
        let mut stmt = conn.prepare("SELECT rule FROM permission_rules WHERE repo = ?1 AND agent = ?2 ORDER BY rule")?;
        let rows = stmt.query_map(params![repo, agent], |row| row.get(0))?;
        rows.collect()
    }

    #[cfg(test)]
    pub fn set_run_worktree(&self, run_id: &str, repo: &str, wt: &Worktree) -> Result<()> {
        write_worktree(&*self.connection()?, run_id, repo, wt)
    }

    pub fn insert_run_with_worktree(&self, run: &NewRun<'_>, repo: &str, wt: &Worktree, group: Option<&str>) -> Result<()> {
        let agent = agent_key(run.agent)?;
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO runs (id, agent, prompt, cwd, started_at, status, task_id) VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6)",
            params![run.id, agent, run.prompt, run.cwd, sql_integer(run.started_at)?, group],
        )?;
        write_worktree(&tx, run.id, repo, wt)?;
        tx.commit()
    }

    pub fn clear_run_worktree(&self, run_id: &str) -> Result<()> {
        self.connection()?.execute(
            "UPDATE runs SET worktree = NULL, branch = NULL, base = NULL WHERE id = ?1",
            params![run_id],
        )?;
        Ok(())
    }

    pub fn run_worktree(&self, run_id: &str) -> Result<(PathBuf, Worktree)> {
        self.connection()?.query_row(
            "SELECT repo, worktree, branch, base FROM runs WHERE id = ?1 AND repo IS NOT NULL
                AND worktree IS NOT NULL AND branch IS NOT NULL AND base IS NOT NULL",
            [run_id], |row| Ok((PathBuf::from(row.get::<_, String>(0)?), Worktree {
                run_id: run_id.into(), path: PathBuf::from(row.get::<_, String>(1)?),
                branch: row.get(2)?, base: row.get(3)?,
            })),
        )
    }

    pub fn append_line(&self, run_id: &str, kind: &str, line: &str, at: u64) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO run_lines (run_id, kind, line, at) VALUES (?1, ?2, ?3, ?4)",
            params![run_id, kind, line, sql_integer(at)?],
        )?;
        Ok(())
    }

    pub fn add_usage(&self, run_id: &str, at: u64, usage: &Usage) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO usage_events (run_id, at, input_tokens, cached_input_tokens, output_tokens, cost_usd, cumulative, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![run_id, sql_integer(at)?, sql_integer(usage.input_tokens)?, sql_integer(usage.cached_input_tokens)?, sql_integer(usage.output_tokens)?,
                usage.cost_usd, usage.cumulative, usage.source],
        )?;
        Ok(())
    }

    pub fn finish_run(&self, run_id: &str, status: &str, code: Option<i32>, at: u64) -> Result<()> {
        self.connection()?.execute(
            "UPDATE runs SET status = ?2, exit_code = ?3, ended_at = ?4 WHERE id = ?1",
            params![run_id, status, code, sql_integer(at)?],
        )?;
        Ok(())
    }

    pub fn mark_interrupted(&self) -> Result<usize> {
        self.connection()?.execute("UPDATE runs SET status = 'interrupted' WHERE status = 'running'", [])
    }

    pub fn list_runs(&self, limit: usize) -> Result<Vec<StoredRun>> {
        let mut conn = self.connection()?;
        // Read the run and its events from a single snapshot, including across connections.
        let tx = conn.transaction()?;
        let mut runs = {
            let mut stmt = tx.prepare(
                "SELECT id, agent, prompt, cwd, started_at, ended_at, status, exit_code, worktree, task_id
                 FROM runs ORDER BY started_at DESC, id DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
                let agent: String = row.get(1)?;
                let agent = serde_json::from_value(serde_json::Value::String(agent))
                    .map_err(|e| Error::FromSqlConversionFailure(1, Type::Text, Box::new(e)))?;
                Ok(StoredRun {
                    id: row.get(0)?, agent, prompt: row.get(2)?, cwd: row.get(3)?,
                    started_at: unsigned(row.get(4)?, 4)?, ended_at: row.get::<_, Option<i64>>(5)?.map(|n| unsigned(n, 5)).transpose()?, status: row.get(6)?,
                    exit_code: row.get(7)?, usage: None, lines: Vec::new(), worktree: row.get(8)?, group: row.get(9)?,
                })
            })?;
            rows.collect::<Result<Vec<_>>>()?
        };
        {
            let mut lines = tx.prepare(
                "SELECT kind, line FROM (SELECT id, kind, line FROM run_lines
                 WHERE run_id = ?1 ORDER BY id DESC LIMIT 2000) ORDER BY id ASC",
            )?;
            let mut events = tx.prepare(
                "SELECT input_tokens, cached_input_tokens, output_tokens, cost_usd, source, cumulative
                 FROM usage_events WHERE run_id = ?1 ORDER BY at ASC, id ASC",
            )?;
            for run in &mut runs {
                run.lines = lines.query_map([&run.id], |row| {
                    Ok(StoredLine { kind: row.get(0)?, line: row.get(1)? })
                })?.collect::<Result<Vec<_>>>()?;
                let usage = events.query_map([&run.id], |row| {
                    let source: String = row.get(4)?;
                    Ok(Usage {
                        input_tokens: unsigned(row.get(0)?, 0)?, cached_input_tokens: unsigned(row.get(1)?, 1)?,
                        output_tokens: unsigned(row.get(2)?, 2)?, cost_usd: row.get(3)?,
                        source: if source == "reported" { "reported" } else { "tokens" },
                        cumulative: row.get(5)?,
                    })
                })?;
                for next in usage {
                    let mut next = next?;
                    if !next.cumulative {
                        if let Some(prev) = &run.usage {
                            next.input_tokens += prev.input_tokens;
                            next.cached_input_tokens += prev.cached_input_tokens;
                            next.output_tokens += prev.output_tokens;
                            next.cost_usd = match (prev.cost_usd, next.cost_usd) {
                                (None, None) => None,
                                (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
                            };
                        }
                    }
                    run.usage = Some(next);
                }
            }
        }
        tx.commit()?;
        Ok(runs)
    }
}

#[tauri::command]
pub async fn account_limits(store: State<'_, Store>) -> std::result::Result<Vec<AccountLimits>, String> {
    store.all_limits().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_runs(store: State<'_, Store>) -> std::result::Result<Vec<StoredRun>, String> {
    store.list_runs(RESTORED_RUNS).map_err(|e| e.to_string())
}

fn agent_key(agent: AgentKind) -> Result<String> {
    serde_json::to_value(agent)
        .map_err(|e| Error::ToSqlConversionFailure(Box::new(e)))?
        .as_str().map(str::to_owned).ok_or(Error::InvalidQuery)
}

fn write_worktree(conn: &Connection, run_id: &str, repo: &str, wt: &Worktree) -> Result<()> {
    if wt.run_id != run_id { return Err(Error::InvalidQuery); }
    let path = wt.path.to_str().ok_or(Error::InvalidQuery)?;
    let changed = conn.execute(
        "UPDATE runs SET repo = ?2, worktree = ?3, branch = ?4, base = ?5 WHERE id = ?1",
        params![run_id, repo, path, wt.branch, wt.base],
    )?;
    if changed == 0 { return Err(Error::QueryReturnedNoRows); }
    Ok(())
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
mod tests {
    use super::*;

    #[test]
    fn v1_migration_preserves_history() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE runs (id TEXT PRIMARY KEY, agent TEXT NOT NULL, prompt TEXT NOT NULL,
            cwd TEXT NOT NULL, status TEXT NOT NULL, exit_code INTEGER, started_at INTEGER NOT NULL,
            ended_at INTEGER, model TEXT, step TEXT, worktree TEXT, task_id TEXT);
            CREATE TABLE run_lines (id INTEGER PRIMARY KEY, run_id TEXT REFERENCES runs(id), kind TEXT, line TEXT, at INTEGER);
            CREATE TABLE usage_events (id INTEGER PRIMARY KEY, run_id TEXT REFERENCES runs(id), at INTEGER,
            input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, cumulative INTEGER, source TEXT, raw TEXT);
            INSERT INTO runs (id, agent, prompt, cwd, status, started_at) VALUES ('old', 'codex', 'original', '/repo', 'done', 1);
            INSERT INTO run_lines VALUES (1, 'old', 'log', 'saved', 2);
            INSERT INTO usage_events VALUES (1, 'old', 3, 10, 2, 3, NULL, 0, 'tokens', NULL);
            PRAGMA user_version = 1;").unwrap();
        let store = Store::initialize(conn).unwrap();
        let run = store.list_runs(1).unwrap().remove(0);
        assert_eq!(run.prompt, "original");
        assert_eq!(run.lines[0].line, "saved");
        assert_eq!(run.usage, Some(usage(10, 2, 3)));
        store.add_rule("/repo", AgentKind::Codex, "read:*").unwrap();
        assert!(store.run_worktree("old").is_err());
        assert!(store.all_limits().unwrap().is_empty());
    }

    #[test]
    fn limits_keep_the_newest_report_per_agent() {
        let store = Store::open_in_memory().unwrap();
        let window = |u: f64| vec![LimitWindow { id: "five_hour".into(), utilization: u, resets_at: Some(9), status: Some("allowed".into()) }];
        store.set_limits(AgentKind::Claude, &window(0.2), 10).unwrap();
        store.set_limits(AgentKind::Claude, &window(0.5), 20).unwrap();
        store.set_limits(AgentKind::Claude, &window(0.1), 15).unwrap();
        assert_eq!(store.all_limits().unwrap(), vec![AccountLimits { agent: AgentKind::Claude, windows: window(0.5), at: 20 }]);
    }

    #[test]
    fn reopen_keeps_scoped_rules_and_worktree() {
        let dir = std::env::temp_dir().join(format!("tg-store-{}", uuid::Uuid::new_v4()));
        let path = dir.join("history.db");
        let wt = crate::worktree::Worktree { run_id: "a".into(), path: dir.join("work tree ✓"), branch: "tg/codex/task".into(), base: "abc123".into() };
        {
            let store = Store::open(&path).unwrap();
            insert(&store, "a", 1);
            store.set_run_worktree("a", "/repo", &wt).unwrap();
            store.add_rule("/repo", AgentKind::Codex, "read:*").unwrap();
            store.add_rule("/repo", AgentKind::Codex, "read:*").unwrap();
            store.add_rule("/repo", AgentKind::Claude, "write:*").unwrap();
            store.add_rule("/other", AgentKind::Codex, "shell:*").unwrap();
            assert!(store.set_run_worktree("missing", "/repo", &Worktree { run_id: "missing".into(), ..wt.clone() }).is_err());
            assert!(store.set_run_worktree("a", "/changed", &Worktree { run_id: "wrong".into(), ..wt.clone() }).is_err());
        }
        {
            let store = Store::open(&path).unwrap();
            assert_eq!(store.run_worktree("a").unwrap(), (std::path::PathBuf::from("/repo"), wt));
            assert_eq!(store.rules_for("/repo", AgentKind::Codex).unwrap(), vec!["read:*"]);
            assert!(store.rules_for("/missing", AgentKind::Codex).unwrap().is_empty());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn insert_with_worktree_is_atomic_and_checks_identity() {
        let store = Store::open_in_memory().unwrap();
        let run = NewRun { id: "a", agent: AgentKind::Codex, prompt: "task", cwd: "/wt", started_at: 1 };
        let mut wt = crate::worktree::Worktree { run_id: "wrong".into(), path: "/wt".into(), branch: "branch".into(), base: "base".into() };
        assert!(store.insert_run_with_worktree(&run, "/repo", &wt, None).is_err());
        assert!(store.list_runs(1).unwrap().is_empty());
        wt.run_id = "a".into();
        store.insert_run_with_worktree(&run, "/repo", &wt, Some("group-1")).unwrap();
        assert_eq!(store.run_worktree("a").unwrap().1, wt);
        assert_eq!(store.list_runs(1).unwrap()[0].group.as_deref(), Some("group-1"));
        assert!(store.insert_run_with_worktree(&run, "/changed", &wt, None).is_err());
        assert_eq!(store.run_worktree("a").unwrap().0, std::path::PathBuf::from("/repo"));
    }

    fn insert(store: &Store, id: &str, started_at: u64) {
        store.insert_run(&NewRun { id, agent: AgentKind::Codex, prompt: "Giải thích ✓", cwd: "/tmp/thư mục có dấu cách", started_at }).unwrap();
    }

    fn usage(input: u64, cached: u64, output: u64) -> Usage {
        Usage { input_tokens: input, cached_input_tokens: cached, output_tokens: output, source: "tokens", ..Default::default() }
    }

    #[test]
    fn schema_and_foreign_keys_are_initialized() {
        let store = Store::open_in_memory().unwrap();
        {
            let conn = store.connection().unwrap();
            let version: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
            let foreign_keys: bool = conn.pragma_query_value(None, "foreign_keys", |r| r.get(0)).unwrap();
            assert_eq!(version, 3);
            assert!(foreign_keys);
            conn.prepare("SELECT model, step, worktree, task_id FROM runs").unwrap();
            conn.prepare("SELECT raw FROM usage_events").unwrap();
        }
        assert!(store.append_line("missing", "log", "orphan", 1).is_err());
        assert!(store.add_usage("missing", 1, &usage(1, 0, 0)).is_err());
    }

    #[test]
    fn usage_replays_by_time_then_id_and_normalizes_source() {
        let store = Store::open_in_memory().unwrap();
        insert(&store, "a", 1);
        store.add_usage("a", 3, &Usage { source: "unknown", ..usage(5, 0, 0) }).unwrap();
        store.add_usage("a", 2, &Usage { cumulative: true, ..usage(10, 0, 0) }).unwrap();
        store.add_usage("a", 3, &usage(2, 0, 0)).unwrap();
        assert_eq!(store.list_runs(1).unwrap()[0].usage, Some(usage(17, 0, 0)));
    }

    #[test]
    fn out_of_range_integers_return_errors_without_writing() {
        let store = Store::open_in_memory().unwrap();
        insert(&store, "a", 1);
        assert!(store.append_line("a", "log", "invalid", u64::MAX).is_err());
        assert!(store.add_usage("a", 2, &usage(u64::MAX, 0, 0)).is_err());
        let run = store.list_runs(1).unwrap().remove(0);
        assert!(run.lines.is_empty());
        assert_eq!(run.usage, None);
    }

    #[test]
    fn reopen_keeps_runs() {
        let dir = std::env::temp_dir().join(format!("tg-store-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested/history.db");
        let expected = {
            let store = Store::open(&path).unwrap();
            let mode: String = store.connection().unwrap()
                .pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
            assert_eq!(mode, "wal");
            insert(&store, "a", 123);
            store.append_line("a", "log", "hello", 124).unwrap();
            store.add_usage("a", 125, &usage(10, 1, 2)).unwrap();
            store.finish_run("a", "done", Some(0), 126).unwrap();
            store.list_runs(10).unwrap()
        };
        {
            let store = Store::open(&path).unwrap();
            assert_eq!(store.list_runs(10).unwrap(), expected);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn usage_replays_cumulative_and_incremental() {
        let store = Store::open_in_memory().unwrap();
        insert(&store, "a", 1);
        store.add_usage("a", 2, &usage(10, 1, 2)).unwrap();
        store.add_usage("a", 3, &usage(5, 1, 1)).unwrap();
        assert_eq!(store.list_runs(1).unwrap()[0].usage, Some(usage(15, 2, 3)));
        let total = Usage { cumulative: true, cost_usd: Some(0.5), source: "reported", ..usage(100, 0, 9) };
        store.add_usage("a", 4, &total).unwrap();
        assert_eq!(store.list_runs(1).unwrap()[0].usage, Some(total));
        store.add_usage("a", 5, &usage(1, 2, 3)).unwrap();
        assert_eq!(store.list_runs(1).unwrap()[0].usage, Some(Usage { cost_usd: Some(0.5), ..usage(101, 2, 12) }));
    }

    #[test]
    fn incremental_cost_stays_none() {
        let store = Store::open_in_memory().unwrap();
        insert(&store, "a", 1);
        store.add_usage("a", 2, &usage(10, 1, 2)).unwrap();
        store.add_usage("a", 3, &usage(5, 1, 1)).unwrap();
        let u = store.list_runs(1).unwrap().remove(0).usage.unwrap();
        assert_eq!(u.cost_usd, None);
        assert_eq!(u.source, "tokens");
    }

    #[test]
    fn lines_after_finish_are_kept() {
        let store = Store::open_in_memory().unwrap();
        insert(&store, "a", 1);
        store.finish_run("a", "done", Some(0), 2).unwrap();
        store.append_line("a", "stderr", "late", 3).unwrap();
        store.add_usage("a", 4, &usage(10, 1, 2)).unwrap();
        let run = store.list_runs(1).unwrap().remove(0);
        assert_eq!(run.status, "done");
        assert_eq!(run.exit_code, Some(0));
        assert_eq!(run.ended_at, Some(2));
        assert_eq!(run.lines, vec![StoredLine { kind: "stderr".into(), line: "late".into() }]);
        assert_eq!(run.usage, Some(usage(10, 1, 2)));
    }

    #[test]
    fn only_last_2000_lines_in_order() {
        let store = Store::open_in_memory().unwrap();
        insert(&store, "a", 1);
        for i in 0..2005 {
            store.append_line("a", "log", &format!("line-{i}"), 2).unwrap();
        }
        let run = store.list_runs(1).unwrap().remove(0);
        let expected: Vec<_> = (5..2005).map(|i| StoredLine { kind: "log".into(), line: format!("line-{i}") }).collect();
        assert_eq!(run.lines, expected);
    }

    #[test]
    fn mark_interrupted_only_touches_running() {
        let store = Store::open_in_memory().unwrap();
        insert(&store, "done", 1);
        store.finish_run("done", "done", Some(0), 2).unwrap();
        let done = store.list_runs(1).unwrap().remove(0);
        insert(&store, "running", 3);
        assert_eq!(store.mark_interrupted().unwrap(), 1);
        let runs = store.list_runs(10).unwrap();
        assert_eq!(runs[0].status, "interrupted");
        assert_eq!(runs[1], done);
        assert_eq!(store.mark_interrupted().unwrap(), 0);
    }

    #[test]
    fn list_is_newest_first_and_limited() {
        let store = Store::open_in_memory().unwrap();
        insert(&store, "middle", 20);
        insert(&store, "newest", 30);
        insert(&store, "oldest", 10);
        let runs = store.list_runs(2).unwrap();
        assert_eq!(runs.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["newest", "middle"]);
        assert!(store.list_runs(0).unwrap().is_empty());
    }

    #[test]
    fn unicode_round_trip() {
        let store = Store::open_in_memory().unwrap();
        insert(&store, "a", 1);
        let run = store.list_runs(1).unwrap().remove(0);
        assert_eq!(run.prompt, "Giải thích ✓");
        assert_eq!(run.cwd, "/tmp/thư mục có dấu cách");
        assert_eq!(run.agent, AgentKind::Codex);
        assert_eq!(run.status, "running");
        assert_eq!(run.ended_at, None);
        assert_eq!(run.exit_code, None);
        assert_eq!(run.usage, None);
    }
}
