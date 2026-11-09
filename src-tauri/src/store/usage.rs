//! Plan limits, the usage ledger and the price history.

use super::*;

impl Store {
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

    /// Runs started at or after `since` (epoch ms), newest first, with their final usage.
    pub fn usage_rows(&self, since: u64) -> Result<Vec<UsageRow>> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let mut rows = {
            let mut stmt = tx.prepare("SELECT id, agent, prompt, started_at, ended_at, status, task_id FROM runs
                WHERE started_at >= ?1 ORDER BY started_at DESC, id DESC")?;
            let mapped = stmt.query_map([sql_integer(since)?], |row| {
                let agent: String = row.get(1)?;
                let agent = serde_json::from_value(serde_json::Value::String(agent))
                    .map_err(|e| Error::FromSqlConversionFailure(1, Type::Text, Box::new(e)))?;
                Ok(UsageRow {
                    id: row.get(0)?, agent, prompt: row.get(2)?, started_at: unsigned(row.get(3)?, 3)?,
                    ended_at: row.get::<_, Option<i64>>(4)?.map(|n| unsigned(n, 4)).transpose()?,
                    status: row.get(5)?, group: row.get(6)?, usage: None,
                })
            })?;
            mapped.collect::<Result<Vec<_>>>()?
        };
        {
            let mut events = tx.prepare("SELECT input_tokens, cached_input_tokens, output_tokens, cost_usd, source, cumulative
                FROM usage_events WHERE run_id = ?1 ORDER BY at ASC, id ASC")?;
            for row in &mut rows {
                row.usage = replay(events.query_map([&row.id], usage_from_row)?)?;
            }
        }
        tx.commit()?;
        Ok(rows)
    }

    pub fn prices(&self) -> Result<Vec<PriceRow>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare("SELECT agent, from_ms, input, cached_input, output FROM prices ORDER BY agent, from_ms")?;
        let rows = stmt.query_map([], |row| {
            let agent: String = row.get(0)?;
            let agent = serde_json::from_value(serde_json::Value::String(agent))
                .map_err(|e| Error::FromSqlConversionFailure(0, Type::Text, Box::new(e)))?;
            Ok(PriceRow { agent, from_ms: unsigned(row.get(1)?, 1)?, input: row.get(2)?, cached_input: row.get(3)?, output: row.get(4)? })
        })?;
        rows.collect()
    }

    /// A new price from `from_ms` on. Older runs keep the price they started under.
    pub fn add_price(&self, price: &PriceRow) -> Result<()> {
        let valid = |v: Option<f64>| v.is_none_or(|v| v.is_finite() && v >= 0.0);
        if ![price.input, price.cached_input, price.output].into_iter().all(valid) { return Err(Error::InvalidQuery); }
        self.connection()?.execute(
            "INSERT OR REPLACE INTO prices (agent, from_ms, input, cached_input, output) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![agent_key(price.agent)?, sql_integer(price.from_ms)?, price.input, price.cached_input, price.output],
        )?;
        Ok(())
    }
}
