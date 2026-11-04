//! ACP request routing without a desktop runtime, shared by real and fake agents.
use std::{collections::{HashMap, VecDeque}, path::Path, sync::{Arc, Mutex}};
use serde_json::{json, Value};
use tokio::sync::oneshot;
use crate::{acp::{client::{ClientHandler, HandlerFuture, method_not_found}, handlers::{Sandbox, Terminals}}, adapters::AgentKind, policy::{self, Verdict}, runner::AgentEvent};

pub trait EventSink: Send + Sync + 'static { fn emit(&self, ev: AgentEvent); }
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
    sink: Arc<dyn EventSink>,
    rules: Arc<dyn RuleMemory>,
    sandbox: Arc<Sandbox>,
    terminals: Terminals,
    permissions: Mutex<Permissions>,
    events: Mutex<EventQueue>,
    events_idle: tokio::sync::Notify,
    operation_gate: Arc<tokio::sync::Mutex<bool>>,
    last_cost: Mutex<Option<f64>>,
}
fn cancelled() -> Value { json!({"outcome":{"outcome":"cancelled"}}) }
fn selected(option: &str) -> Value { json!({"outcome":{"outcome":"selected","optionId":option}}) }
impl TaskSession {
    pub fn new(run_id:&str, agent:AgentKind, root:&Path, sink:Arc<dyn EventSink>, rules:Arc<dyn RuleMemory>) -> Result<Self,String> {
        let sandbox = Arc::new(Sandbox::new(root)?);
        Ok(Self {run_id:run_id.into(),agent,sink,rules,terminals:Terminals::new(sandbox.clone()),sandbox,permissions:Mutex::default(),events:Mutex::default(),events_idle:tokio::sync::Notify::new(),operation_gate:Arc::new(tokio::sync::Mutex::new(false)),last_cost:Mutex::new(None)})
    }
    fn queue(&self, event:AgentEvent) { self.events.lock().unwrap().queued.push_back(event); }
    pub fn agent(&self) -> AgentKind { self.agent }
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
    /// Token counts arrive only with the prompt result; keep the last reported cost with them.
    pub fn turn_finished(&self, result:&Value) {
        let cost = *self.last_cost.lock().unwrap();
        if let Some(usage) = crate::usage::parse_acp_turn(result, cost) {
            let mut event = AgentEvent::new(&self.run_id,self.agent,"usage");
            event.usage = Some(usage); self.queue(event); self.flush_events();
        }
    }
    pub async fn finish(&self) {
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
        let automatic = match verdict { Verdict::Allow => Some("allow_once"), Verdict::Deny => Some("reject_once"), Verdict::Ask => None };
        if verdict == Verdict::Deny {
            let mut note = AgentEvent::new(&self.run_id,self.agent,"stderr");
            note.line = Some(format!("Đã tự động từ chối lệnh bị cấm: {}", policy::tool_info(&tool).command.unwrap_or_default()));
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
        if method != "session/update" {return;}
        let permissions=self.permissions.lock().unwrap();
        if permissions.closed {return;}
        let update = &params["update"];
        match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk") => {
                if update["content"]["type"] == "text" {
                    if let Some(text) = update["content"]["text"].as_str() {self.queue_data("message",json!({"text":text}));}
                }
            }
            Some("tool_call" | "tool_call_update") => self.queue_data("tool",update.clone()),
            Some("plan") => self.queue_data("plan",update.clone()),
            Some("usage_update") => {
                if let Some(windows) = crate::usage::parse_rate_limit(&update["_meta"]["_claude/rateLimit"]) {
                    self.queue_data("limits", json!({"windows": windows}));
                }
                if let Some(usage) = crate::usage::parse_acp(update) {
                    *self.last_cost.lock().unwrap() = usage.cost_usd;
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
