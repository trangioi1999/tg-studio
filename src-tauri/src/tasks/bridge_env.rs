//! What tg-bridge tools can do for one task run: notes, approvals, context, and delegating to another agent.

use super::*;

/// What tg-bridge tools can reach for one task run.
pub(super) struct TaskEnv {
    pub(super) app: AppHandle,
    pub(super) run_id: String,
    pub(super) agent: AgentKind,
    /// Notes are shared by the runs of one task: a parallel group or a pipeline's worktree.
    pub(super) scope: String,
    pub(super) prompt: String,
    pub(super) group: Option<String>,
    pub(super) wt: Worktree,
    pub(super) sink: Arc<dyn EventSink>,
    pub(super) session: Arc<TaskSession>,
    pub(super) repo: PathBuf,
    pub(super) thread: Option<String>,
    pub(super) subfolder: Option<String>,
    /// Working on a piece another agent delegated: it cannot delegate further.
    pub(super) child: bool,
}

impl TaskEnv {
    /// A delegation event in the parent's log, for the UI's nested block.
    fn emit_delegation(&self, kind: &str, d: &crate::tasks::delegate::Delegation) {
        let mut data = serde_json::to_value(d).unwrap_or_default();
        data["tool"] = kind.into();
        let line = match kind {
            "delegate" => format!("◆ tg-bridge · giao cho {}: {}", d.agent.display_name(), d.task.chars().take(120).collect::<String>()),
            _ => format!("◆ tg-bridge · {} {}: {}", d.agent.display_name(), d.status, d.task.chars().take(80).collect::<String>()),
        };
        self.emit(data, line);
    }
}

impl ToolEnv for TaskEnv {
    fn emit(&self, data: serde_json::Value, line: String) {
        let mut event = AgentEvent::new(&self.run_id, self.agent, "bridge");
        event.data = Some(data);
        event.line = Some(line);
        self.sink.emit(event);
    }
    fn add_note(&self, topic: &str, text: &str) -> Result<(), String> {
        self.app.state::<Store>().add_note(&self.scope, topic, text, &self.run_id, self.agent, crate::system::clock::now_ms()).map_err(|e| format!("Không lưu được ghi chú: {e}"))
    }
    fn notes(&self, topic: Option<&str>) -> Result<Vec<(String, String, u64, String)>, String> {
        self.app.state::<Store>().notes(&self.scope, topic).map_err(|e| format!("Không đọc được ghi chú: {e}"))
    }
    fn approve(&self, action: String, reason: String) -> bridge::BoxFuture<bool> {
        self.session.ask(action, reason)
    }
    fn context(&self) -> serde_json::Value {
        let changed: Vec<String> = diff::exclusive(&self.wt, || diff::pending(&self.wt)).map(|files| files.into_iter().map(|f| format!("{} {}", f.status, f.path)).collect()).unwrap_or_default();
        json!({
            "task": self.prompt, "agent": self.agent, "runId": self.run_id, "worktree": self.wt.path,
            "parallelGroup": self.group, "sharedWithPipelineStepsOf": (self.wt.run_id != self.run_id).then_some(&self.wt.run_id),
            "changedFiles": changed,
            "rules": if self.child {
                "Chỉ làm đúng phần được giao, trong thư mục này. Không push hay merge. Không giao việc tiếp cho agent khác."
            } else {
                "Chỉ sửa tệp trong worktree. Không push hay merge. Việc ngoài phạm vi phải qua người dùng (request_approval). Phần việc độc lập có thể giao cho agent khác bằng delegate."
            },
        })
    }
    fn delegate(&self, agent: AgentKind, task: String, files: Vec<String>) -> bridge::BoxFuture<Result<Value, String>> {
        use crate::tasks::delegate::{Delegation, Delegations, MAX_RUNNING};
        if self.child { return Box::pin(async { Err("Agent được giao việc không giao tiếp cho agent khác được.".to_string()) }); }
        let approval = self.session.approval();
        if approval == Approval::Deny { return Box::pin(async { Err("Ở chế độ Chỉ hỏi không giao việc cho agent khác được.".to_string()) }); }
        let all = self.app.state::<Arc<Delegations>>().inner().clone();
        let mut d = Delegation {
            id: uuid::Uuid::new_v4().to_string(), parent: self.run_id.clone(), child: None, agent, task: task.clone(),
            status: if approval == Approval::Ask { "waiting_approval" } else { "running" }.into(),
            summary: None, files_changed: vec![], conflicts: vec![], worktree: None, child_wt: None,
        };
        if all.running(&self.run_id) >= MAX_RUNNING {
            d.status = "refused".into();
            d.summary = Some(format!("Đã có {MAX_RUNNING} việc con đang chạy. Hãy chờ bớt (wait_delegated) hoặc tự làm phần này."));
            return Box::pin(async move { Ok(d.report()) });
        }
        if agent.acp_command(env::which).is_none() {
            d.status = "refused".into();
            d.summary = Some(format!("{} chưa cài trên máy này; hãy tự làm phần này.", agent.display_name()));
            return Box::pin(async move { Ok(d.report()) });
        }
        let me = TaskEnv { app: self.app.clone(), run_id: self.run_id.clone(), agent: self.agent, scope: self.scope.clone(), prompt: self.prompt.clone(),
            group: self.group.clone(), wt: self.wt.clone(), sink: self.sink.clone(), session: self.session.clone(), repo: self.repo.clone(),
            thread: self.thread.clone(), subfolder: self.subfolder.clone(), child: false };
        Box::pin(async move {
            all.insert(d.clone());
            me.emit_delegation("delegate", &d);
            let fail = |status: &str, why: String| {
                let d = all.update(&d.id, |x| { x.status = status.into(); x.summary = Some(why); });
                if let Some(d) = &d { me.emit_delegation("delegate_done", d); }
                Ok(d.map(|d| d.report()).unwrap_or_default())
            };
            if approval == Approval::Ask {
                let short: String = task.chars().take(200).collect();
                if !me.session.ask(format!("Giao cho {}: {short}", agent.display_name()), "agent muốn chia việc để làm song song".into()).await {
                    return fail("refused", "Người dùng không cho giao việc này; hãy tự làm phần này.".into());
                }
                all.update(&d.id, |x| x.status = "running".into());
            }
            // The user works in their own folder: the child does too, on its part of the files.
            // Only a conversation in a draft gives the child a draft of its own, merged back after.
            let in_place = me.wt.is_direct();
            let base = if in_place { None } else {
                match crate::tasks::delegate::snapshot(&me.wt.path) {
                    Ok(c) => Some(c),
                    Err(e) => return fail("failed", e),
                }
            };
            let listed = if files.is_empty() { String::new() } else { format!("\n\nTệp liên quan: {}", files.join(", ")) };
            let shared = if in_place { " Agent khác đang làm cùng thư mục này: chỉ sửa các tệp của phần mình, không hoàn tác hay commit." } else { "" };
            let prompt = format!("{task}{listed}\n\n(Việc được {} giao qua TG Studio. Chỉ làm đúng phần này, trong thư mục hiện tại.{shared} Xong thì tóm tắt ngắn những gì đã làm.)", me.agent.display_name());
            let (done_tx, done_rx) = oneshot::channel();
            let spec = ChildSpec { parent: me.run_id.clone(), snapshot: base.clone(), done: done_tx };
            let request = TaskRequest {
                single_turn: Some(true), thread: me.thread.clone(), scope: me.subfolder.clone(), approval: Some(approval), child: Some(spec),
                ..TaskRequest::new(agent, prompt, me.repo.to_string_lossy().into_owned())
            };
            let started = start_task_with(me.app.clone(), request).await;
            let child_id = match started {
                Ok(id) => id,
                Err(e) => return fail("failed", e),
            };
            let child_wt = me.app.state::<Store>().run_worktree(&child_id).map(|(_, wt)| wt).ok();
            // In place, its edits are already in the parent's folder: no draft to show or merge.
            let draft = child_wt.clone().filter(|w| !w.is_direct());
            let d = all.update(&d.id, |x| { x.child = Some(child_id.clone()); x.worktree = draft.as_ref().map(|w| w.path.clone()); x.child_wt = draft.clone(); })
                .ok_or("Không tìm thấy việc đã giao.")?;
            me.emit_delegation("delegate", &d);
            let report = d.report();
            let id = d.id.clone();
            tauri::async_runtime::spawn(async move {
                let (status, reply) = done_rx.await.unwrap_or_else(|_| ("failed".into(), String::new()));
                let summary: String = reply.trim().chars().take(crate::tasks::delegate::MAX_SUMMARY).collect();
                let summary = (!summary.is_empty()).then_some(summary);
                if let Some(wt) = child_wt.as_ref().filter(|w| w.is_direct()) {
                    // Only its bookkeeping goes; the parent's review already shows these edits.
                    if let Err(e) = worktree::remove(&me.repo, wt, false) { eprintln!("Không dọn được sổ của việc con: {e}"); }
                    let _ = me.app.state::<Store>().clear_run_worktree(&child_id);
                }
                let outcome = match (&draft, status.as_str(), &base) {
                    (None, "done", _) => ("done", vec![], vec![], None),
                    (Some(wt), "done", Some(base)) => match crate::tasks::delegate::merge_back(&me.wt.path, wt, base) {
                        Ok(merged) if merged.conflicts.is_empty() => {
                            if let Err(e) = worktree::remove(&me.repo, wt, true) { eprintln!("Không dọn được bản nháp của việc con: {e}"); }
                            let _ = me.app.state::<Store>().clear_run_worktree(&child_id);
                            ("done", merged.applied, vec![], None)
                        }
                        Ok(merged) => ("conflict", merged.applied, merged.conflicts, None),
                        Err(e) => ("failed", vec![], vec![], Some(format!("Không gộp được kết quả: {e}"))),
                    },
                    (wt, other, _) => {
                        if let Some(wt) = wt {
                            if let Err(e) = worktree::remove(&me.repo, wt, true) { eprintln!("Không dọn được bản nháp của việc con: {e}"); }
                            let _ = me.app.state::<Store>().clear_run_worktree(&child_id);
                        }
                        (if other == "stopped" { "stopped" } else { "failed" }, vec![], vec![], None)
                    }
                };
                let (st, applied, conflicts, error) = outcome;
                let d = all.update(&id, |x| {
                    x.status = st.into();
                    x.files_changed = applied;
                    x.conflicts = conflicts;
                    x.summary = error.or(summary);
                    if st != "conflict" { x.worktree = None; x.child_wt = None; }
                });
                if let Some(d) = d { me.emit_delegation("delegate_done", &d); }
            });
            Ok(report)
        })
    }
    fn wait_delegated(&self, ids: Vec<String>, timeout: Duration) -> bridge::BoxFuture<Result<Value, String>> {
        let all = self.app.state::<Arc<crate::tasks::delegate::Delegations>>().inner().clone();
        let parent = self.run_id.clone();
        Box::pin(async move {
            let list = all.wait(&parent, &ids, timeout).await;
            if list.is_empty() { return Err("Chưa giao việc nào (hoặc mã việc không đúng).".into()); }
            Ok(Value::Array(list.iter().map(|d| d.report()).collect()))
        })
    }
    fn resolve_delegated(&self, id: String) -> Result<String, String> {
        let all = self.app.state::<Arc<crate::tasks::delegate::Delegations>>().inner().clone();
        let d = all.get(&id).filter(|d| d.parent == self.run_id).ok_or("Không có việc con này.")?;
        if d.status != "conflict" { return Ok("Việc này không có xung đột cần gộp.".into()); }
        if let Some(wt) = &d.child_wt { worktree::remove(&self.repo, wt, true)?; }
        if let Some(child) = &d.child { let _ = self.app.state::<Store>().clear_run_worktree(child); }
        let d = all.update(&id, |x| { x.status = "done".into(); x.worktree = None; x.child_wt = None; }).ok_or("Không có việc con này.")?;
        self.emit_delegation("delegate_done", &d);
        Ok("Đã dọn bản nháp của việc con.".into())
    }
}

/// A run another agent started through tg-bridge `delegate`.
pub(crate) struct ChildSpec {
    pub(super) parent: String,
    /// The snapshot of the parent's folder its draft starts from; `None`: it works right in
    /// the user's folder, like its parent.
    pub(super) snapshot: Option<String>,
    /// Status and last message, once the run has ended.
    pub(super) done: oneshot::Sender<(String, String)>,
}

/// tg-bridge is on unless the user turned it off in Integrations.
pub(crate) fn bridge_enabled(store: &Store) -> bool {
    store.setting("bridge").ok().flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v["enabled"].as_bool()).unwrap_or(true)
}

/// The tg-bridge MCP server entry of one session.
pub(crate) fn bridge_server(agent: AgentKind, exe: String, addr: String, token: String, child: bool) -> McpServer {
    let mut env = vec![mcp::NameValue { name: "TG_BRIDGE_ADDR".into(), value: addr }, mcp::NameValue { name: "TG_BRIDGE_TOKEN".into(), value: token }];
    if child { env.push(mcp::NameValue { name: "TG_BRIDGE_CHILD".into(), value: "1".into() }); }
    McpServer {
        id: bridge::SERVER_NAME.into(), name: bridge::SERVER_NAME.into(), transport: "stdio".into(),
        command: Some(exe), args: vec![bridge::FLAG.into()],
        env,
        url: None, headers: vec![], agents: vec![agent],
    }
}
