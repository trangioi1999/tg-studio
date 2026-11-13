use super::*;

#[test]
fn deletion_keeps_usage_but_removes_history_and_worktree() {
    let store = Store::open_in_memory().unwrap();
    insert(&store, "a", 1);
    insert(&store, "b", 2);
    store.append_line("a", "log", "secret", 3).unwrap();
    store.append_line("b", "log", "keep", 3).unwrap();
    store.set_run_worktree("a", "/repo", &Worktree { run_id: "a".into(), path: "/wt".into(), branch: "branch".into(), base: "base".into() }).unwrap();
    store.add_usage("a", 3, &Usage { cost_usd: Some(0.5), ..usage(10, 2, 3) }).unwrap();
    let before = store.usage_rows(0).unwrap();
    store.delete_runs(&["a".into()], 4).unwrap();
    assert_eq!(store.usage_rows(0).unwrap(), before);
    let runs = store.list_runs(10).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].id, "b");
    assert_eq!(runs[0].lines[0].line, "keep");
    let conn = store.connection().unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM run_lines WHERE run_id = 'a'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM runs WHERE id = 'a' AND deleted_at = 4 AND worktree IS NULL AND branch IS NULL AND base IS NULL AND worktree_owner IS NULL", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn deletion_rolls_back_the_whole_batch_on_failure() {
    let store = Store::open_in_memory().unwrap();
    for id in ["a", "b"] {
        insert(&store, id, 1);
        store.append_line(id, "log", "saved", 2).unwrap();
    }
    let before = store.list_runs(10).unwrap();
    store.connection().unwrap().execute_batch("CREATE TRIGGER reject_delete BEFORE DELETE ON run_lines
        WHEN OLD.run_id = 'b' BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
    assert!(store.delete_runs(&["a".into(), "b".into()], 3).is_err());
    assert_eq!(store.list_runs(10).unwrap(), before);
}

#[test]
fn v7_and_v9_migration_preserve_existing_data() {
    for version in [7, 9] {
        let store = Store::open_in_memory().unwrap();
        insert(&store, "old", 1);
        store.append_line("old", "log", "saved", 2).unwrap();
        store.add_usage("old", 3, &usage(10, 2, 3)).unwrap();
        let before = store.list_runs(10).unwrap();
        let conn = store.0.into_inner().unwrap();
        conn.execute_batch("ALTER TABLE runs DROP COLUMN parent_run_id; ALTER TABLE runs DROP COLUMN deleted_at;").unwrap();
        if version == 7 {
            conn.execute_batch("ALTER TABLE runs DROP COLUMN thread_id; ALTER TABLE runs DROP COLUMN scope;").unwrap();
        }
        conn.pragma_update(None, "user_version", version).unwrap();
        let migrated = Store::initialize(conn).unwrap();
        assert_eq!(migrated.list_runs(10).unwrap(), before);
        assert_eq!(migrated.usage_rows(0).unwrap()[0].usage, Some(usage(10, 2, 3)));
        migrated.delete_runs(&["old".into()], 4).unwrap();
        assert!(migrated.list_runs(10).unwrap().is_empty());
    }
}

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
fn later_runs_can_share_a_worktree_and_clearing_any_clears_all() {
    let store = Store::open_in_memory().unwrap();
    let wt = crate::workspace::worktree::Worktree { run_id: "a".into(), path: "/wt/a".into(), branch: "b".into(), base: "c".into() };
    store.insert_run_with_worktree(&NewRun { id: "a", agent: AgentKind::Claude, prompt: "plan", cwd: "/wt/a", started_at: 1 }, "/repo", &wt, None).unwrap();
    store.insert_run_with_worktree(&NewRun { id: "b", agent: AgentKind::Codex, prompt: "build", cwd: "/wt/a", started_at: 2 }, "/repo", &wt, None).unwrap();
    // The second run resolves to the owner's worktree, so removal finds it.
    assert_eq!(store.run_worktree("b").unwrap(), (PathBuf::from("/repo"), wt.clone()));
    // Sharing needs the owner in the same repo.
    assert!(store.insert_run_with_worktree(&NewRun { id: "x", agent: AgentKind::Codex, prompt: "p", cwd: "/", started_at: 3 }, "/other", &wt, None).is_err());
    let mut sharing = store.runs_sharing_worktree("b").unwrap();
    sharing.sort();
    assert_eq!(sharing, vec!["a", "b"]);
    store.clear_run_worktree("b").unwrap();
    assert!(store.run_worktree("a").is_err());
    assert!(store.run_worktree("b").is_err());
}

#[test]
fn direct_runs_in_one_repo_do_not_share_their_worktree() {
    // Direct runs all have the repository as their path, but each has its own baseline.
    let store = Store::open_in_memory().unwrap();
    let direct = |id: &str| crate::workspace::worktree::Worktree { run_id: id.into(), path: "/repo".into(), branch: String::new(), base: format!("tree-{id}") };
    for (id, at) in [("parent", 1), ("child", 2), ("other", 3)] {
        store.insert_run_with_worktree(&NewRun { id, agent: AgentKind::Claude, prompt: "p", cwd: "/repo", started_at: at }, "/repo", &direct(id), None).unwrap();
    }
    assert_eq!(store.runs_sharing_worktree("child").unwrap(), vec!["child"]);
    store.clear_run_worktree("child").unwrap();
    assert!(store.run_worktree("child").is_err());
    assert_eq!(store.run_worktree("parent").unwrap().1, direct("parent"));
    assert_eq!(store.run_worktree("other").unwrap().1, direct("other"));
}

#[test]
fn a_child_run_joins_its_parents_conversation() {
    let store = Store::open_in_memory().unwrap();
    insert(&store, "p", 1);
    store.set_run_thread("p", "t", Some("src")).unwrap();
    store.insert_child_run("p~1", "p", AgentKind::Claude, "Tìm tệp cấu hình", 2).unwrap();
    store.append_line("p~1", "message", "Đã tìm thấy", 3).unwrap();
    let runs = store.list_runs(10).unwrap();
    let child = runs.iter().find(|r| r.id == "p~1").unwrap();
    assert_eq!((child.parent.as_deref(), child.thread.as_deref(), child.scope.as_deref()), (Some("p"), Some("t"), Some("src")));
    assert_eq!(child.prompt, "Tìm tệp cấu hình");
    assert_eq!(child.lines[0].line, "Đã tìm thấy");
}

#[test]
fn direct_worktrees_lists_each_direct_run_of_the_repo_once() {
    let store = Store::open_in_memory().unwrap();
    let direct = |id: &str| crate::workspace::worktree::Worktree { run_id: id.into(), path: "/repo".into(), branch: String::new(), base: format!("tree-{id}") };
    let draft = crate::workspace::worktree::Worktree { run_id: "c".into(), path: "/wt/c".into(), branch: "tg/c".into(), base: "c".into() };
    let run = |id: &'static str| NewRun { id, agent: AgentKind::Claude, prompt: "p", cwd: "/repo", started_at: 1 };
    store.insert_run_with_worktree(&run("a"), "/repo", &direct("a"), None).unwrap();
    // A later run that reuses a's place resolves to a, so a is listed once.
    store.insert_run_with_worktree(&run("b"), "/repo", &direct("a"), None).unwrap();
    store.insert_run_with_worktree(&run("c"), "/repo", &draft, None).unwrap();
    store.insert_run_with_worktree(&run("d"), "/other", &direct("d"), None).unwrap();
    assert_eq!(store.direct_worktrees("/repo").unwrap(), vec![direct("a")]);
}

#[test]
fn usage_rows_since_with_final_usage_and_group() {
    let store = Store::open_in_memory().unwrap();
    insert(&store, "old", 10);
    insert(&store, "a", 100);
    insert(&store, "b", 200);
    store.add_usage("a", 101, &usage(5, 1, 2)).unwrap();
    store.add_usage("a", 102, &usage(5, 1, 2)).unwrap();
    store.add_usage("b", 201, &Usage { cumulative: true, cost_usd: Some(0.5), source: "reported", ..usage(9, 0, 1) }).unwrap();
    let rows = store.usage_rows(100).unwrap();
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["b", "a"]);
    assert_eq!(rows[1].usage, Some(usage(10, 2, 4)));
    assert_eq!(rows[0].usage.as_ref().unwrap().cost_usd, Some(0.5));
    assert!(rows.iter().all(|r| r.group.is_none()));
}

#[test]
fn prices_keep_history_and_reject_bad_numbers() {
    let store = Store::open_in_memory().unwrap();
    let p = |from_ms, input| PriceRow { agent: AgentKind::Codex, from_ms, input, cached_input: Some(0.1), output: Some(2.0) };
    store.add_price(&p(10, Some(1.0))).unwrap();
    store.add_price(&p(20, Some(1.5))).unwrap();
    store.add_price(&p(30, None)).unwrap();
    assert_eq!(store.prices().unwrap(), vec![p(10, Some(1.0)), p(20, Some(1.5)), p(30, None)]);
    assert!(store.add_price(&p(40, Some(-1.0))).is_err());
    assert!(store.add_price(&p(40, Some(f64::NAN))).is_err());
}

#[test]
fn mcp_servers_keep_insertion_order_and_update_in_place() {
    let store = Store::open_in_memory().unwrap();
    store.save_mcp_server("b", "{\"n\":1}").unwrap();
    store.save_mcp_server("a", "{\"n\":2}").unwrap();
    store.save_mcp_server("b", "{\"n\":3}").unwrap();
    assert_eq!(store.mcp_servers().unwrap(), vec!["{\"n\":3}", "{\"n\":2}"]);
    store.delete_mcp_server("b").unwrap();
    assert_eq!(store.mcp_servers().unwrap().len(), 1);
}

#[test]
fn bridge_notes_are_scoped_and_filtered_by_topic() {
    let store = Store::open_in_memory().unwrap();
    store.add_note("task-a", "plan", "1. A", "r1", AgentKind::Claude, 1).unwrap();
    store.add_note("task-a", "style", "tabs", "r2", AgentKind::Codex, 2).unwrap();
    store.add_note("task-b", "plan", "other task", "r3", AgentKind::Codex, 3).unwrap();
    assert_eq!(store.notes("task-a", None).unwrap(), vec![("plan".into(), "claude".into(), 1, "1. A".into()), ("style".into(), "codex".into(), 2, "tabs".into())]);
    assert_eq!(store.notes("task-a", Some("style")).unwrap().len(), 1);
    assert!(store.notes("task-c", None).unwrap().is_empty());
    insert(&store, "solo", 1);
    assert_eq!(store.run_scope("solo").unwrap(), "solo");
    assert!(store.run_scope("missing").is_err());
}

#[test]
fn settings_round_trip() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.setting("budgets").unwrap(), None);
    store.set_setting("budgets", "{}").unwrap();
    store.set_setting("budgets", "{\"daily\":5}").unwrap();
    assert_eq!(store.setting("budgets").unwrap().as_deref(), Some("{\"daily\":5}"));
}

#[test]
fn limits_keep_the_newest_report_per_agent() {
    let store = Store::open_in_memory().unwrap();
    let window = |u: f64| vec![LimitWindow { id: "five_hour".into(), utilization: u, resets_at: Some(9), status: Some("allowed".into()), ..Default::default() }];
    store.set_limits(AgentKind::Claude, &window(0.2), 10).unwrap();
    store.set_limits(AgentKind::Claude, &window(0.5), 20).unwrap();
    store.set_limits(AgentKind::Claude, &window(0.1), 15).unwrap();
    assert_eq!(store.all_limits().unwrap(), vec![AccountLimits { agent: AgentKind::Claude, windows: window(0.5), at: 20 }]);
}

#[test]
fn reopen_keeps_scoped_rules_and_worktree() {
    let dir = std::env::temp_dir().join(format!("tg-store-{}", uuid::Uuid::new_v4()));
    let path = dir.join("history.db");
    let wt = crate::workspace::worktree::Worktree { run_id: "a".into(), path: dir.join("work tree ✓"), branch: "tg/codex/task".into(), base: "abc123".into() };
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
    let mut wt = crate::workspace::worktree::Worktree { run_id: "wrong".into(), path: "/wt".into(), branch: "branch".into(), base: "base".into() };
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
        assert_eq!(version, 11);
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
fn a_session_left_idle_counts_as_finished_on_the_next_start() {
    let store = Store::open_in_memory().unwrap();
    store.insert_run(&NewRun { id: "a", agent: AgentKind::Claude, prompt: "p", cwd: "/", started_at: 5 }).unwrap();
    store.append_line("a", "user", "câu hai", 9).unwrap();
    store.set_run_status("a", "idle").unwrap();
    store.insert_run(&NewRun { id: "b", agent: AgentKind::Claude, prompt: "p", cwd: "/", started_at: 6 }).unwrap();
    store.mark_interrupted().unwrap();
    let runs = store.list_runs(10).unwrap();
    let a = runs.iter().find(|r| r.id == "a").unwrap();
    assert_eq!((a.status.as_str(), a.ended_at), ("done", Some(9)));
    assert_eq!(runs.iter().find(|r| r.id == "b").unwrap().status, "interrupted");
}

#[test]
fn a_run_keeps_its_conversation_and_project() {
    let store = Store::open_in_memory().unwrap();
    store.insert_run(&NewRun { id: "a", agent: AgentKind::Claude, prompt: "p", cwd: "/thu-muc", started_at: 5 }).unwrap();
    assert_eq!(store.list_runs(1).unwrap()[0].thread, None);
    store.set_run_thread("a", "cuoc-1", Some("goi/api")).unwrap();
    let run = &store.list_runs(1).unwrap()[0];
    assert_eq!((run.thread.as_deref(), run.project.as_str(), run.scope.as_deref()), (Some("cuoc-1"), "/thu-muc", Some("goi/api")));
}

#[test]
fn session_of_returns_the_session_and_last_cost() {
    let store = Store::open_in_memory().unwrap();
    store.insert_run(&NewRun { id: "a", agent: AgentKind::Claude, prompt: "p", cwd: "/", started_at: 5 }).unwrap();
    assert_eq!(store.session_of("a").unwrap(), ("claude".to_string(), None, None));
    store.set_acp_session("a", "s1").unwrap();
    let mut spent = usage(1, 1, 1);
    spent.cost_usd = Some(0.2);
    store.add_usage("a", 6, &spent).unwrap();
    assert_eq!(store.session_of("a").unwrap(), ("claude".to_string(), Some("s1".to_string()), Some(0.2)));
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
