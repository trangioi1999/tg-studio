//! Creating the database and moving it to the newest schema.

use super::*;

impl Store {
    pub(super) fn initialize(mut conn: Connection) -> Result<Store> {
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
            1..=11 => {},
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
        if version < 4 {
            // Pipeline steps after the first reuse the first step's worktree.
            tx.execute_batch("ALTER TABLE runs ADD COLUMN worktree_owner TEXT;
                PRAGMA user_version = 4;")?;
        }
        if version < 5 {
            tx.execute_batch("
                CREATE TABLE prices (
                    agent TEXT NOT NULL, from_ms INTEGER NOT NULL,
                    input REAL, cached_input REAL, output REAL,
                    PRIMARY KEY (agent, from_ms)
                );
                CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, config TEXT NOT NULL);
                CREATE INDEX runs_started_at ON runs(started_at);
                PRAGMA user_version = 5;")?;
        }
        if version < 6 {
            tx.execute_batch("
                CREATE TABLE bridge_notes (
                    id INTEGER PRIMARY KEY, scope TEXT NOT NULL, topic TEXT NOT NULL, text TEXT NOT NULL,
                    run_id TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL
                );
                CREATE INDEX bridge_notes_scope ON bridge_notes(scope, id);
                PRAGMA user_version = 6;")?;
        }
        if version < 7 {
            tx.execute_batch("ALTER TABLE runs ADD COLUMN acp_session TEXT;
                PRAGMA user_version = 7;")?;
        }
        if version < 8 {
            tx.execute_batch("ALTER TABLE runs ADD COLUMN thread_id TEXT;
                PRAGMA user_version = 8;")?;
        }
        if version < 9 {
            tx.execute_batch("ALTER TABLE runs ADD COLUMN scope TEXT;
                PRAGMA user_version = 9;")?;
        }
        if version < 10 {
            tx.execute_batch("ALTER TABLE runs ADD COLUMN deleted_at INTEGER;
                PRAGMA user_version = 10;")?;
        }
        if version < 11 {
            tx.execute_batch("ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
                PRAGMA user_version = 11;")?;
        }
        tx.commit()?;
        Ok(Store(Mutex::new(conn)))
    }
}
