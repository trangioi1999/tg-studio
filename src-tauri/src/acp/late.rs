//! Defers delivery until a warm ACP session has a real handler.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::client::{ClientHandler, HandlerFuture};
use super::transport::RpcError;

const BUFFER: usize = 256;

#[derive(Default)]
struct State {
    target: Option<Arc<dyn ClientHandler>>,
    notifications: VecDeque<(String, Value)>,
    draining: bool,
    closed: bool,
    close_delivered: bool,
}

pub struct LateHandler {
    state: Mutex<State>,
}

impl LateHandler {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { state: Mutex::new(State::default()) })
    }

    /// Replays buffered notifications before delivering new ones, then closes
    /// the target if the adapter already closed. A second attachment is rejected.
    pub fn attach(&self, target: Arc<dyn ClientHandler>) -> Result<(), String> {
        {
            let mut state = self.state.lock().unwrap();
            if state.target.is_some() {
                return Err("Đích xử lý ACP đã được gắn.".into());
            }
            state.target = Some(target.clone());
            state.draining = true;
        }
        self.drain(target);
        Ok(())
    }

    pub fn is_closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }

    // Exactly one caller owns delivery. Concurrent or reentrant notifications
    // join the queue, so callbacks never hold the mutex or overtake replay.
    fn drain(&self, target: Arc<dyn ClientHandler>) {
        loop {
            let next = {
                let mut state = self.state.lock().unwrap();
                if let Some(notification) = state.notifications.pop_front() {
                    Some(notification)
                } else if state.closed && !state.close_delivered {
                    state.close_delivered = true;
                    None
                } else {
                    state.draining = false;
                    return;
                }
            };
            match next {
                Some((method, params)) => target.on_notification(&method, params),
                None => target.on_closed(),
            }
        }
    }
}

impl ClientHandler for LateHandler {
    fn on_notification(&self, method: &str, params: Value) {
        let target = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            if state.target.is_none() && state.notifications.len() == BUFFER {
                state.notifications.pop_front();
            }
            state.notifications.push_back((method.into(), params));
            if state.draining {
                return;
            }
            let Some(target) = state.target.clone() else { return };
            state.draining = true;
            target
        };
        self.drain(target);
    }

    fn on_request(&self, method: String, params: Value) -> HandlerFuture {
        let target = self.state.lock().unwrap().target.clone();
        match target {
            Some(target) => target.on_request(method, params),
            None => Box::pin(async {
                Err(RpcError {
                    code: -32603,
                    message: "TG Studio chưa sẵn sàng.".into(),
                    data: None,
                })
            }),
        }
    }

    fn on_closed(&self) {
        let target = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.closed = true;
            if state.draining {
                return;
            }
            let Some(target) = state.target.clone() else { return };
            state.draining = true;
            target
        };
        self.drain(target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Barrier;

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<Value>>,
        replay_barriers: Option<(Arc<Barrier>, Arc<Barrier>)>,
        reenter: Option<Arc<LateHandler>>,
    }
    impl ClientHandler for Recorder {
        fn on_notification(&self, method: &str, params: Value) {
            self.events.lock().unwrap().push(json!([method, params]));
            if params == json!(0) {
                if let Some((started, resume)) = &self.replay_barriers {
                    started.wait();
                    resume.wait();
                }
                if let Some(late) = &self.reenter {
                    assert!(!late.is_closed());
                    late.on_notification("update", json!(2));
                }
            }
        }
        fn on_request(&self, method: String, params: Value) -> HandlerFuture {
            self.events.lock().unwrap().push(json!([method, params]));
            Box::pin(async { Ok(json!("reply")) })
        }
        fn on_closed(&self) { self.events.lock().unwrap().push(json!("closed")); }
    }
    fn notify(late: &LateHandler, n: usize) { late.on_notification("update", json!(n)); }
    fn events(target: &Recorder) -> Vec<Value> { target.events.lock().unwrap().clone() }

    #[test]
    fn replays_in_order_then_forwards() {
        let late = LateHandler::new();
        let target = Arc::new(Recorder::default());
        notify(&late, 0); notify(&late, 1);
        late.attach(target.clone()).unwrap();
        assert_eq!(events(&target), vec![json!(["update", 0]), json!(["update", 1])]);
        notify(&late, 2);
        assert_eq!(events(&target).last(), Some(&json!(["update", 2])));
    }

    #[tokio::test]
    async fn requests_fail_before_attach_and_forward_after() {
        let late = LateHandler::new();
        let error = late.on_request("read".into(), json!(1)).await.unwrap_err();
        assert_eq!(error.code, -32603);
        assert_eq!(error.message, "TG Studio chưa sẵn sàng.");
        let target = Arc::new(Recorder::default());
        late.attach(target.clone()).unwrap();
        assert_eq!(late.on_request("read".into(), json!(2)).await.unwrap(), json!("reply"));
        assert_eq!(events(&target), vec![json!(["read", 2])]);
    }

    #[test]
    fn closed_before_attach_replays_then_closes_once() {
        let late = LateHandler::new();
        assert!(!late.is_closed());
        notify(&late, 0);
        late.on_closed(); late.on_closed();
        assert!(late.is_closed());
        let target = Arc::new(Recorder::default());
        late.attach(target.clone()).unwrap();
        late.on_closed();
        assert_eq!(events(&target), vec![json!(["update", 0]), json!("closed")]);
    }

    #[test]
    fn closed_after_attach_forwards_once() {
        let late = LateHandler::new();
        let target = Arc::new(Recorder::default());
        late.attach(target.clone()).unwrap();
        notify(&late, 0);
        late.on_closed(); late.on_closed();
        assert!(late.is_closed());
        assert_eq!(events(&target), vec![json!(["update", 0]), json!("closed")]);
    }

    #[test]
    fn buffer_keeps_latest_256() {
        let late = LateHandler::new();
        for n in 0..300 { notify(&late, n); }
        let target = Arc::new(Recorder::default());
        late.attach(target.clone()).unwrap();
        assert_eq!(events(&target), (44..300).map(|n| json!(["update", n])).collect::<Vec<_>>());
    }

    #[test]
    fn second_attach_preserves_original_target() {
        let late = LateHandler::new();
        let first = Arc::new(Recorder::default());
        let second = Arc::new(Recorder::default());
        late.attach(first.clone()).unwrap();
        assert!(late.attach(second.clone()).is_err());
        notify(&late, 0);
        assert_eq!(events(&first), vec![json!(["update", 0])]);
        assert!(events(&second).is_empty());
    }

    #[test]
    fn concurrent_notification_and_close_follow_replay() {
        let late = LateHandler::new();
        notify(&late, 0); notify(&late, 1);
        let started = Arc::new(Barrier::new(2));
        let resume = Arc::new(Barrier::new(2));
        let target = Arc::new(Recorder {
            replay_barriers: Some((started.clone(), resume.clone())),
            ..Recorder::default()
        });
        let attaching = {
            let late = late.clone(); let target = target.clone();
            std::thread::spawn(move || late.attach(target).unwrap())
        };
        started.wait();
        notify(&late, 2);
        late.on_closed();
        resume.wait();
        attaching.join().unwrap();
        assert_eq!(events(&target), vec![json!(["update", 0]), json!(["update", 1]), json!(["update", 2]), json!("closed")]);
    }

    #[test]
    fn target_can_reenter_without_lock_and_preserves_order() {
        let late = LateHandler::new();
        notify(&late, 0); notify(&late, 1);
        let target = Arc::new(Recorder { reenter: Some(late.clone()), ..Recorder::default() });
        late.attach(target.clone()).unwrap();
        assert_eq!(events(&target), vec![json!(["update", 0]), json!(["update", 1]), json!(["update", 2])]);
    }
}
