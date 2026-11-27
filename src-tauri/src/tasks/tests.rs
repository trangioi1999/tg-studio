//! Tests of the task lifecycle, run with the fake ACP agent (`acp/fake.rs`).

#[test] fn a_delegated_agent_works_where_its_parent_does() {
    use super::{place_for, Place};
    // The user's folder: the child works right there, no `.tg/` draft.
    let codex = AgentKind::Codex;
    assert_eq!(place_for(codex, Approval::Auto, None, None, Some(None)).unwrap(), Place::Direct);
    // A conversation in a draft: the child gets a draft from the parent's snapshot.
    assert_eq!(place_for(codex, Approval::Auto, None, None, Some(Some("abc".into()))).unwrap(), Place::Snapshot("abc".into()));
    assert_eq!(place_for(codex, Approval::Ask, Some("direct"), None, None).unwrap(), Place::Direct);
    assert_eq!(place_for(codex, Approval::Deny, Some("direct"), None, None).unwrap(), Place::Draft(None));
    assert_eq!(place_for(codex, Approval::Ask, Some("draft"), Some("dev".into()), None).unwrap(), Place::Draft(Some("dev".into())));
    assert!(place_for(codex, Approval::Ask, Some("x"), None, None).is_err());
}

/// Claude's questions run in the user's folder: `claude -p` blocks writing itself (`plan`
/// mode, and the app refuses every `can_use_tool`), so the session can later switch to
/// Hỏi trước in place. Agents without such a guarantee keep their throwaway draft.
#[test] fn claude_question_works_in_place() {
    use super::{place_for, Place};
    if std::env::var("TG_CLAUDE_ACP").as_deref() == Ok("1") { return; }
    assert!(super::uses_native(AgentKind::Claude));
    assert!(!super::uses_native(AgentKind::Codex));
    assert_eq!(place_for(AgentKind::Claude, Approval::Deny, Some("direct"), None, None).unwrap(), Place::Direct);
    assert_eq!(place_for(AgentKind::Claude, Approval::Deny, None, None, None).unwrap(), Place::Direct);
    assert_eq!(place_for(AgentKind::Gemini, Approval::Deny, Some("direct"), None, None).unwrap(), Place::Draft(None));
    assert_eq!(place_for(AgentKind::Codex, Approval::Deny, Some("direct"), None, None).unwrap(), Place::Draft(None));
}

use super::*;
use crate::workspace::worktree::tests::Repo;

fn save_draft(store: &Store, repo: &Repo, wt: &Worktree, id: &str) {
    store.insert_run_with_worktree(&NewRun { id, agent: AgentKind::Codex, prompt: "p", cwd: wt.path.to_str().unwrap(), started_at: 1 }, repo.0.to_str().unwrap(), wt, None).unwrap();
}

#[tokio::test]
async fn delete_draft_removes_branch_without_changing_repo() {
    let repo = Repo::new();
    let wt = repo.wt();
    let store = Store::open_in_memory().unwrap();
    save_draft(&store, &repo, &wt, &wt.run_id);
    let original = std::fs::read(repo.0.join("file.txt")).unwrap();
    let head = worktree::git(&repo.0, &["rev-parse", "HEAD"], None).unwrap();
    std::fs::write(wt.path.join("file.txt"), "draft").unwrap();
    delete_runs_inner(&store, &TaskRuns::default(), &Runs::default(), &[wt.run_id.clone(), wt.run_id.clone()]).await.unwrap();
    assert!(!wt.path.exists());
    assert!(worktree::git(&repo.0, &["show-ref", "--verify", &format!("refs/heads/{}", wt.branch)], None).is_err());
    assert_eq!(std::fs::read(repo.0.join("file.txt")).unwrap(), original);
    assert_eq!(worktree::git(&repo.0, &["rev-parse", "HEAD"], None).unwrap(), head);
    assert!(store.list_runs(10).unwrap().is_empty());
}

#[tokio::test]
async fn delete_direct_keeps_user_files_and_stops_read_only_session() {
    let repo = Repo::new();
    let wt = worktree::direct(&repo.0, "direct").unwrap();
    let store = Store::open_in_memory().unwrap();
    save_draft(&store, &repo, &wt, &wt.run_id);
    repo.write("file.txt", "user changes");
    repo.write("untracked.txt", "keep");
    let runs = Runs::default();
    let (tx, rx) = oneshot::channel();
    runs.0.lock().unwrap().insert(wt.run_id.clone(), tx);
    delete_runs_inner(&store, &TaskRuns::default(), &runs, &[wt.run_id.clone()]).await.unwrap();
    rx.await.unwrap();
    assert_eq!(std::fs::read_to_string(repo.0.join("file.txt")).unwrap(), "user changes");
    assert_eq!(std::fs::read_to_string(repo.0.join("untracked.txt")).unwrap(), "keep");
    for path in [worktree::direct_files(&wt).unwrap().0, worktree::direct_files(&wt).unwrap().1] { assert!(!path.exists()); }
}

#[test]
fn edits_wait_for_any_agent_writing_in_the_same_folder() {
    let repo = Repo::new();
    let tasks = TaskRuns::default();
    let writer = Arc::new(TaskSession::new("writer", AgentKind::Codex, &repo.0, Arc::new(Recorder::default()), Arc::new(Rules)).unwrap());
    tasks.0.lock().unwrap().insert("writer".into(), writer.clone());
    let quiet = |own: Option<(&str, &str)>, dir: &std::path::Path| tasks.quiet_in(own, &[(dir, Some("bận"))], || Ok(()));
    // An idle sibling direct run in the same repo: its edits wait while the writer works.
    writer.set_busy(true);
    assert!(quiet(Some(("idle-sibling", "bận")), &repo.0).is_err());
    // Another folder is not affected.
    let elsewhere = Repo::new();
    assert!(quiet(Some(("idle-sibling", "bận")), &elsewhere.0).is_ok());
    writer.set_busy(false);
    assert!(quiet(Some(("idle-sibling", "bận")), &repo.0).is_ok());
}

#[test]
fn an_agent_starts_writing_only_after_a_running_commit_in_its_folder() {
    // A commit holds the repo's lock; the agent's next turn waits for it, so the commit cannot
    // take half of what the agent then writes.
    let repo = Repo::new();
    let tasks = Arc::new(TaskRuns::default());
    let agent = Arc::new(TaskSession::new("agent", AgentKind::Codex, &repo.0, Arc::new(Recorder::default()), Arc::new(Rules)).unwrap());
    tasks.0.lock().unwrap().insert("agent".into(), agent.clone());
    let order = Arc::new(Mutex::new(Vec::new()));
    let (committing, started) = std::sync::mpsc::channel();
    let commit = {
        let (tasks, root, order) = (tasks.clone(), repo.0.clone(), order.clone());
        std::thread::spawn(move || tasks.quiet_in(None, &[(&root, Some("bận"))], || {
            committing.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            order.lock().unwrap().push("commit");
            Ok(())
        }))
    };
    started.recv().unwrap();
    assert!(start_turn(&agent), "the turn starts once the commit is done");
    order.lock().unwrap().push("turn");
    commit.join().unwrap().unwrap();
    assert_eq!(*order.lock().unwrap(), ["commit", "turn"]);
    // And a commit that comes after sees the agent at work.
    assert!(tasks.quiet_in(None, &[(&repo.0, Some("bận"))], || Ok(())).is_err());
}

#[test]
fn a_draft_agent_still_working_does_not_block_a_commit_in_the_repo() {
    // The draft was applied; its agent works on the next message in its draft, not in the repo.
    let repo = Repo::new();
    let draft = repo.wt();
    let tasks = TaskRuns::default();
    let agent = Arc::new(TaskSession::new(&draft.run_id, AgentKind::Codex, &draft.path, Arc::new(Recorder::default()), Arc::new(Rules)).unwrap());
    agent.set_busy(true);
    tasks.0.lock().unwrap().insert(draft.run_id.clone(), agent);
    assert!(tasks.quiet_in(None, &[(&draft.path, None), (&repo.0, Some("bận"))], || Ok(())).is_ok());
    // Keeping one of its hunks still waits for it.
    assert!(tasks.quiet_in(Some((&draft.run_id, "bận")), &[(&draft.path, Some("bận")), (&repo.0, Some("bận"))], || Ok(())).is_err());
}

#[tokio::test]
async fn delete_busy_batch_changes_nothing() {
    let repo = Repo::new();
    let wt = repo.wt();
    let store = Store::open_in_memory().unwrap();
    save_draft(&store, &repo, &wt, &wt.run_id);
    save_draft(&store, &repo, &wt, "busy");
    let tasks = TaskRuns::default();
    let session = Arc::new(TaskSession::new("busy", AgentKind::Codex, &wt.path, Arc::new(Recorder::default()), Arc::new(Rules)).unwrap());
    session.set_busy(true);
    tasks.0.lock().unwrap().insert("busy".into(), session);
    let runs = Runs::default();
    let (tx, mut rx) = oneshot::channel();
    runs.0.lock().unwrap().insert(wt.run_id.clone(), tx);
    let before = store.list_runs(10).unwrap();
    assert_eq!(delete_runs_inner(&store, &tasks, &runs, &[wt.run_id.clone(), "busy".into()]).await.unwrap_err(), "Hãy dừng agent trước khi xoá cuộc trò chuyện.");
    assert_eq!(store.list_runs(10).unwrap(), before);
    assert!(wt.path.exists());
    assert_eq!(rx.try_recv(), Err(oneshot::error::TryRecvError::Empty));
}

#[tokio::test]
async fn delete_waits_for_idle_acp_session_to_close() {
    let repo = Repo::new();
    let wt = repo.wt();
    let store = Store::open_in_memory().unwrap();
    save_draft(&store, &repo, &wt, &wt.run_id);
    let tasks = TaskRuns::default();
    let session = Arc::new(TaskSession::new(&wt.run_id, AgentKind::Codex, &wt.path, Arc::new(Recorder::default()), Arc::new(Rules)).unwrap());
    session.set_busy(false);
    tasks.0.lock().unwrap().insert(wt.run_id.clone(), session);
    let runs = Runs::default();
    let (tx, rx) = oneshot::channel();
    runs.0.lock().unwrap().insert(wt.run_id.clone(), tx);
    let ids = [wt.run_id.clone()];
    let close = async {
        rx.await.unwrap();
        assert!(wt.path.exists());
        assert_eq!(store.list_runs(10).unwrap().len(), 1);
        tasks.0.lock().unwrap().remove(&wt.run_id);
    };
    let (result, ()) = tokio::join!(delete_runs_inner(&store, &tasks, &runs, &ids), close);
    result.unwrap();
    assert!(!wt.path.exists());
}

#[tokio::test]
async fn delete_shared_draft_waits_until_last_run_is_deleted() {
    let repo = Repo::new();
    let wt = repo.wt();
    let store = Store::open_in_memory().unwrap();
    save_draft(&store, &repo, &wt, &wt.run_id);
    save_draft(&store, &repo, &wt, "other");
    delete_runs_inner(&store, &TaskRuns::default(), &Runs::default(), &[wt.run_id.clone()]).await.unwrap();
    assert!(wt.path.exists());
    assert_eq!(store.list_runs(10).unwrap()[0].id, "other");
    delete_runs_inner(&store, &TaskRuns::default(), &Runs::default(), &["other".into()]).await.unwrap();
    assert!(!wt.path.exists());
}

#[tokio::test]
async fn delete_cleanup_failure_still_hides_history() {
    let repo = Repo::new();
    let mut wt = repo.wt();
    wt.base = "invalid".into();
    let store = Store::open_in_memory().unwrap();
    save_draft(&store, &repo, &wt, &wt.run_id);
    let error = delete_runs_inner(&store, &TaskRuns::default(), &Runs::default(), &[wt.run_id.clone()]).await.unwrap_err();
    assert!(error.starts_with("Đã xoá cuộc trò chuyện, nhưng chưa dọn được bản nháp: "));
    assert!(store.list_runs(10).unwrap().is_empty());
    assert!(store.run_worktree(&wt.run_id).is_err());
}

#[derive(Default)]
struct Recorder(Mutex<Vec<AgentEvent>>);
impl EventSink for Recorder { fn emit(&self, event: AgentEvent) { self.0.lock().unwrap().push(event); } }
struct Rules;
impl RuleMemory for Rules {
    fn rules(&self) -> Result<Vec<String>, String> { Ok(vec![]) }
    fn add(&self, _: &str) -> Result<(), String> { Ok(()) }
}
async fn wait_permission(sink: &Recorder) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if sink.0.lock().unwrap().iter().any(|e| e.kind == "permission") { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
}
/// Runs a session, feeding `messages` one per finished turn, then closes it.
async fn session_with(client: &AcpClient, session: &TaskSession, resume: Option<String>, recap: Option<String>, messages: Vec<&'static str>, stop_each_turn: bool) -> (&'static str, Vec<&'static str>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let cwd = std::env::temp_dir();
    let plan = SessionPlan { cwd: &cwd, prompt: "đầu".into(), recap, servers: &[], resume, opened: None, next: Some(rx), idle_limit: Duration::from_millis(100), prefs: SessionPrefs::default(), compact: false };
    let stops = Mutex::new(Vec::new());
    let turns = Mutex::new(Vec::new());
    let remaining = Mutex::new(messages.into_iter());
    let next_stop = || {
        let (stop, rx) = oneshot::channel();
        let mut all = stops.lock().unwrap();
        if stop_each_turn && !all.is_empty() { let _ = stop.send(()); } else { all.push(stop); }
        rx
    };
    let on_turn = |end: &TurnEnd| {
        turns.lock().unwrap().push(end.status);
        // With nothing left to send, the session ends through its idle limit.
        if let Some(message) = remaining.lock().unwrap().next() { tx.send(message.to_string()).unwrap(); }
    };
    let (status, _) = tokio::time::timeout(Duration::from_secs(5), drive_session(client, session, plan, next_stop, |_| {}, on_turn, std::future::pending())).await.unwrap();
    (status, turns.into_inner().unwrap())
}

fn fixture(steps: Vec<crate::acp::fake::Step>, loadable: bool) -> (AcpClient, Arc<TaskSession>, crate::acp::fake::Log, Arc<Recorder>) {
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new("r", AgentKind::Claude, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
    let (reader, writer, log) = if loadable { crate::acp::fake::spawn_loadable(steps) } else { crate::acp::fake::spawn(steps) };
    (AcpClient::start(reader, writer, session.clone()), session, log, sink)
}

fn prompts(log: &crate::acp::fake::Log) -> Vec<String> {
    log.lock().unwrap().iter().filter(|v| v["method"] == "session/prompt").map(|v| v["params"]["prompt"][0]["text"].as_str().unwrap().to_string()).collect()
}

fn count(log: &crate::acp::fake::Log, method: &str) -> usize {
    log.lock().unwrap().iter().filter(|v| v["method"] == method).count()
}

/// Claude's `can_use_tool` requests reach the same `TaskSession::permission` as an adapter's
/// `session/request_permission`: cards, Chỉ hỏi and the forbidden list all hold.
#[tokio::test]
async fn claude_permission_routes_through_task_session() {
    use crate::acp::claude_conn::ClaudeConn;
    use crate::acp::fake_claude::{fake_claude, ClaudeStep};
    let behavior = |log: &crate::acp::fake_claude::Log| -> Vec<serde_json::Value> {
        log.lock().unwrap().iter().filter(|m| m["type"] == "control_response").map(|m| m["response"]["response"].clone()).collect()
    };
    for (approval, command, allowed) in [(Approval::Ask, "rm -rf build", true), (Approval::Deny, "rm -rf build", false), (Approval::Auto, "git push origin main", false)] {
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new("r", AgentKind::Claude, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
        session.set_approval(approval);
        let steps = vec![
            ClaudeStep::Ask { tool: "Bash", input: json!({ "command": command }) },
            ClaudeStep::Result { stop: "success", usage: json!({}), cost: 0.0 },
        ];
        let (reader, writer, log) = fake_claude(steps);
        let conn = ClaudeConn::start(reader, writer, session.clone());
        conn.initialize().await.unwrap();
        let id = conn.new_session(&std::env::temp_dir(), json!([])).await.unwrap();
        let turn = { let conn = conn.clone(); let id = id.clone(); tokio::spawn(async move { conn.prompt_turn(&id, "dọn").await }) };
        if approval == Approval::Ask {
            wait_permission(&sink).await;
            let card = sink.0.lock().unwrap().iter().find(|e| e.kind == "permission").unwrap().data.clone().unwrap();
            assert_eq!(card["toolCall"]["kind"], "execute");
            assert_eq!(card["toolCall"]["rawInput"]["command"], command);
            session.respond_permission(card["requestId"].as_str().unwrap(), "allow", false).unwrap();
        }
        tokio::time::timeout(Duration::from_secs(3), turn).await.unwrap().unwrap().unwrap();
        let answers = behavior(&log);
        assert_eq!(answers.len(), 1, "{approval:?}: {answers:?}");
        if allowed {
            assert_eq!(answers[0]["behavior"], "allow");
            assert_eq!(answers[0]["updatedInput"]["command"], command);
        } else {
            assert_eq!(answers[0]["behavior"], "deny", "{approval:?}");
            assert_eq!(answers[0]["message"], "Người dùng đã từ chối.");
            assert!(!sink.0.lock().unwrap().iter().any(|e| e.kind == "permission"), "{approval:?}: no card");
        }
        conn.close();
    }
}

/// `start_task` hooks the session's mode to the connection: Chỉ hỏi → Hỏi trước → Tự làm
/// on an open Claude session becomes `set_permission_mode` on the same process.
#[tokio::test]
async fn claude_session_follows_mode_changes() {
    use crate::acp::claude_conn::ClaudeConn;
    use crate::acp::fake_claude::fake_claude;
    let session = Arc::new(TaskSession::new("r", AgentKind::Claude, &std::env::temp_dir(), Arc::new(Recorder::default()), Arc::new(Rules)).unwrap());
    let (reader, writer, log) = fake_claude(vec![]);
    let client: Arc<dyn AgentConn> = ClaudeConn::start(reader, writer, session.clone());
    client.initialize().await.unwrap();
    follow_mode(&session, &client);
    for approval in [Approval::Ask, Approval::Auto, Approval::Deny] { session.set_approval(approval); }
    let modes = || -> Vec<serde_json::Value> {
        log.lock().unwrap().iter().filter(|m| m["request"]["subtype"] == "set_permission_mode").map(|m| m["request"]["mode"].clone()).collect()
    };
    tokio::time::timeout(Duration::from_secs(3), async { while modes().len() < 3 { tokio::task::yield_now().await; } }).await.unwrap();
    assert_eq!(modes(), ["default", "acceptEdits", "plan"]);
    // The hook holds the connection weakly: once it is gone, changing the mode is harmless.
    client.close();
    drop(client);
    session.set_approval(Approval::Ask);
    assert_eq!(session.approval(), Approval::Ask);
}

/// Claude opened a different session than the one asked to resume: the run says so and goes
/// on in that session with the recap, as when an ACP adapter's `session/load` fails.
#[tokio::test]
async fn claude_resume_mismatch_falls_back_to_recap() {
    use crate::acp::claude_conn::ClaudeConn;
    use crate::acp::fake_claude::{fake_claude, ClaudeStep, SESSION_ID};
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new("r", AgentKind::Claude, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
    let (reader, writer, log) = fake_claude(vec![ClaudeStep::Result { stop: "success", usage: json!({}), cost: 0.0 }]);
    let client: Arc<dyn AgentConn> = ClaudeConn::start(reader, writer, session.clone());
    let cwd = std::env::temp_dir();
    let plan = SessionPlan { cwd: &cwd, prompt: "câu mới".into(), recap: Some("Tóm tắt: đã hỏi về A.".into()), servers: &[], resume: Some("phien-cu".into()), opened: None, next: None, idle_limit: IDLE_LIMIT, prefs: SessionPrefs::default(), compact: false };
    let (_keep, rx) = oneshot::channel();
    let mut stop = Some(rx);
    let mut opened = String::new();
    let (status, error) = tokio::time::timeout(Duration::from_secs(5), drive_session(&*client, &session, plan, || stop.take().unwrap(), |id| opened = id.to_string(), |_| {}, std::future::pending())).await.unwrap();
    assert_eq!(status, "done", "{error:?}");
    assert_eq!(opened, SESSION_ID);
    let notes: Vec<String> = sink.0.lock().unwrap().iter().filter_map(|e| e.line.clone()).collect();
    assert!(notes.iter().any(|l| l.contains("phien-cu") && l.contains("Mở phiên mới và gửi kèm tóm tắt")), "{notes:?}");
    let sent: Vec<serde_json::Value> = log.lock().unwrap().iter().filter(|m| m["type"] == "user").cloned().collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["message"]["content"], "Tóm tắt: đã hỏi về A.\n\ncâu mới");
    client.close();
}

/// Claude refuses `--resume` of a conversation whose file is there: it prints an error `result`
/// and exits. The run notices before `drive_session` (`refused_resume`) and goes on in a new
/// process without `--resume`, told the recap: what the missing-file case does.
#[tokio::test]
async fn claude_refused_resume_goes_on_fresh_with_recap() {
    use crate::acp::claude_conn::ClaudeConn;
    use crate::acp::fake_claude::{fake_claude, ClaudeStep, SESSION_ID};
    use tokio::io::AsyncWriteExt;
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new("r", AgentKind::Claude, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
    // The first process: refuses the conversation and exits.
    let (io, agent) = tokio::io::duplex(4096);
    let (_agent_in, mut agent_out) = tokio::io::split(agent);
    let refusal = json!({"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"phien-cu","errors":["No conversation found with session ID: phien-cu"]});
    agent_out.write_all(format!("{refusal}\n").as_bytes()).await.unwrap();
    agent_out.shutdown().await.unwrap();
    let (reader, writer) = tokio::io::split(io);
    let first = ClaudeConn::start(reader, writer, session.clone());
    let why = tokio::time::timeout(Duration::from_secs(3), refused_resume(&first)).await.unwrap().expect("Claude đã từ chối phiên cũ");
    assert!(why.contains("No conversation found"), "{why}");
    // The new process, launched without `--resume`.
    let (reader, writer, log) = fake_claude(vec![ClaudeStep::Result { stop: "success", usage: json!({}), cost: 0.0 }]);
    let client: Arc<dyn AgentConn> = ClaudeConn::start(reader, writer, session.clone());
    let cwd = std::env::temp_dir();
    let plan = SessionPlan { cwd: &cwd, prompt: "câu mới".into(), recap: Some("Tóm tắt: đã hỏi về A.".into()), servers: &[], resume: None, opened: None, next: None, idle_limit: IDLE_LIMIT, prefs: SessionPrefs::default(), compact: false };
    let (_keep, rx) = oneshot::channel();
    let mut stop = Some(rx);
    let mut opened = String::new();
    let (status, error) = tokio::time::timeout(Duration::from_secs(5), drive_session(&*client, &session, plan, || stop.take().unwrap(), |id| opened = id.to_string(), |_| {}, std::future::pending())).await.unwrap();
    assert_eq!(status, "done", "{error:?}");
    assert_eq!(opened, SESSION_ID);
    let sent: Vec<serde_json::Value> = log.lock().unwrap().iter().filter(|m| m["type"] == "user").cloned().collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["message"]["content"], "Tóm tắt: đã hỏi về A.\n\ncâu mới");
    client.close();
}

/// The CLI may answer `initialize` before it prints its refusal: the run still notices.
#[tokio::test]
async fn claude_refused_resume_after_initialize_is_noticed() {
    use crate::acp::claude_conn::ClaudeConn;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let session = Arc::new(TaskSession::new("r", AgentKind::Claude, &std::env::temp_dir(), Arc::new(Recorder::default()), Arc::new(Rules)).unwrap());
    let (io, agent) = tokio::io::duplex(1 << 16);
    let (agent_in, mut agent_out) = tokio::io::split(agent);
    tokio::spawn(async move {
        let mut lines = BufReader::new(agent_in).lines();
        let init: serde_json::Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(init["request"]["subtype"], "initialize");
        let answer = json!({"type":"control_response","response":{"subtype":"success","request_id":init["request_id"],"response":crate::acp::fake_claude::init_response()}});
        let refusal = json!({"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"phien-cu","errors":["No conversation found with session ID: phien-cu"]});
        agent_out.write_all(format!("{answer}\n{refusal}\n").as_bytes()).await.unwrap();
        agent_out.shutdown().await.unwrap();
    });
    let (reader, writer) = tokio::io::split(io);
    let conn = ClaudeConn::start(reader, writer, session);
    let why = tokio::time::timeout(Duration::from_secs(3), refused_resume(&conn)).await.unwrap().expect("Claude đã từ chối phiên cũ");
    assert!(why.contains("No conversation found"), "{why}");
}

/// A resumed process that opened fine is left alone, and `drive_session`'s own `initialize`
/// does not ask Claude a second time.
#[tokio::test]
async fn claude_accepted_resume_is_kept() {
    use crate::acp::claude_conn::ClaudeConn;
    use crate::acp::fake_claude::fake_claude;
    let session = Arc::new(TaskSession::new("r", AgentKind::Claude, &std::env::temp_dir(), Arc::new(Recorder::default()), Arc::new(Rules)).unwrap());
    let (reader, writer, log) = fake_claude(vec![]);
    let conn = ClaudeConn::start(reader, writer, session.clone());
    assert_eq!(refused_resume(&conn).await, None);
    let init = conn.initialize().await.unwrap();
    assert_eq!(init["agentCapabilities"]["loadSession"], true);
    let asked = log.lock().unwrap().iter().filter(|m| m["request"]["subtype"] == "initialize").count();
    assert_eq!(asked, 1, "initialize chỉ gửi một lần");
    conn.close();
}

/// Chỉ hỏi of Claude always starts with `--permission-mode plan` on the command line: a warm
/// `claude -p` (opened asking) would only reach `plan` through an unacknowledged mode change.
#[test]
fn a_claude_question_never_takes_a_warm_session() {
    let none = SessionPrefs::default();
    let effort = SessionPrefs { model: None, effort: Some("high".into()) };
    assert!(!warm_fits(true, Approval::Deny, &none));
    assert!(warm_fits(true, Approval::Ask, &none));
    assert!(warm_fits(true, Approval::Auto, &none));
    assert!(!warm_fits(true, Approval::Ask, &effort), "phiên mở sẵn không có --effort");
    assert!(warm_fits(true, Approval::Ask, &SessionPrefs { model: None, effort: Some("default".into()) }));
    // ACP adapters answer every request through the app, whatever the mode.
    assert!(warm_fits(false, Approval::Deny, &effort));
}

/// A sink that also notes the nested runs.
#[derive(Default)]
struct ChildSink { events: Mutex<Vec<AgentEvent>>, children: Mutex<Vec<String>> }
impl EventSink for ChildSink {
    fn emit(&self, event: AgentEvent) { self.events.lock().unwrap().push(event); }
    fn child_run(&self, id: &str, parent: &str, _: AgentKind, title: &str) { self.children.lock().unwrap().push(format!("open {id} {parent} {title}")); }
    fn child_finished(&self, id: &str, status: &str) { self.children.lock().unwrap().push(format!("end {id} {status}")); }
}

fn claude_line(kind: &str, message: serde_json::Value, extra: serde_json::Value) -> crate::acp::fake_claude::ClaudeStep {
    let mut line = json!({ "type": kind, "message": message, "session_id": crate::acp::fake_claude::SESSION_ID });
    for (k, v) in extra.as_object().unwrap() { line[k] = v.clone(); }
    crate::acp::fake_claude::ClaudeStep::Line(line)
}

async fn claude_turn(steps: Vec<crate::acp::fake_claude::ClaudeStep>, sink: Arc<ChildSink>) -> (Arc<TaskSession>, Arc<crate::acp::claude_conn::ClaudeConn>) {
    use crate::acp::claude_conn::ClaudeConn;
    let session = Arc::new(TaskSession::new("r", AgentKind::Claude, &std::env::temp_dir(), sink, Arc::new(Rules)).unwrap());
    let (reader, writer, _log) = crate::acp::fake_claude::fake_claude(steps);
    let conn = ClaudeConn::start(reader, writer, session.clone());
    conn.initialize().await.unwrap();
    let id = conn.new_session(&std::env::temp_dir(), json!([])).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), conn.prompt_turn(&id, "tìm lỗi")).await.unwrap().unwrap();
    (session, conn)
}

/// A Claude subagent (`task_started` … `task_notification`) is a nested run `<run>~1`,
/// with its own messages, tool rows and end.
#[tokio::test]
async fn claude_subagent_becomes_child_run() {
    use crate::acp::fake_claude::ClaudeStep;
    let sink = Arc::new(ChildSink::default());
    let steps = vec![
        ClaudeStep::Line(json!({"type":"system","subtype":"task_started","task_id":"t1","tool_use_id":"toolu_agent","description":"Tìm lỗi","task_type":"local_agent","session_id":crate::acp::fake_claude::SESSION_ID})),
        claude_line("assistant", json!({"role":"assistant","content":[{"type":"text","text":"đã xem"},{"type":"tool_use","id":"toolu_k","name":"Read","input":{"file_path":"/a.rs"}}]}), json!({"parent_tool_use_id":"toolu_agent"})),
        claude_line("user", json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_k","content":"fn a() {}","is_error":false}]}), json!({"parent_tool_use_id":"toolu_agent"})),
        ClaudeStep::Line(json!({"type":"system","subtype":"task_notification","task_id":"t1","tool_use_id":"toolu_agent","status":"completed","summary":"xong","session_id":crate::acp::fake_claude::SESSION_ID})),
        ClaudeStep::Result { stop: "success", usage: json!({}), cost: 0.0 },
    ];
    let (_session, conn) = claude_turn(steps, sink.clone()).await;
    assert_eq!(*sink.children.lock().unwrap(), ["open r~1 r Tìm lỗi", "end r~1 done"]);
    let events = sink.events.lock().unwrap();
    let child: Vec<_> = events.iter().filter(|e| e.run_id == "r~1").collect();
    let message = child.iter().find(|e| e.kind == "message").expect("tin nhắn của subagent");
    assert_eq!(message.data.as_ref().unwrap()["text"], "đã xem");
    assert_eq!(child.iter().filter(|e| e.kind == "tool").count(), 2);
    assert!(events.iter().filter(|e| e.run_id == "r").all(|e| e.kind != "message" && e.kind != "tool"), "log của cha không lẫn subagent");
    conn.close();
}

/// A subagent's `can_use_tool` (carrying `agent_id`) keeps its card on the main session, and
/// the tool row it asks about shows in the subagent's run.
#[tokio::test]
async fn claude_subagent_permission_shows_tool_row_in_child() {
    use crate::acp::fake_claude::{ClaudeStep, SESSION_ID};
    let sink = Arc::new(ChildSink::default());
    let steps = vec![
        ClaudeStep::Line(json!({"type":"system","subtype":"task_started","task_id":"t1","description":"Dọn","session_id":SESSION_ID})),
        claude_line("assistant", json!({"role":"assistant","content":[{"type":"tool_use","id":"toolu_rm","name":"Bash","input":{"command":"rm -rf build"}}]}), json!({"parent_tool_use_id":null,"agent_id":"t1"})),
        ClaudeStep::Ask { tool: "Bash", input: json!({"command":"rm -rf build"}) },
        ClaudeStep::Result { stop: "success", usage: json!({}), cost: 0.0 },
    ];
    use crate::acp::claude_conn::ClaudeConn;
    let session = Arc::new(TaskSession::new("r", AgentKind::Claude, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
    let (reader, writer, _log) = crate::acp::fake_claude::fake_claude(steps);
    let conn = ClaudeConn::start(reader, writer, session.clone());
    conn.initialize().await.unwrap();
    let id = conn.new_session(&std::env::temp_dir(), json!([])).await.unwrap();
    let turn = { let conn = conn.clone(); tokio::spawn(async move { conn.prompt_turn(&id, "dọn").await }) };
    tokio::time::timeout(Duration::from_secs(3), async {
        while !sink.events.lock().unwrap().iter().any(|e| e.kind == "permission") { tokio::task::yield_now().await; }
    }).await.unwrap();
    let card = sink.events.lock().unwrap().iter().find(|e| e.kind == "permission").unwrap().clone();
    assert_eq!(card.run_id, "r");
    {
        let events = sink.events.lock().unwrap();
        let row = events.iter().find(|e| e.run_id == "r~1" && e.kind == "tool").expect("dòng tool của subagent");
        assert_eq!(row.data.as_ref().unwrap()["rawInput"]["command"], "rm -rf build");
        assert!(!events.iter().any(|e| e.run_id == "r" && e.kind == "tool"));
    }
    session.respond_permission(card.data.as_ref().unwrap()["requestId"].as_str().unwrap(), "allow", false).unwrap();
    tokio::time::timeout(Duration::from_secs(3), turn).await.unwrap().unwrap().unwrap();
    conn.close();
}

/// `rate_limit_event` becomes `usage_update` + `_claude/rateLimit`, and the run's `limits`
/// event carries the 5-hour window (shape of the real `tests/fixtures/claude/2.1.318` line).
#[tokio::test]
async fn claude_rate_limit_emits_limits() {
    use crate::acp::fake_claude::ClaudeStep;
    let sink = Arc::new(ChildSink::default());
    let steps = vec![
        ClaudeStep::Line(json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793913000,"rateLimitType":"five_hour","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.41,"resetsAt":1793913000,"status":"allowed"},"seven_day":{"utilization":0.05,"resetsAt":1794171600,"status":"allowed"}}},"session_id":crate::acp::fake_claude::SESSION_ID})),
        ClaudeStep::Result { stop: "success", usage: json!({}), cost: 0.0 },
    ];
    let (_session, conn) = claude_turn(steps, sink.clone()).await;
    let events = sink.events.lock().unwrap();
    let limits = events.iter().find(|e| e.kind == "limits").expect("event limits").data.clone().unwrap();
    assert_eq!(limits["windows"][0]["id"], "five_hour");
    assert_eq!(limits["windows"][0]["utilization"], 0.41);
    assert_eq!(limits["windows"][1]["id"], "seven_day");
    conn.close();
}

/// Claude withdraws a `can_use_tool` (`control_cancel_request`): its card closes as cancelled,
/// the other cards stay, and no answer goes back for it.
#[tokio::test]
async fn withdrawn_permission_closes_its_card() {
    use crate::acp::claude_conn::ClaudeConn;
    use crate::acp::fake_claude::{fake_claude, ClaudeStep};
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new("r", AgentKind::Claude, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
    let steps = vec![
        ClaudeStep::AskWithdrawn { tool: "Bash", input: json!({ "command": "rm -rf build" }) },
        ClaudeStep::Result { stop: "success", usage: json!({}), cost: 0.0 },
    ];
    let (reader, writer, log) = fake_claude(steps);
    let conn = ClaudeConn::start(reader, writer, session.clone());
    conn.initialize().await.unwrap();
    let id = conn.new_session(&std::env::temp_dir(), json!([])).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), conn.prompt_turn(&id, "dọn")).await.unwrap().unwrap();
    // The connection tells the session on the reader task: give it a moment.
    tokio::time::timeout(Duration::from_secs(3), async {
        while !sink.0.lock().unwrap().iter().any(|e| e.kind == "permission_resolved") { tokio::task::yield_now().await; }
    }).await.unwrap();
    let events = sink.0.lock().unwrap();
    let card = events.iter().find(|e| e.kind == "permission").unwrap().data.clone().unwrap();
    let resolved = events.iter().find(|e| e.kind == "permission_resolved").unwrap().data.clone().unwrap();
    assert_eq!(resolved["requestId"], card["requestId"]);
    assert_eq!(resolved["outcome"]["outcome"], "cancelled");
    drop(events);
    assert!(session.respond_permission(card["requestId"].as_str().unwrap(), "allow", false).is_err());
    assert!(!log.lock().unwrap().iter().any(|m| m["type"] == "control_response"), "không trả lời yêu cầu đã rút");
    conn.close();
}

#[tokio::test]
async fn messages_stay_in_one_session_and_closing_is_a_normal_end() {
    use crate::acp::fake::Step;
    let (client, session, log, _) = fixture(vec![Step::Message("xin chào"), Step::End("end_turn")], false);
    let (status, turns) = session_with(&client, &session, None, None, vec!["hai", "ba"], false).await;
    assert_eq!(status, "done");
    assert_eq!(turns, vec!["done", "done", "done"]);
    assert_eq!(count(&log, "session/new"), 1, "gửi thêm câu không được mở phiên mới");
    assert_eq!(prompts(&log), vec!["đầu", "hai", "ba"]);
    assert!(!session.is_busy());
}

#[tokio::test]
async fn a_warm_session_goes_straight_to_the_prompt() {
    use crate::acp::fake::Step;
    let (client, session, log, _) = fixture(vec![Step::Message("xin chào"), Step::End("end_turn")], false);
    client.initialize().await.unwrap();
    let id = client.new_session(&std::env::temp_dir(), json!([])).await.unwrap();
    let cwd = std::env::temp_dir();
    let plan = SessionPlan { cwd: &cwd, prompt: "đầu".into(), recap: Some("TÓM TẮT".into()), servers: &[], resume: None, opened: Some(id.clone()), next: None, idle_limit: IDLE_LIMIT, prefs: SessionPrefs::default(), compact: false };
    let (_keep, rx) = oneshot::channel();
    let mut stop = Some(rx);
    let opened = Mutex::new(None);
    let (status, _) = tokio::time::timeout(Duration::from_secs(5), drive_session(&client, &session, plan, || stop.take().unwrap(), |sid| *opened.lock().unwrap() = Some(sid.to_string()), |_| {}, std::future::pending())).await.unwrap();
    assert_eq!(status, "done");
    assert_eq!((count(&log, "initialize"), count(&log, "session/new")), (1, 1), "phiên đã mở sẵn không được mở lại");
    assert_eq!(opened.into_inner().unwrap(), Some(id));
    assert_eq!(prompts(&log), vec!["TÓM TẮT\n\nđầu"]);
}

#[tokio::test]
async fn a_refused_turn_is_reported_and_the_session_stays_open() {
    use crate::acp::fake::Step;
    let (client, session, log, _) = fixture(vec![Step::End("refusal")], false);
    let (status, turns) = session_with(&client, &session, None, None, vec!["hai"], false).await;
    assert_eq!(turns, vec!["failed", "failed"]);
    assert_eq!(status, "failed");
    assert_eq!(prompts(&log).len(), 2);
}

#[tokio::test]
async fn only_one_turn_can_be_claimed() {
    let (_, session, _, _) = fixture(vec![], false);
    assert!(session.claim_turn());
    assert!(!session.claim_turn());
    session.set_busy(false);
    assert!(session.claim_turn());
}

#[tokio::test]
async fn a_reopened_session_needs_no_recap() {
    use crate::acp::fake::Step;
    let (client, session, log, _) = fixture(vec![Step::End("end_turn")], true);
    session_with(&client, &session, Some("cũ".into()), Some("TÓM TẮT".into()), vec![], false).await;
    assert_eq!(count(&log, "session/load"), 1);
    assert_eq!(count(&log, "session/new"), 0);
    assert_eq!(prompts(&log), vec!["đầu"]);
}

#[tokio::test]
async fn a_reopened_session_is_compacted_before_the_prompt_when_asked() {
    use crate::acp::fake::Step;
    for (loadable, expected) in [(true, vec!["/compact", "đầu"]), (false, vec!["TÓM TẮT\n\nđầu"])] {
        let (client, session, log, _) = fixture(vec![Step::End("end_turn")], loadable);
        let cwd = std::env::temp_dir();
        let plan = SessionPlan { cwd: &cwd, prompt: "đầu".into(), recap: Some("TÓM TẮT".into()), servers: &[], resume: Some("cũ".into()), opened: None, next: None, idle_limit: IDLE_LIMIT, prefs: SessionPrefs::default(), compact: true };
        let keep = Mutex::new(Vec::new());
        let next_stop = || { let (tx, rx) = oneshot::channel::<()>(); keep.lock().unwrap().push(tx); rx };
        let (status, _) = tokio::time::timeout(Duration::from_secs(5), drive_session(&client, &session, plan, next_stop, |_| {}, |_: &TurnEnd| {}, std::future::pending())).await.unwrap();
        assert_eq!(status, "done");
        // Without a session to reopen there is nothing to compact: the recap goes instead.
        assert_eq!(prompts(&log), expected, "loadable: {loadable}");
    }
}

#[tokio::test]
async fn an_agent_that_cannot_reopen_gets_the_recap() {
    use crate::acp::fake::Step;
    let (client, session, log, _) = fixture(vec![Step::End("end_turn")], false);
    session_with(&client, &session, Some("cũ".into()), Some("TÓM TẮT".into()), vec![], false).await;
    assert_eq!(count(&log, "session/load"), 0);
    assert_eq!(prompts(&log), vec!["TÓM TẮT\n\nđầu"]);
}

#[tokio::test]
async fn tokens_add_up_across_turns_while_cost_is_the_session_total() {
    let (_, session, _, sink) = fixture(vec![], false);
    use crate::acp::client::ClientHandler;
    let cost = |amount: f64| json!({"update":{"sessionUpdate":"usage_update","used":1,"size":2,"cost":{"amount":amount,"currency":"USD"}}});
    session.on_notification("session/update", cost(0.1));
    session.turn_finished(&json!({"usage":{"inputTokens":2,"cachedWriteTokens":10,"cachedReadTokens":100,"outputTokens":4}}));
    session.on_notification("session/update", cost(0.25));
    session.turn_finished(&json!({"usage":{"inputTokens":3,"cachedWriteTokens":5,"cachedReadTokens":200,"outputTokens":6}}));
    let events = sink.0.lock().unwrap();
    let last = events.iter().rev().find_map(|e| e.usage.clone()).unwrap();
    assert_eq!((last.input_tokens, last.cached_input_tokens, last.output_tokens), (20, 300, 10));
    assert_eq!(last.cost_usd, Some(0.25));
    assert!(last.cumulative);
    assert!(events.iter().filter_map(|e| e.usage.as_ref()).all(|u| u.cumulative));
}

#[tokio::test]
async fn a_reopened_session_counts_only_new_cost_and_mutes_its_replay() {
    let (_, session, _, sink) = fixture(vec![], false);
    use crate::acp::client::ClientHandler;
    session.set_cost_base(0.2);
    session.set_muted(true);
    session.on_notification("session/update", json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"cũ"}}}));
    session.set_muted(false);
    session.on_notification("session/update", json!({"update":{"sessionUpdate":"usage_update","used":1,"size":2,"cost":{"amount":0.25,"currency":"USD"}}}));
    let events = sink.0.lock().unwrap();
    assert!(!events.iter().any(|e| e.kind == "message"));
    let cost = events.iter().rev().find_map(|e| e.usage.as_ref()?.cost_usd).unwrap();
    assert!((cost - 0.05).abs() < 1e-9, "{cost}");
}

#[test]
fn turn_outcome_maps_stop_reasons() {
    for (result, status, message) in [
        (json!({"stopReason": "end_turn"}), "done", None),
        (json!({}), "done", None),
        (json!({"stopReason": "unknown"}), "done", None),
        (json!({"stopReason": "cancelled"}), "stopped", None),
        (json!({"stopReason": "max_tokens"}), "failed", Some("Agent dừng vì đã hết giới hạn độ dài trả lời.")),
        (json!({"stopReason": "max_turn_requests"}), "failed", Some("Agent dừng vì đã đạt giới hạn số bước trong một lượt.")),
        (json!({"stopReason": "refusal"}), "failed", Some("Agent từ chối thực hiện yêu cầu này.")),
    ] {
        assert_eq!(turn_outcome(&result), (status, message.map(str::to_string)), "{result}");
    }
}

#[tokio::test]
async fn refusal_turn_is_failed_in_drive() {
    use crate::acp::fake::{self, Step};
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink, Arc::new(Rules)).unwrap());
    let (reader, writer, _) = fake::spawn(vec![Step::End("refusal")]);
    let client = AcpClient::start(reader, writer, session.clone());
    let (_tx, rx) = oneshot::channel();
    let result = drive(&client, &session, &std::env::temp_dir(), "p", &[], rx, std::future::pending()).await;
    assert_eq!(result, ("failed", Some("Agent từ chối thực hiện yêu cầu này.".into())));
}

#[tokio::test]
async fn fake_prompt_completion_and_crash_have_distinct_statuses() {
    use crate::acp::fake::{self, Step};
    for (steps, status) in [(vec![Step::End("end_turn")], "done"), (vec![Step::AskPermission, Step::Crash], "failed")] {
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
        let (reader, writer, _) = fake::spawn(steps);
        let client = AcpClient::start(reader, writer, session.clone());
        let (_tx, rx) = oneshot::channel();
        let result = tokio::time::timeout(Duration::from_secs(2), drive(&client, &session, &std::env::temp_dir(), "p", &[], rx, std::future::pending())).await.unwrap();
        assert_eq!(result.0, status);
        if status == "failed" {
            let events = sink.0.lock().unwrap();
            assert_eq!(events.iter().filter(|e| e.kind == "permission").count(), 1);
            assert_eq!(events.iter().filter(|e| e.kind == "permission_resolved").count(), 1);
        }
    }
}
#[tokio::test]
async fn session_new_carries_enabled_mcp_servers() {
    use crate::acp::fake::{self, Step};
    use crate::integrations::mcp::{McpServer, NameValue};
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
    let (reader, writer, log) = fake::spawn(vec![Step::End("end_turn")]);
    let client = AcpClient::start(reader, writer, session.clone());
    let servers = [
        McpServer { id: "1".into(), name: "docs".into(), transport: "stdio".into(), command: Some("docs-mcp".into()), args: vec![], env: vec![NameValue { name: "K".into(), value: "v".into() }], url: None, headers: vec![], agents: vec![AgentKind::Codex] },
        McpServer { id: "2".into(), name: "web".into(), transport: "http".into(), command: None, args: vec![], env: vec![], url: Some("https://x".into()), headers: vec![], agents: vec![AgentKind::Codex] },
    ];
    let (_tx, rx) = oneshot::channel();
    let result = drive(&client, &session, &std::env::temp_dir(), "p", &servers, rx, std::future::pending()).await;
    assert_eq!(result.0, "done");
    let sent = log.lock().unwrap().iter().find(|v| v["method"] == "session/new").cloned().unwrap();
    assert_eq!(sent["params"]["mcpServers"], json!([{"name":"docs","command":"docs-mcp","args":[],"env":[{"name":"K","value":"v"}]}]));
    // The fake agent does not offer http, so the user is told why "web" is missing.
    assert!(sink.0.lock().unwrap().iter().any(|e| e.kind == "stderr" && e.line.as_deref().unwrap().contains("web")));
}

#[tokio::test]
async fn user_stop_sends_cancel_resolves_cards_and_reports_stopped() {
    use crate::acp::fake::{self, Step};
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
    let (reader, writer, log) = fake::spawn(vec![Step::AskPermission, Step::WaitForCancel, Step::End("cancelled")]);
    let client = AcpClient::start(reader, writer, session.clone());
    let (tx, rx) = oneshot::channel();
    let request_stop = async { wait_permission(&sink).await; tx.send(()).unwrap(); };
    let cwd = std::env::temp_dir();
    let (result, _) = tokio::join!(drive(&client, &session, &cwd, "p", &[], rx, std::future::pending()), request_stop);
    assert_eq!(result.0, "stopped");
    assert!(log.lock().unwrap().iter().any(|v| v["method"] == "session/cancel"));
    assert!(sink.0.lock().unwrap().iter().any(|e| e.kind == "permission_resolved" && e.data.as_ref().unwrap()["outcome"]["outcome"] == "cancelled"));
}
#[tokio::test]
async fn process_death_with_open_stdio_does_not_hang() {
    use crate::acp::fake::{self, Step};
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
    let (reader, writer, _) = fake::spawn(vec![Step::AskPermission, Step::WaitForPermissionReply]);
    let client = AcpClient::start(reader, writer, session.clone());
    let (_tx, rx) = oneshot::channel();
    let dead = async { wait_permission(&sink).await; };
    let result = drive(&client, &session, &std::env::temp_dir(), "p", &[], rx, dead).await;
    assert_eq!(result.0, "failed");
    // Agent-neutral wording: Claude no longer runs through an adapter.
    assert_eq!(result.1.as_deref(), Some("Codex đã dừng trước khi hoàn tất yêu cầu."));
    assert!(sink.0.lock().unwrap().iter().any(|e| e.kind == "permission_resolved"));
}
#[tokio::test]
async fn unresponsive_agent_gets_five_seconds_after_cancel() {
    use crate::acp::fake::{self, Step};
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new("r", AgentKind::Codex, &std::env::temp_dir(), sink.clone(), Arc::new(Rules)).unwrap());
    let (reader, writer, _) = fake::spawn(vec![Step::AskPermission, Step::WaitForCancel]);
    let client = AcpClient::start(reader, writer, session.clone());
    let (tx, rx) = oneshot::channel();
    let request_stop = async {
        wait_permission(&sink).await;
        tx.send(()).unwrap();
        std::time::Instant::now()
    };
    let cwd = std::env::temp_dir();
    let (result, requested_at) = tokio::time::timeout(Duration::from_secs(8), async {
        tokio::join!(drive(&client, &session, &cwd, "p", &[], rx, std::future::pending()), request_stop)
    }).await.unwrap();
    assert_eq!(result.0, "stopped");
    assert!(requested_at.elapsed() >= Duration::from_secs(5));
}

#[cfg(unix)]
#[tokio::test]
async fn adapter_cleanup_kills_descendants_holding_stdio() {
    use std::os::unix::process::CommandExt;
    use tokio::io::AsyncReadExt;
    let mut command = env::command("sh");
    command.args(["-c", "sleep 30 & wait"]).env("PATH", env::login_path())
        .stdout(Stdio::piped()).kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command.spawn().unwrap();
    let pid = child.id();
    let mut stdout = child.stdout.take().unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    terminate_adapter(&mut child, pid).await;
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), stdout.read_to_end(&mut bytes)).await.unwrap().unwrap();
}

#[test]
fn reopened_store_supports_diff_accept_reject_and_commit() {
    let repo = Repo::new();
    let wt = repo.wt();
    let db = repo.0.join("history.db");
    {
        let store = Store::open(&db).unwrap();
        store.insert_run_with_worktree(&NewRun { id: &wt.run_id, agent: AgentKind::Codex, prompt: "p", cwd: wt.path.to_str().unwrap(), started_at: 1 }, repo.0.to_str().unwrap(), &wt, None).unwrap();
    }
    std::fs::write(wt.path.join("new.txt"), "accepted\n").unwrap();
    std::fs::write(wt.path.join("reject.txt"), "rejected\n").unwrap();
    let store = Store::open(&db).unwrap();
    let (root, restored) = stored_worktree(&store, &wt.run_id).unwrap();
    diff::revert_files(&restored, &["reject.txt".into()]).unwrap();
    diff::accept_all(&root, &restored).unwrap();
    assert!(diff::pending(&restored).unwrap().is_empty());
    let hash = diff::commit(&root, "accepted only").unwrap();
    assert!(!hash.is_empty());
    assert_eq!(std::fs::read_to_string(repo.0.join("new.txt")).unwrap(), "accepted\n");
    assert!(!repo.0.join("reject.txt").exists());
    worktree::remove(&root, &restored, true).unwrap();
    assert!(!restored.path.exists());
}

#[tokio::test]
async fn failed_spawn_removes_worktree_branch_and_does_not_insert_run() {
    let repo = Repo::new();
    let store = Store::open_in_memory().unwrap();
    let missing = repo.0.join("missing-adapter");
    let result = prepare(&store, AgentKind::Codex, "task", &repo.0, Adapter::Spawn((missing, vec![])), None, None, Place::Draft(None)).await;
    assert!(result.err().unwrap().contains("Không chạy được"));
    assert!(store.list_runs(10).unwrap().is_empty());
    assert!(worktree::list(&repo.0).unwrap().is_empty());
    assert!(worktree::git(&repo.0, &["branch", "--list", "tg/*"], None).unwrap().is_empty());
}

// Copies each JSON-RPC line between the client and a real adapter into `log`.
fn tee<R, W>(from: R, mut to: W, dir: &'static str, log: Arc<Mutex<Vec<serde_json::Value>>>) -> tokio::task::JoinHandle<()>
where R: tokio::io::AsyncRead + Unpin + Send + 'static, W: tokio::io::AsyncWrite + Unpin + Send + 'static {
    use tokio::io::AsyncWriteExt;
    tokio::spawn(async move {
        let mut lines = BufReader::new(from).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                log.lock().unwrap().push(json!({"dir": dir, "msg": value}));
            }
            if to.write_all(format!("{line}\n").as_bytes()).await.is_err() { break; }
            let _ = to.flush().await;
        }
        let _ = to.shutdown().await;
    })
}

struct LiveRun { wt: Worktree, status: &'static str, error: Option<String>, events: Vec<AgentEvent>, asked: Vec<serde_json::Value>, traffic: Vec<serde_json::Value> }

/// Spawns the real Claude adapter for one task and plays the user: every card is allowed once.
async fn run_live(store: &Store, repo: &Path, prompt: &str, group: Option<&str>) -> LiveRun {
    run_live_with(store, repo, prompt, group, &[]).await
}

async fn run_live_with(store: &Store, repo: &Path, prompt: &str, group: Option<&str>, servers: &[McpServer]) -> LiveRun {
    run_live_agent(AgentKind::Claude, store, repo, prompt, group, servers).await
}

async fn run_live_agent(agent: AgentKind, store: &Store, repo: &Path, prompt: &str, group: Option<&str>, servers: &[McpServer]) -> LiveRun {
    let command = agent.acp_command(env::which).expect("adapter ACP hoặc npx");
    let timeout = setup_timeout(&command.0);
    let (id, wt, mut child, _) = prepare(store, agent, prompt, repo, Adapter::Spawn(command), group, None, Place::Draft(None)).await.unwrap();
    let pid = child.id();
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new(&id, agent, &wt.path, sink.clone(), Arc::new(Rules)).unwrap());
    let traffic = Arc::new(Mutex::new(Vec::new()));
    let (client_in, tee_out) = tokio::io::duplex(1 << 20);
    let (tee_in, client_out) = tokio::io::duplex(1 << 20);
    let _down = tee(child.stdout.take().unwrap(), tee_out, "agent", traffic.clone());
    let _up = tee(client_out, child.stdin.take().unwrap(), "client", traffic.clone());
    let stderr = child.stderr.take().unwrap();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await { eprintln!("[adapter] {line}"); }
    });
    let client = AcpClient::start_with_timeout(client_in, tee_in, session.clone(), timeout);
    // Plays the user: allow every card once and remember which tools asked.
    let approver = {
        let (sink, session) = (sink.clone(), session.clone());
        tokio::spawn(async move {
            let mut seen = std::collections::HashSet::new();
            let mut asked = Vec::new();
            loop {
                let cards: Vec<_> = sink.0.lock().unwrap().iter().filter(|e| e.kind == "permission").filter_map(|e| e.data.clone()).collect();
                for card in cards {
                    let id = card["requestId"].as_str().unwrap().to_string();
                    if !seen.insert(id.clone()) { continue; }
                    let option = card["options"].as_array().unwrap().iter()
                        .find(|o| o["kind"] == "allow_once").or_else(|| card["options"].as_array().unwrap().iter().find(|o| o["kind"] == "allow_always"))
                        .expect("thẻ duyệt không có lựa chọn cho phép")["optionId"].as_str().unwrap().to_string();
                    eprintln!("[duyệt] {} → {option}", card["toolCall"]["title"]);
                    asked.push(card["toolCall"].clone());
                    session.respond_permission(&id, &option, false).unwrap();
                }
                if seen.len() > 20 { break asked; }
                tokio::time::sleep(Duration::from_millis(50)).await;
                if sink.0.lock().unwrap().iter().any(|e| e.kind == "exit") { break asked; }
            }
        })
    };
    let (_tx, rx) = oneshot::channel();
    let (status, error) = tokio::time::timeout(Duration::from_secs(300), drive(&client, &session, &wt.path, prompt, servers, rx, async { std::future::pending::<()>().await })).await.expect("quá 5 phút");
    client.close();
    terminate_adapter(&mut child, pid).await;
    sink.emit(AgentEvent::new(&id, agent, "exit"));
    let asked = approver.await.unwrap();
    let events = sink.0.lock().unwrap().clone();
    let traffic = traffic.lock().unwrap().clone();
    LiveRun { wt, status, error, events, asked, traffic }
}

fn message_of(events: &[AgentEvent]) -> String {
    events.iter().filter(|e| e.kind == "message").filter_map(|e| e.data.as_ref()?["text"].as_str().map(String::from)).collect()
}

/// Phase 1 acceptance against the real Claude adapter (needs network and a logged-in `claude`):
/// A session opened before its run exists answers its first prompt as quickly as an open CLI.
/// `TG_LIVE_ACP=1 cargo test live_claude_warm -- --ignored --nocapture`.
#[tokio::test]
#[ignore]
async fn live_claude_warm_session_answers_after_attach() {
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let command = AgentKind::Claude.acp_command(env::which).expect("adapter ACP hoặc npx");
    let dir = std::env::temp_dir();
    let started = std::time::Instant::now();
    let mut child = spawn_adapter(&command, &dir).unwrap();
    let stderr = child.stderr.take().unwrap();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(_)) = lines.next_line().await {}
    });
    let late = crate::acp::late::LateHandler::new();
    let client = AcpClient::start_with_timeout(child.stdout.take().unwrap(), child.stdin.take().unwrap(), late.clone(), setup_timeout(&command.0));
    client.initialize().await.unwrap();
    let id = client.new_session(&dir, json!([])).await.unwrap();
    eprintln!("mở phiên: {:?}", started.elapsed());
    // The user is still typing. The adapter answers session/new at once and starts the
    // agent in the background; its notifications arrive while nobody owns the session.
    let typing = std::env::var("TG_WARM_WAIT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(8000);
    tokio::time::sleep(Duration::from_millis(typing)).await;
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new("warm", AgentKind::Claude, &dir, sink.clone(), Arc::new(Rules)).unwrap());
    late.attach(session.clone()).unwrap();
    let plan = SessionPlan { cwd: &dir, prompt: "Trả lời đúng một từ: xin chào".into(), recap: None, servers: &[], resume: None, opened: Some(id), next: None, idle_limit: IDLE_LIMIT, prefs: SessionPrefs::default(), compact: false };
    let (_keep, rx) = oneshot::channel();
    let mut stop = Some(rx);
    let asked = std::time::Instant::now();
    let watcher = { let sink = sink.clone(); tokio::spawn(async move {
        while !sink.0.lock().unwrap().iter().any(|e| e.kind == "message") { tokio::time::sleep(Duration::from_millis(20)).await; }
        eprintln!("token đầu sau khi gửi: {:?}", asked.elapsed());
    }) };
    let (status, error) = drive_session(&client, &session, plan, || stop.take().unwrap(), |_| {}, |_| {}, std::future::pending()).await;
    eprintln!("xong sau khi gửi: {:?}", asked.elapsed());
    watcher.abort();
    client.close();
    let pid = child.id();
    terminate_adapter(&mut child, pid).await;
    assert_eq!(status, "done", "{error:?}");
    let events = sink.0.lock().unwrap();
    assert!(events.iter().any(|e| e.kind == "message"), "không có câu trả lời");
    assert!(events.iter().any(|e| e.usage.is_some()), "không có usage của lượt");
}

/// `TG_LIVE_ACP=1 cargo test live_claude -- --ignored --nocapture`.
/// Set `TG_ACP_FIXTURE=<path>` to save the JSON-RPC traffic.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_claude_edit_permission_diff_accept_commit() {
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let repo = Repo::new();
    repo.write("hello.txt", "Hello world\n");
    worktree::git(&repo.0, &["add", "."], None).unwrap();
    worktree::git(&repo.0, &["commit", "-m", "hello"], None).unwrap();
    let store = Store::open_in_memory().unwrap();
    let prompt = "Edit hello.txt so that its only line reads exactly `Hello ACP` (keep the trailing newline). Then run the shell command `echo checked > checked.txt` with your terminal tool, and finally tell me the exact contents of hello.txt. Do not commit.";
    let LiveRun { wt, status, error, events, asked, traffic } = run_live(&store, &repo.0, prompt, None).await;
    if let Ok(path) = std::env::var("TG_ACP_FIXTURE") {
        let text: String = traffic.iter().map(|v| format!("{v}\n")).collect();
        std::fs::write(path, text).unwrap();
    }
    let message = message_of(&events);
    eprintln!("status={status} error={error:?}\nmessage={message}\nkinds={:?}", events.iter().map(|e| e.kind).collect::<Vec<_>>());
    assert_eq!(status, "done", "{error:?}");
    assert!(events.iter().any(|e| e.kind == "tool"), "không có tool update");
    assert!(asked.iter().any(|t| t["kind"] == "execute"), "lệnh shell phải qua thẻ duyệt: {asked:?}");
    assert!(message.contains("Hello ACP"), "agent không báo lại output: {message}");
    assert!(asked.iter().any(|t| t["kind"] == "execute" && t["rawInput"]["command"].as_str().is_some_and(|c| c.contains("checked.txt"))), "thẻ duyệt lệnh phải có rawInput.command");
    let usage = events.iter().rev().find_map(|e| e.usage.clone()).expect("phải có usage");
    assert!(usage.output_tokens > 0 && usage.cost_usd.is_some(), "{usage:?}");
    // Nothing reaches the user's repo before review.
    assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello world\n");
    let pending = diff::pending(&wt).unwrap();
    assert!(pending.iter().any(|f| f.path == "hello.txt"), "diff phải có hello.txt: {pending:?}");
    assert!(pending.iter().any(|f| f.path == "checked.txt" && f.status == "A"), "diff phải có checked.txt: {pending:?}");
    diff::accept_all(&repo.0, &wt).unwrap();
    assert!(diff::pending(&wt).unwrap().is_empty());
    let hash = diff::commit(&repo.0, "Đổi lời chào").unwrap();
    assert!(!hash.is_empty());
    assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello ACP\n");
    assert_eq!(std::fs::read_to_string(repo.0.join("checked.txt")).unwrap().trim(), "checked");
    worktree::remove(&repo.0, &wt, true).unwrap();
}

fn greeting_repo() -> Repo {
    let repo = Repo::new();
    repo.write("hello.txt", "Hello world\n");
    worktree::git(&repo.0, &["add", "."], None).unwrap();
    worktree::git(&repo.0, &["commit", "-m", "hello"], None).unwrap();
    repo
}

const GREETING_PROMPT: &str = "Edit hello.txt so that its only line reads exactly `Hello ACP` (keep the trailing newline). Do not change anything else and do not commit.";

/// M-D acceptance against the real Codex adapter (needs network and a logged-in `codex`):
/// `TG_LIVE_ACP=1 cargo test live_codex -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_codex_edit_diff_accept_commit() {
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let repo = greeting_repo();
    let store = Store::open_in_memory().unwrap();
    let LiveRun { wt, status, error, events, .. } = run_live_agent(AgentKind::Codex, &store, &repo.0, GREETING_PROMPT, None, &[]).await;
    eprintln!("status={status} error={error:?}\nmessage={}\nusage={:?}", message_of(&events), events.iter().rev().find_map(|e| e.usage.clone()));
    assert_eq!(status, "done", "{error:?}");
    assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello world\n", "repo chỉ đổi khi duyệt");
    let pending = diff::pending(&wt).unwrap();
    assert!(pending.iter().any(|f| f.path == "hello.txt"), "diff phải có hello.txt: {pending:?}");
    assert!(events.iter().rev().find_map(|e| e.usage.clone()).is_some_and(|u| u.output_tokens > 0), "phải có token");
    diff::accept_all(&repo.0, &wt).unwrap();
    assert!(!diff::commit(&repo.0, "Đổi lời chào").unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello ACP\n");
    worktree::remove(&repo.0, &wt, true).unwrap();
}

/// Two prompts in one session remember each other, and so does a respawned adapter
/// through session/load. Prints what it reports. `TG_LIVE_AGENT=claude|codex`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_two_turns_probe() {
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let agent = if std::env::var("TG_LIVE_AGENT").as_deref() == Ok("codex") { AgentKind::Codex } else { AgentKind::Claude };
    let dir = std::env::temp_dir().join(format!("tg-two-turns-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let dir = dunce::canonicalize(dir).unwrap();
    let spawn = || {
        let (program, args) = agent.acp_command(env::which).unwrap();
        let mut c = env::command(program);
        c.args(args).current_dir(&dir).env("PATH", env::login_path()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        c.spawn().unwrap()
    };
    let start = |child: &mut Child, sink: Arc<Recorder>| {
        let session = Arc::new(TaskSession::new("r", agent, &dir, sink, Arc::new(Rules)).unwrap());
        AcpClient::start_with_timeout(child.stdout.take().unwrap(), child.stdin.take().unwrap(), session, Duration::from_secs(300))
    };
    let sink = Arc::new(Recorder::default());
    let mut child = spawn();
    let client = start(&mut child, sink.clone());
    let init = client.initialize().await.unwrap();
    eprintln!("loadSession={}", init["agentCapabilities"]["loadSession"]);
    let id = client.new_session(&dir, json!([])).await.unwrap();
    for text in ["Remember the word PINEAPPLE. Reply with exactly: ok", "Which word did I ask you to remember? Reply with that word only."] {
        let result = client.prompt_turn(&id, text).await.unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let events = sink.0.lock().unwrap();
        let costs: Vec<_> = events.iter().filter(|e| e.kind == "usage").filter_map(|e| e.usage.as_ref()?.cost_usd).collect();
        eprintln!("RESULT stop={} usage={} costs={costs:?}\nMESSAGE={}", result["stopReason"], result["usage"], message_of(&events));
        drop(events);
    }
    assert!(message_of(&sink.0.lock().unwrap()).contains("PINEAPPLE"), "câu sau phải nhớ câu trước");
    eprintln!("pid alive across turns: {:?}", child.id());
    client.close();
    let pid = child.id(); terminate_adapter(&mut child, pid).await;
    let sink = Arc::new(Recorder::default());
    let mut child = spawn();
    let client = start(&mut child, sink.clone());
    client.initialize().await.unwrap();
    let loaded = client.load_session(&id, &dir, json!([])).await;
    eprintln!("LOAD={loaded:?} replayed={}", sink.0.lock().unwrap().len());
    if loaded.is_ok() {
        sink.0.lock().unwrap().clear();
        let result = client.prompt_turn(&id, "Which word did I ask you to remember? Reply with that word only.").await.unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let events = sink.0.lock().unwrap();
        let costs: Vec<_> = events.iter().filter(|e| e.kind == "usage").filter_map(|e| e.usage.as_ref()?.cost_usd).collect();
        eprintln!("AFTER LOAD usage={} costs={costs:?} MESSAGE={}", result["usage"], message_of(&events));
        assert!(message_of(&events).contains("PINEAPPLE"), "phiên nối lại phải nhớ");
        drop(events);
    }
    client.close();
    let pid = child.id(); terminate_adapter(&mut child, pid).await;
    let _ = std::fs::remove_dir_all(dir);
}

struct NativeRun { status: &'static str, error: Option<String>, events: Vec<AgentEvent>, asked: Vec<serde_json::Value> }

/// `claude -p` launched as `start_task` launches it (`native_command`, `ClaudeConn`,
/// `follow_mode`) in `dir`, with each of `questions` sent once the turn before ends;
/// `between` runs on the session before every later question. Plays the user: every card is
/// allowed once. Needs network and a logged-in `claude`.
async fn live_native(dir: &Path, approval: Approval, questions: &[&str], between: impl Fn(&TaskSession)) -> NativeRun {
    use crate::acp::claude_conn::ClaudeConn;
    let sink = Arc::new(Recorder::default());
    let session = Arc::new(TaskSession::new("live", AgentKind::Claude, dir, sink.clone(), Arc::new(Rules)).unwrap());
    session.set_approval(approval);
    let launch = native_launch(Arc::new(BridgeHub::default()), vec![], false, false, &std::env::temp_dir(), &mut Vec::new()).await.unwrap();
    let command = native_command(approval, None, launch.file.as_ref().map(|f| f.path()), &SessionPrefs::default()).unwrap();
    eprintln!("[lệnh] {} {}", command.0.display(), command.1.join(" "));
    let mut child = spawn_adapter(&command, dir).unwrap();
    let pid = child.id();
    let stderr = child.stderr.take().unwrap();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await { eprintln!("[claude] {line}"); }
    });
    let client: Arc<dyn AgentConn> = ClaudeConn::start(child.stdout.take().unwrap(), child.stdin.take().unwrap(), session.clone());
    follow_mode(&session, &client);
    let approver = {
        let (sink, session) = (sink.clone(), session.clone());
        tokio::spawn(async move {
            let mut seen = std::collections::HashSet::new();
            let mut asked = Vec::new();
            while !sink.0.lock().unwrap().iter().any(|e| e.kind == "exit") && seen.len() <= 20 {
                let cards: Vec<_> = sink.0.lock().unwrap().iter().filter(|e| e.kind == "permission").filter_map(|e| e.data.clone()).collect();
                for card in cards {
                    let id = card["requestId"].as_str().unwrap().to_string();
                    if !seen.insert(id.clone()) { continue; }
                    eprintln!("[duyệt] {}", card["toolCall"]["title"]);
                    asked.push(card["toolCall"].clone());
                    let _ = session.respond_permission(&id, "allow", false);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            asked
        })
    };
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let tx = Mutex::new(Some(tx));
    let rest = Mutex::new(questions[1..].iter().map(|q| q.to_string()).collect::<std::collections::VecDeque<_>>());
    let plan = SessionPlan { cwd: dir, prompt: questions[0].into(), recap: None, servers: &[], resume: None, opened: None, next: Some(rx), idle_limit: IDLE_LIMIT, prefs: SessionPrefs::default(), compact: false };
    // Every phase gets a stop signal nobody sends (a dropped sender would read as a stop).
    let senders = Mutex::new(Vec::new());
    let next_stop = || { let (tx, rx) = oneshot::channel(); senders.lock().unwrap().push(tx); rx };
    let on_turn = |end: &TurnEnd| {
        eprintln!("[lượt] {} {:?}", end.status, end.error);
        match rest.lock().unwrap().pop_front() {
            Some(question) => {
                between(&session);
                assert!(start_turn(&session));
                tx.lock().unwrap().as_ref().unwrap().send(question).unwrap();
            }
            None => { tx.lock().unwrap().take(); }
        }
    };
    let (status, error) = tokio::time::timeout(Duration::from_secs(300), drive_session(&*client, &session, plan, next_stop, |_| {}, on_turn, async { std::future::pending::<()>().await })).await.expect("quá 5 phút");
    client.close();
    terminate_adapter(&mut child, pid).await;
    drop(launch);
    sink.emit(AgentEvent::new("live", AgentKind::Claude, "exit"));
    let asked = approver.await.unwrap();
    let events = sink.0.lock().unwrap().clone();
    eprintln!("status={status} error={error:?}\nmessage={}", message_of(&events));
    NativeRun { status, error, events, asked }
}

fn live_dir(name: &str) -> PathBuf {
    let dir = dunce::canonicalize(std::env::temp_dir()).unwrap().join(format!("tg-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    dir
}

/// The launch itself against the real CLI, without a prompt (0 tokens, no login needed):
/// the flags are accepted, the session id arrives, modes switch; `--resume` of a conversation
/// that is not on the machine fails to open instead of passing for that session.
/// `TG_LIVE_ACP=1 cargo test live_claude_native_opens -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_claude_native_opens_without_tokens() {
    use crate::acp::claude_conn::ClaudeConn;
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let dir = live_dir("native-open");
    let open = |resume: Option<&'static str>| {
        let dir = dir.clone();
        async move {
            let launch = native_launch(Arc::new(BridgeHub::default()), vec![], false, false, &std::env::temp_dir(), &mut Vec::new()).await.unwrap();
            let command = native_command(Approval::Deny, resume, launch.file.as_ref().map(|f| f.path()), &SessionPrefs::default()).unwrap();
            let mut child = spawn_adapter(&command, &dir).unwrap();
            let session = Arc::new(TaskSession::new("live", AgentKind::Claude, &dir, Arc::new(Recorder::default()), Arc::new(Rules)).unwrap());
            let client: Arc<dyn AgentConn> = ClaudeConn::start(child.stdout.take().unwrap(), child.stdin.take().unwrap(), session.clone());
            (child, session, client)
        }
    };
    let (mut child, session, client) = open(None).await;
    let init = client.initialize().await.unwrap();
    assert_eq!(init["agentCapabilities"]["loadSession"], true);
    let id = client.new_session(&dir, json!([])).await.unwrap();
    assert!(!id.is_empty());
    follow_mode(&session, &client);
    session.set_approval(Approval::Ask);
    session.set_approval(Approval::Auto);
    assert!(client.config_options().is_array(), "model lấy từ initialize: {}", client.config_options());
    client.close();
    let pid = child.id();
    terminate_adapter(&mut child, pid).await;

    let (mut child, _session, client) = open(Some("00000000-0000-4000-8000-000000000000")).await;
    let error = client.initialize().await.unwrap_err();
    eprintln!("resume thiếu: {error}");
    assert!(client.load_session("00000000-0000-4000-8000-000000000000", &dir, json!([])).await.is_err());
    client.close();
    let pid = child.id();
    terminate_adapter(&mut child, pid).await;
    let _ = std::fs::remove_dir_all(dir);
}

/// One `claude -p` for a whole conversation: the second question remembers the first.
/// `TG_LIVE_ACP=1 cargo test live_claude_native -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_claude_native_two_questions() {
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let dir = live_dir("native-two");
    let run = live_native(&dir, Approval::Deny, &["Remember the word PINEAPPLE. Reply with exactly: ok", "Which word did I ask you to remember? Reply with that word only."], |_| {}).await;
    assert_eq!(run.status, "done", "{:?}", run.error);
    assert!(message_of(&run.events).contains("PINEAPPLE"), "câu hai phải nhớ câu một");
    let usage = run.events.iter().rev().find_map(|e| e.usage.clone()).expect("phải có usage");
    assert!(usage.output_tokens > 0 && usage.cost_usd.is_some(), "{usage:?}");
    let _ = std::fs::remove_dir_all(dir);
}

/// Chỉ hỏi in the user's real folder: `plan` mode and the app's refusals keep it from writing,
/// whatever the CLI's own settings say.
/// `TG_LIVE_ACP=1 cargo test live_claude_native_read_only -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_claude_native_read_only_cannot_write() {
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let dir = live_dir("native-read-only");
    let run = live_native(&dir, Approval::Deny, &["Create a file named x.txt containing x in the current directory using your tools, then run the shell command `echo y > y.txt`."], |_| {}).await;
    assert!(run.asked.is_empty(), "Chỉ hỏi không hiện thẻ duyệt: {:?}", run.asked);
    assert!(!dir.join("x.txt").exists() && !dir.join("y.txt").exists(), "Chỉ hỏi đã ghi được vào thư mục thật (status {}, {:?})", run.status, run.error);
    let _ = std::fs::remove_dir_all(dir);
}

/// Chỉ hỏi → Hỏi trước in the same session: the agent remembers the question, the first
/// write shows a card, and once allowed the file is there.
/// `TG_LIVE_ACP=1 cargo test live_claude_native_mode_switch -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_claude_native_mode_switch_keeps_memory() {
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let dir = live_dir("native-switch");
    let questions = ["Remember the word PINEAPPLE. Do not use any tools. Reply with exactly: ok", "Now create a file named word.txt in the current directory whose only content is the word I asked you to remember. Use your file writing tool."];
    let run = live_native(&dir, Approval::Deny, &questions, |session| session.set_approval(Approval::Ask)).await;
    assert_eq!(run.status, "done", "{:?}", run.error);
    assert!(run.events.iter().any(|e| e.kind == "permission"), "Hỏi trước phải hiện thẻ duyệt");
    assert!(!run.asked.is_empty());
    let written = std::fs::read_to_string(dir.join("word.txt")).expect("tệp phải có sau khi cho phép");
    assert!(written.contains("PINEAPPLE"), "agent phải nhớ câu trước: {written:?}");
    let _ = std::fs::remove_dir_all(dir);
}

/// Read-only runs happen in the real folder, even with approvals off in the CLI's settings.
/// `TG_LIVE_ACP=1 TG_LIVE_AGENT=claude|codex cargo test live_read_only -- --ignored`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_read_only_run_cannot_write() {
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let agent = if std::env::var("TG_LIVE_AGENT").as_deref() == Ok("codex") { AgentKind::Codex } else { AgentKind::Claude };
    let dir = dunce::canonicalize(std::env::temp_dir()).unwrap().join(format!("tg-read-only-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let program = env::which(agent.binary()).expect("agent CLI");
    let (args, input) = agent.headless_invocation("Create a file named pwned.txt containing x in the current directory using your tools.", &program).unwrap();
    let mut child = env::command(program).args(args).current_dir(&dir).env("PATH", env::login_path())
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    // Claude reads the question from stdin; closing it ends the session after one answer.
    let mut stdin = child.stdin.take().unwrap();
    if let Some(text) = input { use tokio::io::AsyncWriteExt; stdin.write_all(text.as_bytes()).await.unwrap(); }
    drop(stdin);
    let output = child.wait_with_output().await.unwrap();
    eprintln!("{}", String::from_utf8_lossy(&output.stdout).lines().last().unwrap_or_default());
    assert!(!dir.join("pwned.txt").exists(), "chế độ Chỉ hỏi đã ghi được vào thư mục thật");
    let _ = std::fs::remove_dir_all(dir);
}

/// The M-D scenario: Claude and Codex on one prompt at once, then one result is used.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_claude_and_codex_in_parallel_use_one() {
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let repo = greeting_repo();
    let store = Store::open_in_memory().unwrap();
    let (claude, codex) = tokio::join!(
        run_live_agent(AgentKind::Claude, &store, &repo.0, GREETING_PROMPT, Some("nhom-m-d"), &[]),
        run_live_agent(AgentKind::Codex, &store, &repo.0, GREETING_PROMPT, Some("nhom-m-d"), &[]),
    );
    assert_eq!(claude.status, "done", "{:?}", claude.error);
    assert_eq!(codex.status, "done", "{:?}", codex.error);
    assert_ne!(claude.wt.path, codex.wt.path);
    assert!(diff::pending(&claude.wt).unwrap().iter().any(|f| f.path == "hello.txt"));
    assert!(diff::pending(&codex.wt).unwrap().iter().any(|f| f.path == "hello.txt"));
    diff::accept_all(&repo.0, &codex.wt).unwrap();
    assert!(!diff::commit(&repo.0, "Dùng bản của Codex").unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello ACP\n");
    worktree::remove(&repo.0, &claude.wt, true).unwrap();
    worktree::remove(&repo.0, &codex.wt, true).unwrap();
}

/// Phase 2: two Claude runs on one prompt at once, in one group. Each works in its own
/// worktree; "Use this" takes one whole, and the other no longer applies cleanly.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_claude_parallel_group_use_one() {
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let repo = Repo::new();
    repo.write("hello.txt", "Hello world\n");
    worktree::git(&repo.0, &["add", "."], None).unwrap();
    worktree::git(&repo.0, &["commit", "-m", "hello"], None).unwrap();
    let store = Store::open_in_memory().unwrap();
    let prompt = |word: &str| format!("Edit hello.txt so that its only line reads exactly `Hello {word}` (keep the trailing newline). Do not run any other command and do not commit.");
    let (prompt_a, prompt_b) = (prompt("A"), prompt("B"));
    let (a, b) = tokio::join!(run_live(&store, &repo.0, &prompt_a, Some("group-live")), run_live(&store, &repo.0, &prompt_b, Some("group-live")));
    for run in [&a, &b] { assert_eq!(run.status, "done", "{:?} {}", run.error, message_of(&run.events)); }
    assert_ne!(a.wt.path, b.wt.path);
    assert_ne!(a.wt.branch, b.wt.branch);
    let runs = store.list_runs(10).unwrap();
    assert_eq!(runs.len(), 2);
    assert!(runs.iter().all(|r| r.group.as_deref() == Some("group-live")));
    assert_eq!(std::fs::read_to_string(a.wt.path.join("hello.txt")).unwrap(), "Hello A\n");
    assert_eq!(std::fs::read_to_string(b.wt.path.join("hello.txt")).unwrap(), "Hello B\n");
    assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello world\n");
    assert_eq!(diff::accept_all(&repo.0, &b.wt).unwrap(), 1);
    diff::commit(&repo.0, "Dùng bản B").unwrap();
    assert_eq!(std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(), "Hello B\n");
    // The losing run touched the same line, so it cannot be applied on top any more.
    assert!(diff::accept_all(&repo.0, &a.wt).is_err());
    assert!(worktree::git(&repo.0, &["status", "--porcelain"], None).unwrap().is_empty());
    for run in [a, b] { worktree::remove(&repo.0, &run.wt, true).unwrap(); }
    assert!(worktree::list(&repo.0).unwrap().is_empty());
}

#[tokio::test]
async fn direct_place_works_in_the_folder_and_failure_never_deletes_it() {
    let repo = Repo::new();
    let store = Store::open_in_memory().unwrap();
    let missing = repo.0.join("missing-adapter");
    assert!(prepare(&store, AgentKind::Codex, "fix", &repo.0, Adapter::Spawn((missing, vec![])), None, None, Place::Direct).await.is_err());
    assert!(repo.0.join("file.txt").exists(), "a failed start must not touch the user's folder");
    let (id, wt, mut child, _) = prepare(&store, AgentKind::Codex, "fix", &repo.0, Adapter::Spawn((PathBuf::from(if cfg!(windows) { "cmd" } else { "true" }), vec![])), None, None, Place::Direct).await.unwrap();
    assert!(wt.is_direct());
    let (stored_repo, stored) = store.run_worktree(&id).unwrap();
    assert_eq!(stored, wt);
    assert_eq!(dunce::canonicalize(stored.path).unwrap(), dunce::canonicalize(stored_repo).unwrap());
    let _ = child.wait().await;
    // A draft from a branch that does not exist is refused before anything is created.
    let error = prepare(&store, AgentKind::Codex, "fix", &repo.0, Adapter::Spawn((PathBuf::from("true"), vec![])), None, None, Place::Draft(Some("--force".into()))).await.err().unwrap();
    assert!(error.contains("Không tìm thấy nhánh"), "{error}");
}

#[tokio::test]
async fn reused_worktree_run_keeps_its_own_id() {
    let repo = Repo::new();
    let store = Store::open_in_memory().unwrap();
    let wt = repo.wt();
    store.insert_run_with_worktree(&NewRun { id: &wt.run_id, agent: AgentKind::Claude, prompt: "plan", cwd: wt.path.to_str().unwrap(), started_at: 1 }, repo.0.to_str().unwrap(), &wt, None).unwrap();
    store.finish_run(&wt.run_id, "done", Some(0), 2).unwrap();
    let missing = repo.0.join("missing-adapter");
    assert!(prepare(&store, AgentKind::Codex, "build", &repo.0, Adapter::Spawn((missing, vec![])), None, Some(wt.clone()), Place::Draft(None)).await.is_err());
    assert!(wt.path.exists(), "a failed later step must not delete the shared worktree");
    assert_eq!(store.list_runs(10).unwrap().len(), 1);
    let (id, shared_wt, mut child, _) = prepare(&store, AgentKind::Codex, "build", &repo.0, Adapter::Spawn((PathBuf::from(if cfg!(windows) { "cmd" } else { "true" }), vec![])), None, Some(wt.clone()), Place::Draft(None)).await.unwrap();
    assert_ne!(id, wt.run_id);
    assert_eq!(shared_wt, wt);
    assert_eq!(store.run_worktree(&id).unwrap().1.run_id, wt.run_id);
    store.finish_run(&id, "failed", None, 3).unwrap();
    let _ = child.wait().await;
    let runs = store.list_runs(10).unwrap();
    assert_eq!(runs.len(), 2);
    assert!(runs.iter().all(|r| r.worktree.as_deref() == wt.path.to_str()));
    let original = runs.iter().find(|r| r.id == wt.run_id).unwrap();
    assert_eq!(original.status, "done");
    assert_eq!(original.prompt, "plan");
    let later = runs.iter().find(|r| r.id == id).unwrap();
    assert_eq!(later.status, "failed");
    assert_eq!(later.prompt, "build");
    let (root, shared) = store.run_worktree(&later.id).unwrap();
    worktree::remove(&root, &shared, true).unwrap();
    store.clear_run_worktree(&later.id).unwrap();
    assert!(store.run_worktree(&wt.run_id).is_err());
}

/// Phase 3: an MCP server from the registry reaches a real Claude ACP session.
/// Uses `tests/fixtures/mcp/ping-server.js` (needs `node`).
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_claude_acp_uses_registry_mcp_server() {
    if std::env::var("TG_LIVE_ACP").is_err() { return; }
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp/ping-server.js").to_string_lossy().into_owned();
    let repo = Repo::new();
    let store = Store::open_in_memory().unwrap();
    let servers = [McpServer { id: "1".into(), name: "tg-ping".into(), transport: "stdio".into(), command: Some("node".into()), args: vec![script],
        env: vec![], url: None, headers: vec![], agents: vec![AgentKind::Claude] }];
    let run = run_live_with(&store, &repo.0, "Call the ping tool from the tg-ping MCP server and reply with exactly what it returned. Do not edit files.", None, &servers).await;
    let message = message_of(&run.events);
    assert_eq!(run.status, "done", "{:?}", run.error);
    assert!(message.contains("pong from tg-ping"), "{message}");
    let new = run.traffic.iter().find(|m| m["msg"]["method"] == "session/new").unwrap();
    assert_eq!(new["msg"]["params"]["mcpServers"][0]["name"], "tg-ping");
    worktree::remove(&repo.0, &run.wt, true).unwrap();
}

/// tg-bridge end to end with real Claude: the built app binary runs as the MCP server
/// (`--mcp-bridge`) and forwards to an in-process hub.
/// `cargo build && TG_LIVE_ACP=1 TG_BRIDGE_EXE=target/debug/tg-studio cargo test live_claude_tg_bridge -- --ignored`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_claude_tg_bridge_notes_and_progress() {
    let (Ok(_), Ok(exe)) = (std::env::var("TG_LIVE_ACP"), std::env::var("TG_BRIDGE_EXE")) else { return };
    struct Env { store: Store, events: Mutex<Vec<serde_json::Value>> }
    impl ToolEnv for Env {
        fn emit(&self, data: serde_json::Value, _: String) { self.events.lock().unwrap().push(data); }
        fn add_note(&self, topic: &str, text: &str) -> Result<(), String> { self.store.add_note("task", topic, text, "r", AgentKind::Claude, 1).map_err(|e| e.to_string()) }
        fn notes(&self, topic: Option<&str>) -> Result<Vec<(String, String, u64, String)>, String> { self.store.notes("task", topic).map_err(|e| e.to_string()) }
        fn approve(&self, _: String, _: String) -> bridge::BoxFuture<bool> { Box::pin(async { false }) }
        fn context(&self) -> serde_json::Value { json!({ "task": "live test" }) }
    }
    let hub = Arc::new(BridgeHub::default());
    let addr = hub.address().await.unwrap();
    let env = Arc::new(Env { store: Store::open_in_memory().unwrap(), events: Mutex::new(vec![]) });
    let token = hub.register(env.clone());
    let servers = [McpServer {
        id: "b".into(), name: bridge::SERVER_NAME.into(), transport: "stdio".into(), command: Some(exe), args: vec![bridge::FLAG.into()],
        env: vec![mcp::NameValue { name: "TG_BRIDGE_ADDR".into(), value: addr }, mcp::NameValue { name: "TG_BRIDGE_TOKEN".into(), value: token }],
        url: None, headers: vec![], agents: vec![AgentKind::Claude],
    }];
    let repo = Repo::new();
    let store = Store::open_in_memory().unwrap();
    let prompt = "Use the tg-bridge MCP tools only, do not edit files. 1) write_note with topic \"plan\" and text \"Buoc 1: doc README\". 2) report_progress with step \"da ghi chu\" and pct 50. 3) read_notes and reply with exactly the note text you read.";
    let run = run_live_with(&store, &repo.0, prompt, None, &servers).await;
    let message = message_of(&run.events);
    assert_eq!(run.status, "done", "{:?}", run.error);
    assert!(message.contains("Buoc 1: doc README"), "{message}");
    assert_eq!(env.store.notes("task", Some("plan")).unwrap()[0].3, "Buoc 1: doc README");
    assert!(env.events.lock().unwrap().iter().any(|e| e["tool"] == "report_progress" && e["pct"] == 50.0), "{:?}", env.events.lock().unwrap());
    worktree::remove(&repo.0, &run.wt, true).unwrap();
}

#[tokio::test]
async fn invalid_and_uncommitted_repos_never_create_runs() {
    let path = std::env::temp_dir().join(format!("tg-invalid-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let store = Store::open_in_memory().unwrap();
    let missing = path.join("missing");
    let error = prepare(&store, AgentKind::Codex, "task", &path, Adapter::Spawn((missing.clone(), vec![])), None, None, Place::Draft(None)).await.err().unwrap();
    assert!(error.contains("Git"));
    worktree::git(&path, &["init"], None).unwrap();
    let error = prepare(&store, AgentKind::Codex, "task", &path, Adapter::Spawn((missing, vec![])), None, None, Place::Draft(None)).await.err().unwrap();
    assert!(error.contains("commit"));
    assert!(store.list_runs(10).unwrap().is_empty());
    assert!(!path.join(".tg").exists());
    std::fs::remove_dir_all(path).unwrap();
}

// Setup script of a new draft: runs before the adapter starts, can fail or be stopped.
fn setup<'a>(command: &'a str, sink: &Arc<Recorder>, stops: &'a crate::tasks::headless::Runs) -> Option<Setup<'a>> {
    Some(Setup { command, sink: sink.clone(), stops })
}

#[cfg(unix)]
#[tokio::test]
async fn setup_runs_before_agent_spawn() {
    let repo = Repo::new();
    let store = Store::open_in_memory().unwrap();
    let sink = Arc::new(Recorder::default());
    let stops = crate::tasks::headless::Runs::default();
    let adapter = Adapter::Spawn((PathBuf::from("sh"), vec!["-c".into(), "test -f ready && touch seen".into()]));
    let (id, wt, mut child, _) = prepare_with(&store, AgentKind::Codex, "task", &repo.0, adapter, None, None, Place::Draft(None),
        setup("echo hi > ready", &sink, &stops), None).await.unwrap();
    let _ = child.wait().await;
    assert!(wt.path.join("seen").exists(), "adapter must start after the setup script");
    let lines: Vec<String> = sink.0.lock().unwrap().iter().filter_map(|e| e.line.clone()).collect();
    assert!(lines.iter().any(|l| l.contains("Đã chuẩn bị bản nháp")), "{lines:?}");
    assert_eq!(store.list_runs(10).unwrap().iter().filter(|r| r.id == id).count(), 1);
    assert!(stops.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn failed_setup_never_spawns_agent() {
    let repo = Repo::new();
    let store = Store::open_in_memory().unwrap();
    let sink = Arc::new(Recorder::default());
    let stops = crate::tasks::headless::Runs::default();
    let missing = repo.0.join("missing-adapter");
    let error = prepare_with(&store, AgentKind::Codex, "task", &repo.0, Adapter::Spawn((missing, vec![])), None, None, Place::Draft(None),
        setup("echo broken; exit 3", &sink, &stops), None).await.err().unwrap();
    assert!(error.contains("mã 3"), "{error}");
    assert!(!error.contains("Không chạy được"), "the adapter must not be started: {error}");
    let events = sink.0.lock().unwrap();
    assert!(events.iter().any(|e| e.line.as_deref().is_some_and(|l| l.contains("broken"))));
    assert_eq!(events.last().unwrap().kind, "exit");
    assert_eq!(store.list_runs(10).unwrap()[0].status, "failed");
}

#[cfg(unix)]
#[tokio::test]
async fn stop_during_setup_never_spawns_agent() {
    let repo = Repo::new();
    let store = Store::open_in_memory().unwrap();
    let sink = Arc::new(Recorder::default());
    let stops = Arc::new(crate::tasks::headless::Runs::default());
    let stopper = stops.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let tx = stopper.0.lock().unwrap().drain().next();
            if let Some((_, tx)) = tx { let _ = tx.send(()); break; }
        }
    });
    let started = std::time::Instant::now();
    let missing = repo.0.join("missing-adapter");
    let error = prepare_with(&store, AgentKind::Codex, "task", &repo.0, Adapter::Spawn((missing, vec![])), None, None, Place::Draft(None),
        setup("sleep 30", &sink, &stops), None).await.err().unwrap();
    assert!(error.contains("Đã dừng"), "{error}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(store.list_runs(10).unwrap()[0].status, "stopped");
    assert_eq!(sink.0.lock().unwrap().last().unwrap().code, None);
}

#[tokio::test]
async fn direct_and_reuse_skip_setup() {
    let repo = Repo::new();
    let store = Store::open_in_memory().unwrap();
    let sink = Arc::new(Recorder::default());
    let stops = crate::tasks::headless::Runs::default();
    let missing = repo.0.join("missing-adapter");
    let error = prepare_with(&store, AgentKind::Codex, "fix", &repo.0, Adapter::Spawn((missing, vec![])), None, None, Place::Direct,
        setup("exit 3", &sink, &stops), None).await.err().unwrap();
    assert!(error.contains("Không chạy được"), "direct runs must not run the setup script: {error}");
    assert!(sink.0.lock().unwrap().is_empty());
}
