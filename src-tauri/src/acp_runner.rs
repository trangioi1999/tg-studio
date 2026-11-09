//! ACP request routing without a desktop runtime, shared by real and fake agents.
use std::{collections::{HashMap, VecDeque}, path::Path, sync::{Arc, Mutex}};
use std::sync::atomic::{AtomicBool,Ordering};
use serde_json::{json, Value};
use tokio::sync::oneshot;
use crate::{acp::{client::{ClientHandler, HandlerFuture, method_not_found}, handlers::{Sandbox, Terminals}}, adapters::AgentKind, policy::{self, Verdict}, runner::AgentEvent};

pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, ev: AgentEvent);
    /// A run for one of the agent's own subagents, nested in `parent`; saved before its events.
    fn child_run(&self, _id: &str, _parent: &str, _agent: AgentKind, _title: &str) {}
    /// That subagent run ended ("done" or "stopped").
    fn child_finished(&self, _id: &str, _status: &str) {}
}
pub trait RuleMemory: Send + Sync + 'static {
    fn rules(&self) -> Result<Vec<String>, String>;
    fn add(&self, rule: &str) -> Result<(), String>;
}
struct Pending { reply: oneshot::Sender<Value>, tool: Value, options: Vec<Value> }
#[derive(Default)]
struct Permissions { closed: bool, pending: HashMap<String, Pending> }
#[derive(Default)]
struct EventQueue { emitting: bool, queued: VecDeque<AgentEvent> }
pub struct TaskSession {
    run_id: String,
    agent: AgentKind,
    cwd: std::path::PathBuf,
    sink: Arc<dyn EventSink>,
    rules: Arc<dyn RuleMemory>,
    sandbox: Arc<Sandbox>,
    terminals: Terminals,
    permissions: Mutex<Permissions>,
    events: Mutex<EventQueue>,
    events_idle: tokio::sync::Notify,
    operation_gate: Arc<tokio::sync::Mutex<bool>>,
    last_cost: Mutex<Option<f64>>,
    /// Tokens of the finished turns of this run; the adapter reports each turn on its own.
    totals: Mutex<(u64,u64,u64)>,
    /// A reopened session keeps counting cost from where it was; this run owes only the rest.
    cost_base: Mutex<f64>,
    /// While a reopened session replays itself, nothing of it belongs to this run.
    muted: AtomicBool,
    busy: AtomicBool,
    approval: Mutex<Approval>,
    /// The agent's latest message, and whether a tool call ended it (the next chunk starts anew).
    reply: Mutex<(String, bool)>,
    /// The agent's own subagents (ACP child sessions): session id → (run id, still working).
    subagents: Mutex<HashMap<String, (String, bool)>>,
}

/// How permission requests are answered. `Ask` shows a card; `Auto` allows without asking
/// (forbidden commands stay forbidden); `Deny` refuses everything and every file write,
/// for questions asked of agents without a read-only CLI flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Approval { #[default] Ask, Auto, Deny }
fn cancelled() -> Value { json!({"outcome":{"outcome":"cancelled"}}) }
fn selected(option: &str) -> Value { json!({"outcome":{"outcome":"selected","optionId":option}}) }
impl TaskSession {
    pub fn new(run_id:&str, agent:AgentKind, root:&Path, sink:Arc<dyn EventSink>, rules:Arc<dyn RuleMemory>) -> Result<Self,String> {
        let sandbox = Arc::new(Sandbox::new(root)?);
        Ok(Self {run_id:run_id.into(),agent,cwd:root.to_path_buf(),sink,rules,terminals:Terminals::new(sandbox.clone()),sandbox,permissions:Mutex::default(),events:Mutex::default(),events_idle:tokio::sync::Notify::new(),operation_gate:Arc::new(tokio::sync::Mutex::new(false)),last_cost:Mutex::new(None),totals:Mutex::default(),cost_base:Mutex::new(0.0),muted:AtomicBool::new(false),busy:AtomicBool::new(false),approval:Mutex::new(Approval::Ask),reply:Mutex::default(),subagents:Mutex::default()})
    }
    fn queue(&self, event:AgentEvent) { self.events.lock().unwrap().queued.push_back(event); }
    pub fn set_approval(&self, approval:Approval) { *self.approval.lock().unwrap() = approval; }
    pub fn approval(&self) -> Approval { *self.approval.lock().unwrap() }
    /// The agent's latest message: a delegated agent's summary for its parent.
    pub fn last_reply(&self) -> String { self.reply.lock().unwrap().0.clone() }
    pub fn agent(&self) -> AgentKind { self.agent }
    /// An approval card for something an agent asked through tg-bridge. True only if allowed.
    pub fn ask(&self, action:String, reason:String) -> crate::bridge::BoxFuture<bool> {
        let card = self.permission(json!({
            "toolCall": {"title": format!("{action} — lý do: {reason}"), "kind": "other", "rawInput": {"source": "tg-bridge"}},
            "options": [{"optionId":"allow","name":"Cho phép","kind":"allow_once"},{"optionId":"deny","name":"Từ chối","kind":"reject_once"}],
        }));
        Box::pin(async move { matches!(card.await, Ok(v) if v["outcome"]["optionId"] == "allow") })
    }
    /// A line from TG Studio itself in the run's log (shown like stderr).
    pub fn note(&self, text:String) {
        let mut event=AgentEvent::new(&self.run_id,self.agent,"stderr"); event.line=Some(text); self.queue(event); self.flush_events();
    }
    fn queue_data(&self, kind:&'static str, data:Value) {
        let mut event=AgentEvent::new(&self.run_id,self.agent,kind);event.data=Some(data);self.queue(event);
    }
    // Deliver outside state locks. Reentrant sinks enqueue behind the current event.
    fn flush_events(&self) {
        let mut events=self.events.lock().unwrap();
        if events.emitting {return;}
        events.emitting=true;
        loop {
            match events.queued.pop_front() {
                Some(event) => {drop(events);self.sink.emit(event);events=self.events.lock().unwrap();}
                None => {events.emitting=false;self.events_idle.notify_waiters();break;}
            }
        }
    }
    pub fn respond_permission(&self, request_id:&str, option_id:&str, always:bool)->Result<(),String> {
        let mut permissions = self.permissions.lock().unwrap();
        let pending = permissions.pending.get(request_id).ok_or("Yêu cầu duyệt đã kết thúc.")?;
        let option = pending.options.iter().find(|o|o["optionId"] == option_id).ok_or("Lựa chọn không hợp lệ.")?;
        if always && matches!(option["kind"].as_str(), Some("allow_once" | "allow_always")) {
            let tool = policy::tool_info(&pending.tool);
            if tool.kind == "execute" {
                if let Some(rule) = tool.command.as_deref().and_then(policy::rule_for) { self.rules.add(&rule)?; }
            }
        }
        let pending = permissions.pending.remove(request_id).unwrap();
        let outcome = selected(option_id);
        let _ = pending.reply.send(outcome.clone());
        self.queue_data("permission_resolved",json!({"requestId":request_id,"outcome":outcome["outcome"]}));
        drop(permissions);
        self.flush_events();
        Ok(())
    }
    /// Stops accepting permission requests too, covering requests queued during shutdown.
    pub fn cancel_pending(&self) {
        let mut permissions = self.permissions.lock().unwrap();
        permissions.closed = true;
        for (id,pending) in permissions.pending.drain() {
            let _ = pending.reply.send(cancelled());
            self.queue_data("permission_resolved",json!({"requestId":id,"outcome":{"outcome":"cancelled"}}));
        }
        drop(permissions);
        self.flush_events();
    }
    /// A stopped turn closes the session to cards and updates; the next turn of a session
    /// that is still alive opens it again. Without this, every later permission request was
    /// answered "cancelled" (the agent saw "Tool use aborted") and its replies were dropped.
    pub fn reopen(&self) {
        if let Ok(gate) = self.operation_gate.try_lock() { if *gate { return; } }
        self.permissions.lock().unwrap().closed = false;
    }
    pub fn set_muted(&self, muted:bool) { self.muted.store(muted,Ordering::SeqCst); }
    pub fn set_cost_base(&self, base:f64) { *self.cost_base.lock().unwrap()=base; }
    pub fn is_busy(&self) -> bool { self.busy.load(Ordering::SeqCst) }
    /// The folder the agent works in.
    pub fn root(&self) -> &Path { &self.cwd }
    pub fn set_busy(&self, busy:bool) { self.busy.store(busy,Ordering::SeqCst); }
    /// True for the one caller that may start the next turn.
    pub fn claim_turn(&self) -> bool { self.busy.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_ok() }
    fn with_totals(&self, mut usage:crate::usage::Usage) -> crate::usage::Usage {
        let t=*self.totals.lock().unwrap();
        usage.input_tokens=t.0; usage.cached_input_tokens=t.1; usage.output_tokens=t.2;
        usage
    }
    /// Token counts arrive only with the prompt result, per turn; keep the last reported cost with them.
    pub fn turn_finished(&self, result:&Value) {
        let cost = *self.last_cost.lock().unwrap();
        if let Some(usage) = crate::usage::parse_acp_turn(result, cost) {
            {
                let mut t=self.totals.lock().unwrap();
                t.0+=usage.input_tokens; t.1+=usage.cached_input_tokens; t.2+=usage.output_tokens;
            }
            let usage=self.with_totals(usage);
            let mut event = AgentEvent::new(&self.run_id,self.agent,"usage");
            event.usage = Some(usage); self.queue(event); self.flush_events();
        }
    }
    /// A subagent announced or changed state: open its nested run, or end it when idle.
    fn subagent_update(&self, update:&Value) {
        let Some(sid) = update["sessionId"].as_str() else { return };
        let state = update["state"]["state"].as_str().unwrap_or("running");
        let mut subs = self.subagents.lock().unwrap();
        let known = subs.get(sid).cloned();
        let id = match &known {
            Some((id, _)) => id.clone(),
            None => {
                let id = format!("{}~{}", self.run_id, subs.len() + 1);
                let title = update["title"].as_str().or(update["description"].as_str()).unwrap_or("Subagent").to_string();
                subs.insert(sid.to_string(), (id.clone(), true));
                drop(subs);
                self.sink.child_run(&id, &self.run_id, self.agent, &title);
                let mut ev = AgentEvent::new(&id, self.agent, "started");
                ev.line = Some(format!("Subagent · {title}"));
                ev.data = Some(json!({"parent": self.run_id, "subagent": true, "title": title}));
                self.queue(ev);
                subs = self.subagents.lock().unwrap();
                id
            }
        };
        let working = known.map_or(true, |k| k.1);
        match state {
            "idle" if working => {
                subs.insert(sid.to_string(), (id.clone(), false));
                drop(subs);
                self.sink.child_finished(&id, "done");
                let mut ev = AgentEvent::new(&id, self.agent, "exit");
                ev.code = Some(0);
                ev.data = Some(json!({"status": "done"}));
                self.queue(ev);
            }
            "running" if !working => {
                subs.insert(sid.to_string(), (id.clone(), true));
                drop(subs);
                self.queue(AgentEvent::new(&id, self.agent, "user"));
            }
            _ => {}
        }
    }
    fn subagent_event(&self, child:&str, update:&Value) {
        let (kind, data) = match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk") if update["content"]["type"] == "text" => match update["content"]["text"].as_str() {
                Some(text) => ("message", json!({"text": text})),
                None => return,
            },
            Some("tool_call" | "tool_call_update") => ("tool", update.clone()),
            Some("plan") => ("plan", update.clone()),
            _ => return,
        };
        let mut ev = AgentEvent::new(child, self.agent, kind);
        ev.data = Some(data);
        self.queue(ev);
    }

    pub async fn finish(&self) {
        // Subagents still working end with their parent's session.
        let open: Vec<String> = self.subagents.lock().unwrap().values_mut().filter(|c| c.1).map(|c| { c.1 = false; c.0.clone() }).collect();
        for id in open {
            self.sink.child_finished(&id, "stopped");
            let mut ev = AgentEvent::new(&id, self.agent, "exit");
            ev.data = Some(json!({"status": "stopped"}));
            self.queue(ev);
        }
        self.flush_events();
        self.cancel_pending();
        let mut closed=self.operation_gate.lock().await;
        *closed=true;
        self.terminals.kill_all().await;
        drop(closed);
        // A sink may be running on another thread. Drain pre-close updates before
        // the lifecycle owner publishes exit, without holding session locks.
        loop {
            let idle=self.events_idle.notified();tokio::pin!(idle);idle.as_mut().enable();
            if !self.events.lock().unwrap().emitting {break;}
            idle.await;
        }
    }
    fn permission(&self, params:Value) -> HandlerFuture {
        let mut permissions = self.permissions.lock().unwrap();
        if permissions.closed { return Box::pin(async {Ok(cancelled())}); }
        let tool = params["toolCall"].clone();
        let options = params["options"].as_array().cloned().unwrap_or_default();
        let verdict = policy::evaluate(&policy::tool_info(&tool), &self.rules.rules().unwrap_or_default());
        let verdict = match (verdict, self.approval()) {
            (Verdict::Ask, Approval::Auto) => Verdict::Allow,
            (_, Approval::Deny) => Verdict::Deny,
            (v, _) => v,
        };
        let automatic = match verdict { Verdict::Allow => Some("allow_once"), Verdict::Deny => Some("reject_once"), Verdict::Ask => None };
        if verdict == Verdict::Deny {
            let mut note = AgentEvent::new(&self.run_id,self.agent,"stderr");
            let what = policy::tool_info(&tool);
            note.line = Some(if self.approval() == Approval::Deny {
                format!("Chỉ hỏi: đã từ chối {}", what.command.unwrap_or_else(|| tool["title"].as_str().unwrap_or("thao tác").to_string()))
            } else {
                format!("Đã tự động từ chối lệnh bị cấm: {}", what.command.unwrap_or_default())
            });
            self.queue(note);
        }
        if let Some(kind) = automatic {
            if let Some(id) = options.iter().find(|o|o["kind"] == kind).and_then(|o|o["optionId"].as_str()) {
                let result = selected(id);
                drop(permissions);
                self.flush_events();
                return Box::pin(async move {Ok(result)});
            }
            // Forbidden commands cannot fall back to an approval card.
            if verdict == Verdict::Deny {
                drop(permissions);
                self.flush_events();
                return Box::pin(async {Ok(cancelled())});
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (reply, receiver) = oneshot::channel();
        permissions.pending.insert(id.clone(), Pending {reply,tool:tool.clone(),options:options.clone()});
        // Shown on the card, so "Always allow" says exactly what it will allow.
        let info = policy::tool_info(&tool);
        let rule = if info.kind == "execute" { info.command.as_deref().and_then(policy::rule_for) } else { None };
        self.queue_data("permission",json!({"requestId":id,"toolCall":tool,"options":options,"rule":rule}));
        drop(permissions);
        self.flush_events();
        Box::pin(async move {Ok(receiver.await.unwrap_or_else(|_|cancelled()))})
    }
}
impl ClientHandler for TaskSession {
    fn on_notification(&self, method:&str, params:Value) {
        if self.muted.load(Ordering::SeqCst) { return; }
        if method != "session/update" {return;}
        let permissions=self.permissions.lock().unwrap();
        if permissions.closed {return;}
        let update = &params["update"];
        if update["sessionUpdate"] == "subagent_update" { drop(permissions); self.subagent_update(update); self.flush_events(); return; }
        // A subagent's own messages and tool calls go to its nested run.
        let child = params["sessionId"].as_str().and_then(|s| self.subagents.lock().unwrap().get(s).map(|c| c.0.clone()));
        if let Some(child) = child { drop(permissions); self.subagent_event(&child, update); self.flush_events(); return; }
        match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk") => {
                if update["content"]["type"] == "text" {
                    if let Some(text) = update["content"]["text"].as_str() {
                        let mut reply=self.reply.lock().unwrap();
                        if reply.1 { reply.0.clear(); reply.1=false; }
                        reply.0.push_str(text);
                        drop(reply);
                        self.queue_data("message",json!({"text":text}));
                    }
                }
            }
            Some("tool_call" | "tool_call_update") => { self.reply.lock().unwrap().1=true; self.queue_data("tool",update.clone()) }
            Some("available_commands_update") => self.queue_data("commands", json!({"commands": crate::options::parse_commands(self.agent, update, Some(&self.cwd))})),
            Some("plan") => self.queue_data("plan",update.clone()),
            Some("usage_update") => {
                if let Some(windows) = crate::usage::parse_rate_limit(&update["_meta"]["_claude/rateLimit"]) {
                    self.queue_data("limits", json!({"windows": windows}));
                }
                if let Some(mut usage) = crate::usage::parse_acp(update) {
                    let base=*self.cost_base.lock().unwrap();
                    usage.cost_usd=usage.cost_usd.map(|c|(c-base).max(0.0));
                    *self.last_cost.lock().unwrap() = usage.cost_usd;
                    let usage=self.with_totals(usage);
                    let mut event = AgentEvent::new(&self.run_id,self.agent,"usage");
                    event.usage = Some(usage); self.queue(event);
                }
            }
            _ => {}
        }
        drop(permissions);
        self.flush_events();
    }
    fn on_request(&self, method:String, params:Value)->HandlerFuture {
        if method == "session/request_permission" {return self.permission(params);}
        let sandbox = self.sandbox.clone(); let terminals = self.terminals.clone();
        let operation_gate = self.operation_gate.clone();
        if self.approval() == Approval::Deny && method == "fs/write_text_file" {
            return Box::pin(async {Err(crate::acp::transport::RpcError {code:-32000,message:"Chế độ Chỉ hỏi: không được ghi tệp.".into(),data:None})});
        }
        Box::pin(async move {
            match method.as_str() {
                "fs/read_text_file" | "fs/write_text_file" | "terminal/create" => {
                    let closed=operation_gate.lock().await;
                    if *closed {return Err(crate::acp::transport::RpcError {code:-32000,message:"Phiên đã kết thúc.".into(),data:None});}
                    match method.as_str() {
                        "fs/read_text_file" => sandbox.read_text_file(&params),
                        "fs/write_text_file" => sandbox.write_text_file(&params),
                        _ => terminals.create(&params).await,
                    }
                },
                "terminal/output" => terminals.output(&params).await,
                "terminal/wait_for_exit" => terminals.wait_for_exit(&params).await,
                "terminal/kill" => terminals.kill(&params).await,
                "terminal/release" => terminals.release(&params).await,
                _ => Err(method_not_found(&method)),
            }
        })
    }
    fn on_closed(&self) { self.cancel_pending(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn available_commands_update_emits_commands_using_session_directory() {
        let root = std::env::temp_dir().join(format!("tg-session-commands-{}", uuid::Uuid::new_v4()));
        let skill = root.join(".agents/skills/tg-codex-skill");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "test").unwrap();
        let sink = Arc::new(Recorder::default());
        let session = TaskSession::new("run", AgentKind::Codex, &root, sink.clone(), Arc::new(Memory::default())).unwrap();
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/codex-acp/2.5.0/available-commands.json")).unwrap();
        session.on_notification("session/update", fixture["params"].clone());
        session.on_notification("session/update", json!({"update":{"sessionUpdate":"available_commands_update", "availableCommands":[]}}));
        let events = sink.0.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "commands");
        let commands = &events[0].data.as_ref().unwrap()["commands"];
        assert_eq!(commands[4]["source"], "project");
        assert_eq!(commands[4]["insert"], "$tg-codex-skill ");
        assert_eq!(events[1].data.as_ref().unwrap()["commands"], json!([]));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn usage_update_with_claude_rate_limit_emits_limits() {
        let sink = Arc::new(Recorder::default());
        let session = TaskSession::new("run", AgentKind::Claude, &std::env::temp_dir(), sink.clone(), Arc::new(Memory::default())).unwrap();
        session.on_notification("session/update", json!({"update":{"sessionUpdate":"usage_update","used":1,"size":2,
            "_meta":{"_claude/rateLimit":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.3,"resetsAt":5,"status":"allowed"}}}}}}));
        session.on_notification("session/update", json!({"update":{"sessionUpdate":"usage_update","used":1,"size":2}}));
        let events = sink.0.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "limits");
        assert_eq!(events[0].data.as_ref().unwrap()["windows"][0]["utilization"], 0.3);
        assert_eq!(events[0].data.as_ref().unwrap()["windows"][0]["resetsAt"], 5000);
    }

    #[tokio::test]
    async fn bridge_approval_uses_a_card_and_only_allow_is_true() {
        for (option, expected) in [("allow", true), ("deny", false)] {
            let sink = Arc::new(Recorder::default());
            let session = TaskSession::new("run", AgentKind::Codex, &std::env::temp_dir(), sink.clone(), Arc::new(Memory::default())).unwrap();
            let answer = session.ask("xóa build/".into(), "dọn".into());
            let id = sink.0.lock().unwrap()[0].data.as_ref().unwrap()["requestId"].as_str().unwrap().to_string();
            assert!(sink.0.lock().unwrap()[0].data.as_ref().unwrap()["toolCall"]["title"].as_str().unwrap().contains("xóa build/"));
            session.respond_permission(&id, option, false).unwrap();
            assert_eq!(answer.await, expected);
        }
        let sink = Arc::new(Recorder::default());
        let session = TaskSession::new("run", AgentKind::Codex, &std::env::temp_dir(), sink, Arc::new(Memory::default())).unwrap();
        let answer = session.ask("a".into(), "b".into());
        session.cancel_pending();
        assert!(!answer.await);
    }

    #[tokio::test]
    async fn a_new_turn_after_a_stop_shows_cards_and_replies_again() {
        let sink = Arc::new(Recorder::default());
        let session = TaskSession::new("run", AgentKind::Claude, &std::env::temp_dir(), sink.clone(), Arc::new(Memory::default())).unwrap();
        session.cancel_pending(); // the user pressed Dừng mid-turn
        assert_eq!(session.on_request("session/request_permission".into(), permission("npm test")).await.unwrap(), cancelled());
        session.reopen(); // the next message starts a new turn in the same session
        let response = session.on_request("session/request_permission".into(), permission("npm test"));
        let id = sink.0.lock().unwrap().iter().find(|e| e.kind == "permission").expect("a card").data.as_ref().unwrap()["requestId"].as_str().unwrap().to_string();
        session.respond_permission(&id, "yes", false).unwrap();
        assert_eq!(response.await.unwrap(), selected("yes"));
        session.on_notification("session/update", json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"đã sửa"}}}));
        assert!(sink.0.lock().unwrap().iter().any(|e| e.kind == "message"));
    }

    #[tokio::test]
    async fn a_finished_session_stays_closed() {
        let session = TaskSession::new("run", AgentKind::Claude, &std::env::temp_dir(), Arc::new(Recorder::default()), Arc::new(Memory::default())).unwrap();
        session.finish().await;
        session.reopen();
        assert_eq!(session.on_request("session/request_permission".into(), permission("npm test")).await.unwrap(), cancelled());
    }

    #[tokio::test]
    async fn request_permission_waits_then_cancels() {
        let sink = Arc::new(Recorder::default());
        let session = TaskSession::new("run", AgentKind::Claude, &std::env::temp_dir(), sink.clone(), Arc::new(Memory::default())).unwrap();
        let response = session.on_request("session/request_permission".into(), permission("npm test"));
        assert_eq!(sink.0.lock().unwrap()[0].kind, "permission");
        session.cancel_pending();
        assert_eq!(response.await.unwrap(), json!({"outcome":{"outcome":"cancelled"}}));
        assert_eq!(sink.0.lock().unwrap()[1].kind, "permission_resolved");
    }
    #[derive(Default)]
    struct Recorder(Mutex<Vec<AgentEvent>>);
    impl EventSink for Recorder { fn emit(&self, ev: AgentEvent) { self.0.lock().unwrap().push(ev); } }
    #[derive(Default)]
    struct Memory(Mutex<Vec<String>>);
    impl RuleMemory for Memory {
        fn rules(&self)->Result<Vec<String>,String> {Ok(self.0.lock().unwrap().clone())}
        fn add(&self, rule:&str)->Result<(),String> {self.0.lock().unwrap().push(rule.into());Ok(())}
    }
    #[tokio::test]
    async fn subagent_sessions_go_to_their_own_nested_run() {
        #[derive(Default)]
        struct Sink { events: Mutex<Vec<AgentEvent>>, children: Mutex<Vec<String>> }
        impl EventSink for Sink {
            fn emit(&self, ev: AgentEvent) { self.events.lock().unwrap().push(ev); }
            fn child_run(&self, id: &str, parent: &str, _: AgentKind, title: &str) { self.children.lock().unwrap().push(format!("open {id} {parent} {title}")); }
            fn child_finished(&self, id: &str, status: &str) { self.children.lock().unwrap().push(format!("end {id} {status}")); }
        }
        let root = std::env::temp_dir();
        let sink = Arc::new(Sink::default());
        let session = TaskSession::new("p", AgentKind::Claude, &root, sink.clone(), Arc::new(Memory::default())).unwrap();
        let text = |sid: &str, t: &str| json!({"sessionId": sid, "update": {"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":t}}});
        session.on_notification("session/update", text("root", "Tôi giao cho subagent."));
        session.on_notification("session/update", json!({"sessionId":"root","update":{"sessionUpdate":"subagent_update","sessionId":"kid","title":"Tìm cấu hình","state":{"state":"running"}}}));
        session.on_notification("session/update", json!({"sessionId":"kid","update":{"sessionUpdate":"tool_call","toolCallId":"t","title":"Đọc a.json","status":"completed"}}));
        session.on_notification("session/update", text("kid", "Thấy ở a.json"));
        session.on_notification("session/update", json!({"sessionId":"root","update":{"sessionUpdate":"subagent_update","sessionId":"kid","state":{"state":"idle"}}}));
        session.on_notification("session/update", json!({"sessionId":"root","update":{"sessionUpdate":"tool_call","toolCallId":"u","title":"Sửa a.json","status":"pending"}}));
        session.on_notification("session/update", text("root", "Xong."));
        let events = sink.events.lock().unwrap();
        let of = |run: &str| events.iter().filter(|e| e.run_id == run).map(|e| e.kind).collect::<Vec<_>>();
        assert_eq!(of("p"), ["message", "tool", "message"], "the parent's log has only its own updates");
        assert_eq!(of("p~1"), ["started", "tool", "message", "exit"]);
        let started = events.iter().find(|e| e.run_id == "p~1" && e.kind == "started").unwrap();
        assert_eq!(started.data.as_ref().unwrap()["parent"], "p");
        assert_eq!(*sink.children.lock().unwrap(), ["open p~1 p Tìm cấu hình", "end p~1 done"]);
        // The latest message after the last tool call is what a delegated agent reports back.
        assert_eq!(session.last_reply(), "Xong.");
        drop(events);
        // A subagent still working when the session ends is stopped with it.
        session.on_notification("session/update", json!({"sessionId":"root","update":{"sessionUpdate":"subagent_update","sessionId":"kid2","title":"Khác","state":{"state":"running"}}}));
        session.finish().await;
        assert_eq!(sink.children.lock().unwrap().last().unwrap(), "end p~2 stopped");
    }

    #[tokio::test]
    async fn auto_allows_without_a_card_and_deny_refuses_writes() {
        let root = std::env::temp_dir().join(format!("tg-approval-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let sink = Arc::new(Recorder::default());
        let session = TaskSession::new("r", AgentKind::Kiro, &root, sink.clone(), Arc::new(Memory::default())).unwrap();
        session.set_approval(Approval::Auto);
        assert_eq!(session.on_request("session/request_permission".into(), permission("npm test")).await.unwrap(), selected("yes"));
        assert!(!sink.0.lock().unwrap().iter().any(|e| e.kind == "permission"), "Tự động không hiện thẻ duyệt");
        // Forbidden commands stay forbidden even in Tự động.
        assert_ne!(session.on_request("session/request_permission".into(), permission("git push origin main")).await.unwrap(), selected("yes"));
        session.set_approval(Approval::Deny);
        assert_eq!(session.on_request("session/request_permission".into(), permission("npm test")).await.unwrap(), selected("no"));
        let path = root.join("a.txt");
        assert!(session.on_request("fs/write_text_file".into(), json!({"path": path, "content": "x"})).await.is_err());
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn permission(command:&str)->Value {
        json!({"toolCall":{"kind":"execute","rawInput":{"command":command}},"options":[
            {"optionId":"yes","kind":"allow_once"},{"optionId":"no","kind":"reject_once"}]})
    }
    async fn fixture(steps:Vec<crate::acp::fake::Step>, rules:Vec<String>) -> (crate::acp::client::AcpClient,Arc<TaskSession>,Arc<Recorder>,crate::acp::fake::Log) {
        let sink = Arc::new(Recorder::default());
        let session = Arc::new(TaskSession::new("run",AgentKind::Claude,&std::env::temp_dir(),sink.clone(),Arc::new(Memory(Mutex::new(rules)))).unwrap());
        let (reader,writer,log) = crate::acp::fake::spawn(steps);
        let client = crate::acp::client::AcpClient::start(reader,writer,session.clone());
        client.initialize().await.unwrap(); client.new_session(&std::env::temp_dir(),json!([])).await.unwrap();
        (client,session,sink,log)
    }
    async fn wait_permission(sink:&Recorder)->String {
        tokio::time::timeout(std::time::Duration::from_secs(3),async {
            loop {
                if let Some(ev) = sink.0.lock().unwrap().iter().find(|e|e.kind == "permission") {
                    return ev.data.as_ref().unwrap()["requestId"].as_str().unwrap().to_string();
                }
                tokio::task::yield_now().await;
            }
        }).await.unwrap()
    }
    async fn prompt(client:crate::acp::client::AcpClient)->Result<String,String> {
        tokio::time::timeout(std::time::Duration::from_secs(3),client.prompt(crate::acp::fake::SESSION_ID,"task")).await.unwrap()
    }
    #[tokio::test]
    async fn fake_policy_allow_and_deny_return_only_once_options() {
        use crate::acp::fake::Step;
        for (command,option) in [("npm test","allow"),("git push","reject")] {
            let (client,session,sink,log) = fixture(vec![Step::AskPermissionFor(permission(command)["toolCall"].clone()),Step::WaitForPermissionReply,Step::End("end_turn")],vec!["npm test *".into(),"git *".into()]).await;
            assert_eq!(prompt(client).await.unwrap(),"end_turn");
            assert!(log.lock().unwrap().iter().any(|v|v["result"] == selected(option)));
            {
                let events = sink.0.lock().unwrap();
                if option == "allow" {
                    assert!(events.is_empty());
                } else {
                    // A silent denial would leave the user guessing why the agent stopped.
                    assert_eq!(events.len(), 1);
                    assert_eq!(events[0].kind, "stderr");
                    assert!(events[0].line.as_deref().unwrap().contains("git push"));
                }
            }
            session.finish().await;
        }
    }
    #[tokio::test]
    async fn fake_ask_keeps_updates_flowing_and_saves_rule_only_after_valid_allow() {
        use crate::acp::fake::Step;
        let (client,session,sink,log) = fixture(vec![Step::AskPermissionFor(permission("npm test")["toolCall"].clone()),Step::Message("still alive"),Step::WaitForPermissionReply,Step::End("end_turn")],vec![]).await;
        let turn = tokio::spawn(prompt(client));
        let id=wait_permission(&sink).await;
        assert!(!turn.is_finished());
        assert!(session.respond_permission(&id,"invalid",true).is_err());
        assert!(session.rules.rules().unwrap().is_empty());
        session.respond_permission(&id,"allow",true).unwrap();
        assert_eq!(session.rules.rules().unwrap(),vec!["npm test *"]);
        assert_eq!(turn.await.unwrap().unwrap(),"end_turn");
        assert!(session.respond_permission(&id,"allow",true).is_err());
        assert!(log.lock().unwrap().iter().any(|v|v["result"] == selected("allow")));
        assert!(sink.0.lock().unwrap().iter().any(|ev|ev.kind == "message"));
        session.finish().await;
    }
    #[tokio::test]
    async fn fake_crash_clears_pending_cards() {
        use crate::acp::fake::Step;
        let (client,session,sink,_) = fixture(vec![Step::AskPermission,Step::Crash],vec![]).await;
        assert!(prompt(client).await.is_err());
        tokio::time::timeout(std::time::Duration::from_secs(3),async {
            while !session.permissions.lock().unwrap().closed {tokio::task::yield_now().await;}
        }).await.unwrap();
        assert!(session.permissions.lock().unwrap().pending.is_empty());
        assert!(sink.0.lock().unwrap().iter().any(|e|e.kind == "permission_resolved"));
    }
    #[tokio::test]
    async fn fake_cancel_while_waiting_returns_cancelled() {
        use crate::acp::fake::Step;
        let (client,session,sink,log)=fixture(vec![Step::AskPermission,Step::WaitForPermissionReply,Step::WaitForCancel,Step::End("cancelled")],vec![]).await;
        let turn=tokio::spawn(prompt(client.clone()));
        wait_permission(&sink).await;
        session.cancel_pending();
        // Let the permission reply arrive before fake starts waiting for cancel.
        tokio::time::timeout(std::time::Duration::from_secs(3),async {
            while !log.lock().unwrap().iter().any(|v|v["result"] == cancelled()) {tokio::task::yield_now().await;}
        }).await.unwrap();
        client.cancel(crate::acp::fake::SESSION_ID).unwrap();
        assert_eq!(turn.await.unwrap().unwrap(),"cancelled");
        assert!(session.permissions.lock().unwrap().pending.is_empty());
        assert_eq!(session.on_request("session/request_permission".into(),permission("ls")).await.unwrap(),cancelled());
    }
    #[tokio::test]
    async fn fake_fs_escape_and_unknown_method_return_errors() {
        use crate::acp::fake::Step;
        let (client,session,_,log) = fixture(vec![Step::Call("fs/read_text_file",json!({"path":if cfg!(windows) {"C:\\not-in-worktree\\secret"} else {"/not-in-worktree/secret"}})),Step::WaitForAnyReply,Step::Request("unknown/method"),Step::WaitForAnyReply,Step::End("end_turn")],vec![]).await;
        prompt(client).await.unwrap();
        for code in [-32000,-32601] {assert!(log.lock().unwrap().iter().any(|v|v["error"]["code"]==code));}
        session.finish().await;
    }
    #[tokio::test]
    async fn fake_updates_preserve_payload_and_report_cost() {
        use crate::acp::fake::Step;
        let tool=json!({"sessionUpdate":"tool_call","toolCallId":"one","title":"read","status":"pending","rawInput":{"path":"x"}});
        let plan=json!({"sessionUpdate":"plan","entries":[{"content":"read","priority":"high","status":"pending"}]});
        let (client,session,sink,_)=fixture(vec![Step::Message("hello"),Step::Update(tool.clone()),Step::Update(plan.clone()),Step::Update(json!({"sessionUpdate":"usage_update","used":999,"size":2000})),Step::Update(json!({"sessionUpdate":"usage_update","cost":{"amount":0.3,"currency":"USD"}})),Step::End("end_turn")],vec![]).await;
        prompt(client).await.unwrap();
        let events=sink.0.lock().unwrap();
        assert_eq!(events.iter().map(|e|e.kind).collect::<Vec<_>>(),vec!["message","tool","plan","usage"]);
        assert_eq!(events[0].data,Some(json!({"text":"hello"})));
        assert_eq!(events[1].data,Some(tool));assert_eq!(events[2].data,Some(plan));
        assert_eq!(events[3].usage.as_ref().unwrap().cost_usd,Some(0.3));
        drop(events);session.finish().await;
    }
    #[tokio::test]
    async fn missing_once_option_never_selects_always_automatically() {
        let sink=Arc::new(Recorder::default());
        let session=TaskSession::new("run",AgentKind::Claude,&std::env::temp_dir(),sink.clone(),Arc::new(Memory(Mutex::new(vec!["npm test *".into()])))).unwrap();
        let mut p=permission("npm test");p["options"]=json!([{"optionId":"always","kind":"allow_always"}]);
        let answer=session.on_request("session/request_permission".into(),p.clone());
        let id=wait_permission(&sink).await;
        session.respond_permission(&id,"always",false).unwrap();
        assert_eq!(answer.await.unwrap(),selected("always"));
        p["toolCall"]=permission("git push")["toolCall"].clone();
        assert_eq!(session.on_request("session/request_permission".into(),p).await.unwrap(),cancelled());
    }
    #[tokio::test]
    async fn rejection_and_compound_command_never_save_rules() {
        let sink=Arc::new(Recorder::default());let memory=Arc::new(Memory::default());
        let session=TaskSession::new("run",AgentKind::Claude,&std::env::temp_dir(),sink.clone(),memory.clone()).unwrap();
        for (command,option) in [("npm test","no"),("npm test && echo ok","yes")] {
            let response=session.on_request("session/request_permission".into(),permission(command));
            let id=sink.0.lock().unwrap().iter().rev().find(|e|e.kind=="permission").unwrap().data.as_ref().unwrap()["requestId"].as_str().unwrap().to_string();
            session.respond_permission(&id,option,true).unwrap();assert_eq!(response.await.unwrap(),selected(option));
        }
        assert!(memory.rules().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn finish_kills_terminals_and_rejects_queued_creates() {
        let sink=Arc::new(Recorder::default());
        let session=TaskSession::new("run",AgentKind::Claude,&std::env::temp_dir(),sink,Arc::new(Memory::default())).unwrap();
        let params=json!({"command":"/bin/sh","args":["-c","exec sleep 30"]});
        let terminal=session.on_request("terminal/create".into(),params.clone()).await.unwrap();
        let queued=session.on_request("terminal/create".into(),params);
        tokio::time::timeout(std::time::Duration::from_secs(3),session.finish()).await.unwrap();
        assert_eq!(queued.await.unwrap_err().code,-32000);
        assert!(session.on_request("terminal/output".into(),terminal).await.is_err());
    }
    #[tokio::test]
    async fn sink_can_respond_reentrantly_without_deadlock() {
        #[derive(Default)]
        struct ReplySink {session:Mutex<Option<std::sync::Weak<TaskSession>>>, events:Mutex<Vec<&'static str>>}
        impl EventSink for ReplySink {
            fn emit(&self,event:AgentEvent) {
                self.events.lock().unwrap().push(event.kind);
                if event.kind=="permission" {
                    let session=self.session.lock().unwrap().as_ref().unwrap().upgrade().unwrap();
                    session.respond_permission(event.data.as_ref().unwrap()["requestId"].as_str().unwrap(),"yes",false).unwrap();
                }
            }
        }
        let sink=Arc::new(ReplySink::default());
        let session=Arc::new(TaskSession::new("run",AgentKind::Claude,&std::env::temp_dir(),sink.clone(),Arc::new(Memory::default())).unwrap());
        *sink.session.lock().unwrap()=Some(Arc::downgrade(&session));
        assert_eq!(session.on_request("session/request_permission".into(),permission("npm test")).await.unwrap(),selected("yes"));
        assert_eq!(*sink.events.lock().unwrap(),vec!["permission","permission_resolved"]);
    }

    #[tokio::test]
    async fn finish_rejects_queued_filesystem_requests_and_late_updates() {
        let root=std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());std::fs::create_dir(&root).unwrap();
        let sink=Arc::new(Recorder::default());
        let session=TaskSession::new("run",AgentKind::Claude,&root,sink.clone(),Arc::new(Memory::default())).unwrap();
        let path=root.join("late");
        let write=session.on_request("fs/write_text_file".into(),json!({"path":path,"content":"late"}));
        let read=session.on_request("fs/read_text_file".into(),json!({"path":path}));
        session.finish().await;
        assert_eq!(write.await.unwrap_err().code,-32000);
        assert_eq!(read.await.unwrap_err().code,-32000);
        assert!(!path.exists());
        session.on_notification("session/update",json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"late"}}}));
        assert!(sink.0.lock().unwrap().is_empty());std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn finish_waits_for_already_admitted_event_delivery() {
        struct BlockingSink { entered:tokio::sync::Notify, release:Mutex<std::sync::mpsc::Receiver<()>> }
        impl EventSink for BlockingSink {
            fn emit(&self,_event:AgentEvent) {self.entered.notify_one();self.release.lock().unwrap().recv().unwrap();}
        }
        let (release,receiver)=std::sync::mpsc::channel();
        let sink=Arc::new(BlockingSink {entered:tokio::sync::Notify::new(),release:Mutex::new(receiver)});
        let session=Arc::new(TaskSession::new("run",AgentKind::Claude,&std::env::temp_dir(),sink.clone(),Arc::new(Memory::default())).unwrap());
        let cloned=session.clone();
        let emitter=std::thread::spawn(move ||cloned.on_notification("session/update",json!({"update":{"sessionUpdate":"plan","entries":[]}})));
        sink.entered.notified().await;
        let cloned=session.clone();let mut finish=tokio::spawn(async move {cloned.finish().await});
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20),&mut finish).await.is_err());
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1),finish).await.unwrap().unwrap();emitter.join().unwrap();
    }
}
