//! Run history: runs, their lines and usage, conversations, sessions, soft deletion.

use super::*;

impl Store {
    pub fn insert_run(&self, run: &NewRun<'_>) -> Result<()> {
        let agent = serde_json::to_value(run.agent)
            .map_err(|e| Error::ToSqlConversionFailure(Box::new(e)))?;
        self.connection()?.execute(
            "INSERT INTO runs (id, agent, prompt, cwd, started_at, status) VALUES (?1, ?2, ?3, ?4, ?5, 'running')",
            params![run.id, agent.as_str(), run.prompt, run.cwd, sql_integer(run.started_at)?],
        )?;
        Ok(())
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
        let conn = self.connection()?;
        // A session waiting for the next message had finished its work.
        conn.execute("UPDATE runs SET status = 'done', exit_code = 0,
            ended_at = COALESCE((SELECT MAX(at) FROM run_lines WHERE run_id = runs.id), started_at) WHERE status = 'idle'", [])?;
        conn.execute("UPDATE runs SET status = 'interrupted' WHERE status = 'running'", [])
    }

    /// 'running' or 'idle' while the agent's session stays open.
    pub fn set_run_status(&self, run_id: &str, status: &str) -> Result<()> {
        self.connection()?.execute("UPDATE runs SET status = ?2 WHERE id = ?1", params![run_id, status])?;
        Ok(())
    }

    pub fn set_run_thread(&self, run_id: &str, thread: &str, scope: Option<&str>) -> Result<()> {
        self.connection()?.execute("UPDATE runs SET thread_id = ?2, scope = ?3 WHERE id = ?1", params![run_id, thread, scope])?;
        Ok(())
    }

    /// A run shown nested in `parent`: an agent's own subagent. It joins the parent's
    /// conversation and folder.
    pub fn insert_child_run(&self, id: &str, parent: &str, agent: AgentKind, prompt: &str, started_at: u64) -> Result<()> {
        let agent = agent_key(agent)?;
        self.connection()?.execute(
            "INSERT OR IGNORE INTO runs (id, agent, prompt, cwd, started_at, status, thread_id, scope, repo, parent_run_id)
             SELECT ?1, ?2, ?3, cwd, ?4, 'running', thread_id, scope, repo, id FROM runs WHERE id = ?5",
            params![id, agent, prompt, sql_integer(started_at)?, parent],
        )?;
        Ok(())
    }

    pub fn set_run_parent(&self, run_id: &str, parent: &str) -> Result<()> {
        self.connection()?.execute("UPDATE runs SET parent_run_id = ?2 WHERE id = ?1", params![run_id, parent])?;
        Ok(())
    }

    pub fn set_acp_session(&self, run_id: &str, session: &str) -> Result<()> {
        self.connection()?.execute("UPDATE runs SET acp_session = ?2 WHERE id = ?1", params![run_id, session])?;
        Ok(())
    }

    /// The agent and ACP session of a run, and the cost it last reported.
    pub fn session_of(&self, run_id: &str) -> Result<(String, Option<String>, Option<f64>)> {
        self.connection()?.query_row(
            "SELECT agent, acp_session, (SELECT cost_usd FROM usage_events WHERE run_id = runs.id AND cost_usd IS NOT NULL ORDER BY id DESC LIMIT 1)
             FROM runs WHERE id = ?1", [run_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
    }

    /// Hide history and forget drafts without changing the usage ledger.
    pub fn delete_runs(&self, ids: &[String], at: u64) -> Result<()> {
        let at = sql_integer(at)?;
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        for id in ids {
            tx.execute("UPDATE runs SET deleted_at = ?2, worktree = NULL, branch = NULL,
                base = NULL, worktree_owner = NULL WHERE id = ?1", params![id, at])?;
            tx.execute("DELETE FROM run_lines WHERE run_id = ?1", [id])?;
        }
        tx.commit()
    }

    pub fn list_runs(&self, limit: usize) -> Result<Vec<StoredRun>> {
        let mut conn = self.connection()?;
        // Read the run and its events from a single snapshot, including across connections.
        let tx = conn.transaction()?;
        let mut runs = {
            let mut stmt = tx.prepare(
                "SELECT id, agent, prompt, cwd, started_at, ended_at, status, exit_code, worktree, task_id, thread_id, COALESCE(repo, cwd), scope, parent_run_id
                 FROM runs WHERE deleted_at IS NULL ORDER BY started_at DESC, id DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
                let agent: String = row.get(1)?;
                let agent = serde_json::from_value(serde_json::Value::String(agent))
                    .map_err(|e| Error::FromSqlConversionFailure(1, Type::Text, Box::new(e)))?;
                Ok(StoredRun {
                    id: row.get(0)?, agent, prompt: row.get(2)?, cwd: row.get(3)?,
                    started_at: unsigned(row.get(4)?, 4)?, ended_at: row.get::<_, Option<i64>>(5)?.map(|n| unsigned(n, 5)).transpose()?, status: row.get(6)?,
                    exit_code: row.get(7)?, usage: None, lines: Vec::new(), worktree: row.get(8)?, group: row.get(9)?, thread: row.get(10)?, project: row.get(11)?, scope: row.get(12)?, parent: row.get(13)?,
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
                let usage = events.query_map([&run.id], usage_from_row)?;
                run.usage = replay(usage)?;
            }
        }
        tx.commit()?;
        Ok(runs)
    }
}
