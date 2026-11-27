//! Kết nối tới một agent: `drive_session` chỉ làm việc qua trait này, nên ACP và các
//! kiểu kết nối khác (ví dụ `claude -p` stream-json) cắm vào cùng một vòng đời.

use std::path::Path;

use serde_json::Value;

use crate::acp::client::AcpClient;
use crate::tasks::session::Approval;

pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

pub trait AgentConn: Send + Sync {
    fn initialize(&self) -> BoxFuture<'_, Result<Value, String>>;
    fn new_session<'a>(&'a self, cwd: &'a Path, mcp: Value) -> BoxFuture<'a, Result<String, String>>;
    fn load_session<'a>(&'a self, session_id: &'a str, cwd: &'a Path, mcp: Value) -> BoxFuture<'a, Result<(), String>>;
    fn prompt_turn<'a>(&'a self, session_id: &'a str, text: &'a str) -> BoxFuture<'a, Result<Value, String>>;
    fn cancel(&self, session_id: &str) -> Result<(), String>;
    fn config_options(&self) -> Value;
    fn set_config_option<'a>(&'a self, session_id: &'a str, config_id: &'a str, value: &'a str) -> BoxFuture<'a, Result<(), String>>;
    /// Đổi quyền giữa phiên. ACP: không làm gì (TaskSession tự xử lý quyền).
    fn set_mode(&self, _approval: Approval) -> Result<(), String> { Ok(()) }
    fn close(&self);
}

impl AgentConn for AcpClient {
    fn initialize(&self) -> BoxFuture<'_, Result<Value, String>> { Box::pin(AcpClient::initialize(self)) }
    fn new_session<'a>(&'a self, cwd: &'a Path, mcp: Value) -> BoxFuture<'a, Result<String, String>> { Box::pin(AcpClient::new_session(self, cwd, mcp)) }
    fn load_session<'a>(&'a self, session_id: &'a str, cwd: &'a Path, mcp: Value) -> BoxFuture<'a, Result<(), String>> { Box::pin(AcpClient::load_session(self, session_id, cwd, mcp)) }
    fn prompt_turn<'a>(&'a self, session_id: &'a str, text: &'a str) -> BoxFuture<'a, Result<Value, String>> { Box::pin(AcpClient::prompt_turn(self, session_id, text)) }
    fn cancel(&self, session_id: &str) -> Result<(), String> { AcpClient::cancel(self, session_id) }
    fn config_options(&self) -> Value { AcpClient::config_options(self) }
    fn set_config_option<'a>(&'a self, session_id: &'a str, config_id: &'a str, value: &'a str) -> BoxFuture<'a, Result<(), String>> { Box::pin(AcpClient::set_config_option(self, session_id, config_id, value)) }
    fn close(&self) { AcpClient::close(self) }
}
