//! Notes shared by agents, MCP servers, settings and saved approval rules.

use super::*;

impl Store {
    /// A tg-bridge note shared by every run of one task (`scope`).
    pub fn add_note(&self, scope: &str, topic: &str, text: &str, run_id: &str, agent: AgentKind, at: u64) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO bridge_notes (scope, topic, text, run_id, agent, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![scope, topic, text, run_id, agent_key(agent)?, sql_integer(at)?],
        )?;
        Ok(())
    }

    /// The note scope a run writes to: its parallel group, else its worktree's owner run.
    pub fn run_scope(&self, run_id: &str) -> Result<String> {
        self.connection()?.query_row("SELECT COALESCE(task_id, worktree_owner, id) FROM runs WHERE id = ?1", [run_id], |r| r.get(0))
    }

    /// (topic, agent, at, text), oldest first; the last 50.
    pub fn notes(&self, scope: &str, topic: Option<&str>) -> Result<Vec<(String, String, u64, String)>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare("SELECT topic, agent, at, text FROM (SELECT * FROM bridge_notes WHERE scope = ?1 AND (?2 IS NULL OR topic = ?2)
            ORDER BY id DESC LIMIT 50) ORDER BY id ASC")?;
        let rows = stmt.query_map(params![scope, topic], |r| Ok((r.get(0)?, r.get(1)?, unsigned(r.get(2)?, 2)?, r.get(3)?)))?;
        rows.collect()
    }

    pub fn mcp_servers(&self) -> Result<Vec<String>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare("SELECT config FROM mcp_servers ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect()
    }

    pub fn save_mcp_server(&self, id: &str, config: &str) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO mcp_servers (id, config) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET config = excluded.config",
            params![id, config],
        )?;
        Ok(())
    }

    pub fn delete_mcp_server(&self, id: &str) -> Result<()> {
        self.connection()?.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query([key])?;
        rows.next()?.map(|r| r.get(0)).transpose()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
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
}
