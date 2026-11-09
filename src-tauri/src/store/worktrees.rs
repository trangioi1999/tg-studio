//! Where each run works. Pipeline steps share their owner's worktree; direct runs all use the repo's path but each has its own baseline.

use super::*;

/// Rows whose worktree belongs to the same owner run as `?1`.
const SAME_OWNER: &str = "COALESCE(worktree_owner, id) = (SELECT COALESCE(worktree_owner, id) FROM runs WHERE id = ?1)";

impl Store {
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
        if wt.run_id == run.id {
            write_worktree(&tx, run.id, repo, wt)?;
        } else {
            // A shared worktree must still belong to its owner run in the same repo.
            let path = wt.path.to_str().ok_or(Error::InvalidQuery)?;
            let owned: i64 = tx.query_row("SELECT COUNT(*) FROM runs WHERE id = ?1 AND repo = ?2 AND worktree = ?3",
                params![wt.run_id, repo, path], |r| r.get(0))?;
            if owned != 1 { return Err(Error::QueryReturnedNoRows); }
            tx.execute("UPDATE runs SET repo = ?2, worktree = ?3, branch = ?4, base = ?5, worktree_owner = ?6 WHERE id = ?1",
                params![run.id, repo, path, wt.branch, wt.base, wt.run_id])?;
        }
        tx.commit()
    }

    /// Every run (this one included) that works in the same worktree as `run_id`: the owner
    /// and the later steps that reused it. Not by path: every direct run's path is the repo.
    pub fn runs_sharing_worktree(&self, run_id: &str) -> Result<Vec<String>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare(&format!("SELECT id FROM runs WHERE worktree IS NOT NULL AND {SAME_OWNER}"))?;
        let rows = stmt.query_map([run_id], |r| r.get(0))?;
        rows.collect()
    }

    /// Forgets the worktree for this run and every run that shared it.
    pub fn clear_run_worktree(&self, run_id: &str) -> Result<()> {
        self.connection()?.execute(
            &format!("UPDATE runs SET worktree = NULL, branch = NULL, base = NULL, worktree_owner = NULL
             WHERE worktree IS NOT NULL AND {SAME_OWNER}"),
            params![run_id],
        )?;
        Ok(())
    }

    /// Every direct run (the agent worked in the user's folder) of this repository, once each.
    pub fn direct_worktrees(&self, repo: &str) -> Result<Vec<Worktree>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT COALESCE(worktree_owner, id), worktree, base FROM runs
             WHERE repo = ?1 AND branch = '' AND worktree IS NOT NULL AND base IS NOT NULL")?;
        let rows = stmt.query_map([repo], |row| Ok(Worktree {
            run_id: row.get(0)?, path: PathBuf::from(row.get::<_, String>(1)?), branch: String::new(), base: row.get(2)?,
        }))?;
        rows.collect()
    }

    pub fn run_worktree(&self, run_id: &str) -> Result<(PathBuf, Worktree)> {
        self.connection()?.query_row(
            "SELECT repo, worktree, branch, base, COALESCE(worktree_owner, id) FROM runs WHERE id = ?1 AND repo IS NOT NULL
                AND worktree IS NOT NULL AND branch IS NOT NULL AND base IS NOT NULL",
            [run_id], |row| Ok((PathBuf::from(row.get::<_, String>(0)?), Worktree {
                run_id: row.get(4)?, path: PathBuf::from(row.get::<_, String>(1)?),
                branch: row.get(2)?, base: row.get(3)?,
            })),
        )
    }
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
