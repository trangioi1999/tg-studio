# Đợt A · Một phiên cho mọi chế độ — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude chạy qua giao thức điều khiển của `claude -p` (stream-json) cho cả ba chế độ trong cùng một phiên sống; Chỉ hỏi của Claude đi đường task như Sửa code; đổi Chỉ hỏi / Hỏi trước / Tự làm giữa phiên không mở phiên mới.

**Architecture:** Thêm trait `AgentConn` (các thao tác `drive_session` cần) với hai cài đặt: `AcpClient` (giữ nguyên) và `ClaudeConn` (mới). `ClaudeConn` là một "adapter trong tiến trình": đọc stream-json của `claude -p`, dịch sang đúng hình dạng ACP (`session/update`, `session/request_permission`, kết quả `session/prompt`) rồi gọi `ClientHandler` của `TaskSession`. Nhờ vậy `TaskSession` (quyền, policy, SQLite, usage, agent con, tg-bridge) gần như không đổi.

**Tech Stack:** Rust (tokio, serde_json), Tauri 2, Angular 22 signals, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-claude-desktop-parity-design.md` (mục 4.1–4.3, 6, 8 đợt A, 10, 11)

## Global Constraints

- Mọi chuỗi cho người dùng, kể cả lỗi Rust trả về, bằng tiếng Việt.
- Tiến trình con chỉ tạo bằng `env::command` / `env::std_command`, kèm `.env("PATH", env::login_path())` và `env::isolate`; không `Command::new` (có test chặn).
- MCP cho Claude: đường dẫn tệp 0600 qua `mcp::ConfigFile`, không bao giờ JSON có token trên dòng lệnh.
- Ghi SQLite trước khi phát event; lỗi ghi không làm hỏng lượt.
- Lệnh Tauri mới / đổi tham số: cập nhật `AgentBackend`, `TauriBackend`, `MockBackend`, `generate_handler!` trong `lib.rs`; `protocol.ts` khớp struct Rust `#[serde(rename_all = "camelCase")]`.
- Chỉ hỏi không bao giờ ghi được tệp. Ngoại lệ duy nhất: Claude ghi vào `~/.claude/plans/` (spec §11.2).
- Không xoá `tasks/headless.rs`, `claude-agent-acp` hay `start_agent` trong đợt này (spec §11.1: chỉ xoá sau khi chủ repo chạy test thật). Codex Chỉ hỏi giữ `codex exec` (spec §11.3).
- Cờ lùi: biến môi trường `TG_CLAUDE_ACP=1` cho Claude chạy lại qua `claude-agent-acp`.
- Trước khi xong mỗi task: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)` đều qua.
- Tài liệu tham khảo khi dịch sang ACP: mã `claude-agent-acp` (github.com/zed-industries/claude-agent-acp; bản đã clone: `/tmp/claude-0/-home-user-tg-studio/453e1386-8bbb-5dfc-a564-32fb31b91939/scratchpad/src/claude-agent-acp`, hàm `toolInfoFromToolUse`, phần rate limit, `subagent-sessions`), fixture ACP thật `src-tauri/tests/fixtures/claude-agent-acp/0.100.0/edit-session.jsonl`, fixture stream-json thật `src-tauri/tests/fixtures/claude/2.1.31x/`.

## Review Focus

1. **Thiết lập riêng của người dùng là tự duyệt** (`defaultMode: bypassPermissions` trong `~/.claude/settings.json`): Hỏi trước vẫn phải hiện thẻ duyệt và Chỉ hỏi vẫn không ghi được, vì lệnh luôn có `--permission-mode` và `--permission-prompts host`. Test ở Task 6 (`native_args_always_pin_mode_and_host`).
2. **`claude` chết giữa lượt** (crash, bị kill ngoài app): run kết thúc `failed` với lỗi tiếng Việt, không treo, thẻ duyệt đang chờ bị huỷ. Test ở Task 2 (`claude_conn_crash_mid_turn_fails_turn`).
3. **CLI bản mới gửi loại message lạ** (`type` chưa biết, `system` subtype mới): bỏ qua, không lỗi, không làm hỏng lượt. Test ở Task 2 (`claude_conn_ignores_unknown_messages`).
4. **Kết quả tool rất lớn** (`tool_result` vài MB): cắt trước khi lên UI (≤ 20 000 ký tự, giữ phần cuối). Test ở Task 3 (`tool_result_is_truncated`).
5. **Esc khi không có lượt đang chạy, hoặc bấm Esc hai lần**: không lỗi, không treo, lượt sau vẫn chạy. Test ở Task 4 (`interrupt_when_idle_is_harmless`).

---

### Task 1: Trait `AgentConn`, `AcpClient` cài nó, `drive_session` dùng trait

Không đổi hành vi. Mục đích: `drive_session`, `run_turn`, `options::apply`, `warm.rs` làm việc với `&dyn AgentConn` thay vì `&AcpClient`.

**Files:**
- Create: `src-tauri/src/acp/conn.rs`
- Modify: `src-tauri/src/acp/mod.rs` (khai báo module), `src-tauri/src/acp/client.rs` (impl), `src-tauri/src/tasks/mod.rs` (`run_turn`, `drive_session`, `drive`), `src-tauri/src/agents/options.rs` (`apply`), `src-tauri/src/tasks/warm.rs`
- Test: `src-tauri/src/tasks/tests.rs` (các test hiện có phải qua nguyên vẹn)

**Interfaces:**
- Produces (`crate::acp::conn`):

```rust
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
```

- [ ] **Step 1:** Tạo `conn.rs` với trait trên; `impl AgentConn for AcpClient` gọi đúng các hàm hiện có (`initialize`, `new_session`, `load_session`, `prompt_turn`, `cancel`, `config_options`, `set_config_option`, `close`).
- [ ] **Step 2:** Đổi chữ ký `run_turn(client: &dyn AgentConn, …)`, `drive_session(client: &dyn AgentConn, …)`, `drive(client: &dyn AgentConn, …)`, `options::apply(client: &dyn AgentConn, …)`; chỗ gọi truyền `&client`.
- [ ] **Step 3:** Run `(cd src-tauri && cargo test)`. Expected: toàn bộ test hiện có PASS, không test nào phải sửa nội dung.
- [ ] **Step 4:** Commit `refactor(tasks): drive_session dùng trait AgentConn`.

---

### Task 2: `ClaudeConn` lõi + agent giả stream-json

**Files:**
- Create: `src-tauri/src/acp/claude_conn.rs`, `src-tauri/src/acp/fake_claude.rs` (`#[cfg(test)]`)
- Modify: `src-tauri/src/acp/mod.rs`

**Interfaces:**
- Consumes: `AgentConn` (Task 1), `ClientHandler` (`acp/client.rs`), `attachments::claude_content`.
- Produces:

```rust
pub struct ClaudeConn { /* writer, pending control requests, session_id, config, handler */ }
impl ClaudeConn {
    /// Đọc stdout của `claude -p`, ghi stdin. `handler` nhận mọi thứ đã dịch sang ACP.
    pub fn start<R, W>(reader: R, writer: W, handler: Arc<dyn ClientHandler>) -> Arc<ClaudeConn>
        where R: AsyncRead + Unpin + Send + 'static, W: AsyncWrite + Unpin + Send + 'static;
}
impl AgentConn for ClaudeConn { … }
```
- `fake_claude.rs`: `pub enum ClaudeStep { Text(&'static str), Line(Value), Ask { tool: &'static str, input: Value }, WaitForControl(&'static str), Result { stop: &'static str, usage: Value, cost: f64 }, Crash }` và `pub fn fake_claude(steps: Vec<ClaudeStep>) -> (DuplexStream halves, Log)` theo mẫu `acp/fake.rs`: tự trả lời `initialize` (với `commands`, `models`, `current_permission_mode`), phát một dòng có `session_id` ngay sau đó, chạy các bước khi nhận một dòng `{"type":"user",…}`.

Dịch (stdout → handler / giá trị trả về):

| stream-json | ACP cho `TaskSession` |
|---|---|
| `control_response` cho `initialize` | `initialize()` trả `{ "agentCapabilities": { "loadSession": true, "promptCapabilities": { "image": true, "embeddedContext": true } } }`; `commands` → notification `session/update` `available_commands_update` (`availableCommands: [{name, description}]`, giữ hậu tố ` (project)`/` (user)` như claude-agent-acp để `options::parse_commands` đọc được); `models` → `config_options()` dạng `[{ "id": "model", "type": "select", "currentValue", "options": [{ "value", "name" }] }]` |
| dòng đầu tiên có `session_id` | `new_session()` trả id đó (chờ tối đa 30 s, quá thì lỗi tiếng Việt) |
| `stream_event` `content_block_delta` `text_delta` | `session/update` `agent_message_chunk` `{content:{type:"text",text}}` |
| `result` | `prompt_turn()` trả `{ "stopReason": <end_turn \| cancelled nếu đã interrupt \| max_turn_requests cho error_max_turns \| refusal>, "usage": { "inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens" } }`; **trước đó** phát `session/update` `usage_update` `{ used, size: modelUsage.contextWindow, cost: { amount: total_cost_usd, currency: "USD" } }` |
| `result` có `is_error` / subtype `error_*` khác | `prompt_turn()` trả `Err("Claude báo lỗi: …")` |
| stdout đóng giữa lượt | `prompt_turn()` trả `Err("Claude đã dừng trước khi hoàn tất yêu cầu.")` |
| `type` không biết | bỏ qua |

Gửi (stdin): `initialize` là `{"type":"control_request","request_id":<uuid>,"request":{"subtype":"initialize"}}`; câu hỏi là `{"type":"user","message":{"role":"user","content": claude_content(text)}}`; `load_session` không gửi gì (phiên đã nạp bằng `--resume` lúc spawn, Task 6) và trả `Ok(())` nếu `session_id` trùng, `Err` nếu khác; `close()` đóng stdin.

`result.usage` theo lượt hay cộng dồn: đọc fixture `src-tauri/tests/fixtures/claude/2.1.319/` (hai câu trong một phiên) và cách `usage::SessionTotals` dùng nó; `ClaudeConn` trả **số của riêng lượt đó** (TaskSession tự cộng).

- [ ] **Step 1: Test** `claude_conn_runs_a_turn` trong `claude_conn.rs`: fake với `[Text("Xin "), Text("chào"), Result{stop:"success", usage: {"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}, cost:0.01}]`, handler ghi lại; assert hai `agent_message_chunk` "Xin ", "chào"; một `usage_update` có `cost.amount == 0.01`; `prompt_turn` trả `stopReason == "end_turn"`, `usage.inputTokens == 10`, `cachedWriteTokens == 1`, `cachedReadTokens == 2`, `outputTokens == 5`.
- [ ] **Step 2: Test** `claude_conn_initialize_maps_commands_and_models`: `initialize` trả `loadSession: true`; handler nhận `available_commands_update` có lệnh `review`; `config_options()[0]["id"] == "model"`; `new_session` trả id của fake.
- [ ] **Step 3: Test** `claude_conn_crash_mid_turn_fails_turn` (Review Focus 2): `[Text("a"), Crash]` → `prompt_turn` là `Err` chứa "đã dừng".
- [ ] **Step 4: Test** `claude_conn_ignores_unknown_messages` (Review Focus 3): chèn `Line(json!({"type":"brand_new","x":1}))` và `Line(json!({"type":"system","subtype":"weird"}))` trước `Result` → lượt vẫn `end_turn`.
- [ ] **Step 5:** Run `(cd src-tauri && cargo test claude_conn)`. Expected: FAIL (chưa có `ClaudeConn`).
- [ ] **Step 6:** Implement `ClaudeConn` và `fake_claude`. Một task đọc stdout; control request đang chờ giữ trong `HashMap<request_id, oneshot::Sender<Value>>`; lượt đang chạy giữ một `oneshot` chờ `result`.
- [ ] **Step 7:** Run `(cd src-tauri && cargo test claude_conn)`. Expected: PASS.
- [ ] **Step 8:** Commit `feat(acp): ClaudeConn dịch stream-json của claude -p sang ACP`.

---

### Task 3: Tool call và xin duyệt qua `can_use_tool`

**Files:**
- Modify: `src-tauri/src/acp/claude_conn.rs`, `src-tauri/src/acp/fake_claude.rs`, `src-tauri/src/tasks/session.rs` (ngoại lệ thư mục plans ở `Approval::Deny`)
- Test: `src-tauri/src/acp/claude_conn.rs`, `src-tauri/src/tasks/session.rs`

**Interfaces:**
- Consumes: `TaskSession` là `ClientHandler` (`on_request("session/request_permission", params)` trả `{outcome:{outcome:"selected",optionId}}` hoặc `cancelled`).
- Produces: `fn tool_call_of(tool_use: &Value) -> Value` (trong `claude_conn.rs`): `{ toolCallId, title, kind, status:"in_progress", rawInput, content? }`. `kind` và `title` theo `toolInfoFromToolUse` của claude-agent-acp (Bash → `execute`, `rawInput.command`; Read → `read`; Edit/Write/MultiEdit → `edit` với `content: [{type:"diff", path, oldText, newText}]`; Grep/Glob → `search`; WebFetch/WebSearch → `fetch`; còn lại `other`), để `policy::tool_info` và `describe-line.ts` đọc như với adapter.

Dịch:
- `assistant` có khối `tool_use` → `session/update` `tool_call` (= `tool_call_of`).
- `user` có khối `tool_result` → `session/update` `tool_call_update` `{ toolCallId, status: "completed" | "failed" (is_error), content: [{ type:"content", content:{ type:"text", text } }] }`, `text` cắt còn ≤ 20 000 ký tự (giữ phần cuối, thêm "…" đầu).
- `control_request` `can_use_tool` (`request.tool_name`, `request.input`, `request.tool_use_id`) → `handler.on_request("session/request_permission", { sessionId, toolCall: tool_call_of(…), options: [{optionId:"allow",kind:"allow_once",name:"Cho phép"},{optionId:"allow_always",kind:"allow_always",name:"Luôn cho phép"},{optionId:"reject",kind:"reject_once",name:"Từ chối"}] })` → `control_response` `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow","updatedInput":<input>}}}` cho allow/allow_always, `{"behavior":"deny","message":"Người dùng đã từ chối."}` cho reject / cancelled.

**[Cần kiểm chứng]** hình dạng `can_use_tool` và câu trả lời: đối chiếu `PermissionResult` và `SDKControlPermissionRequest` trong tài liệu Agent SDK TypeScript (`code.claude.com/docs/en/agent-sdk/typescript.md`) và mã SDK nếu tải được (`npm view @anthropic-ai/claude-agent-sdk`); ghi kết quả vào đầu `claude_conn.rs`.

- [ ] **Step 1: Test** `claude_conn_tool_call_and_result`: fake phát `assistant` với `tool_use` Bash `{"command":"npm test"}`, rồi `user` với `tool_result` "ok" → handler nhận `tool_call` có `kind == "execute"`, `rawInput.command == "npm test"`, rồi `tool_call_update` `status == "completed"`.
- [ ] **Step 2: Test** `tool_result_is_truncated` (Review Focus 4): `tool_result` 1 000 000 ký tự → text trong `tool_call_update` ≤ 20 001 ký tự và kết thúc bằng phần cuối của chuỗi gốc.
- [ ] **Step 3: Test** `claude_permission_routes_through_task_session` trong `tasks/tests.rs`: `TaskSession` thật làm handler, `Ask { tool:"Bash", input:{"command":"rm -rf build"} }`; với `Approval::Ask` → event `permission` phát ra, `respond_permission(id,"allow",false)` → fake nhận `behavior == "allow"`; với `Approval::Deny` → fake nhận `behavior == "deny"` không có event `permission`; với `Approval::Auto` và lệnh trong danh sách cấm của `policy.rs` → `deny`.
- [ ] **Step 4: Test** `deny_allows_only_claude_plan_files` trong `session.rs`: `Approval::Deny`, yêu cầu Write `file_path = <home>/.claude/plans/x.md` → allow; `<home>/.claude/plans/../settings.json` và `/tmp/x` → deny.
- [ ] **Step 5:** Run `(cd src-tauri && cargo test claude_)`. Expected: FAIL.
- [ ] **Step 6:** Implement trong `claude_conn.rs`; ngoại lệ plans trong `TaskSession::permission` (chỉ khi `self.agent == AgentKind::Claude`, `kind == "edit"`, đường dẫn chuẩn hoá nằm trong `dirs::home/.claude/plans`).
- [ ] **Step 7:** Run lại. Expected: PASS.
- [ ] **Step 8:** Commit `feat(acp): tool call và xin duyệt của Claude qua can_use_tool`.

---

### Task 4: Dừng lượt, đổi chế độ, đổi model

**Files:**
- Modify: `src-tauri/src/acp/claude_conn.rs`, `src-tauri/src/tasks/session.rs`, `src-tauri/src/tasks/mod.rs` (`set_approval`)

**Interfaces:**
- Produces:
  - `ClaudeConn::cancel` gửi `control_request` `interrupt`; lượt đang chạy kết thúc với `stopReason: "cancelled"` khi `result` đến.
  - `ClaudeConn::set_mode(approval)` gửi `set_permission_mode` với `Deny → "plan"`, `Ask → <mode hỏi>`, `Auto → "acceptEdits"`.
  - `ClaudeConn::set_config_option(_, "model", v)` gửi `set_model` `{model: v}`.
  - `TaskSession::set_mode_hook(&self, hook: Arc<dyn Fn(Approval) -> Result<(), String> + Send + Sync>)`; `TaskSession::set_approval` đổi quyền **và** gọi hook nếu có.

**Bước kiểm chứng (0 token):** chạy `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompts host` trong một thư mục tạm, gửi `initialize`, rồi `set_permission_mode` lần lượt `"default"` và `"manual"`; mode nào trả `success` là `<mode hỏi>`. Ghi kết quả vào comment cạnh hằng số.

- [ ] **Step 1: Test** `interrupt_when_idle_is_harmless` (Review Focus 5): gọi `cancel` hai lần khi không có lượt → `Ok`; lượt kế tiếp vẫn `end_turn`.
- [ ] **Step 2: Test** `interrupt_ends_turn_as_cancelled`: fake `[Text("a"), WaitForControl("interrupt"), Result{stop:"success",…}]`, gọi `cancel` giữa lượt → `stopReason == "cancelled"`.
- [ ] **Step 3: Test** `set_mode_sends_permission_mode`: `set_mode(Deny)` → log fake có `set_permission_mode` `mode == "plan"`; `Auto` → `"acceptEdits"`.
- [ ] **Step 4: Test** `set_approval_calls_mode_hook` (session.rs): hook ghi lại đối số; `set_approval(Approval::Deny)` → hook nhận `Deny`, `approval() == Deny`.
- [ ] **Step 5:** Run `(cd src-tauri && cargo test interrupt set_mode set_approval)`. Expected: FAIL.
- [ ] **Step 6:** Implement.
- [ ] **Step 7:** Run lại. Expected: PASS.
- [ ] **Step 8:** Commit `feat(acp): dừng, đổi chế độ và model giữa phiên Claude`.

---

### Task 5: Subagent và hạn mức của Claude

**Files:**
- Modify: `src-tauri/src/acp/claude_conn.rs`, `src-tauri/src/acp/fake_claude.rs`

**Interfaces:**
- Consumes: `TaskSession::on_notification("session/update", {update:{sessionUpdate:"subagent_update", sessionId, title, state:{state}}})` và cập nhật có `sessionId` của phiên con → run `<cha>~n` (đã có, `subagent_update` / `subagent_event` trong `session.rs`).

Dịch:
- `system` subtype `task_started` (`task_id`, `description`) → `subagent_update` `{ sessionId: task_id, title: description, state:{state:"running"} }`.
- Message có `parent_tool_use_id` (hoặc `agent_id`) khác null → cùng các bản dịch ở Task 2–3 nhưng `sessionId` = id của subagent đó (ánh xạ `parent_tool_use_id → task_id` lấy từ `task_started` / `tool_use` Agent).
- `task_notification` (`status` completed/failed/stopped) → `subagent_update` `state:"idle"`.
- `rate_limit_event` → `usage_update` có `_meta["_claude/rateLimit"]` đúng hình dạng mà `usage::parse_rate_limit` đọc (đối chiếu claude-agent-acp), `used`/`size` lấy lại giá trị cuối.

**[Cần kiểm chứng]** tên trường `task_started` / `task_notification` / `agent_id`: đối chiếu tài liệu `code.claude.com/docs/en/agent-sdk/subagents.md`; trường không có thì bỏ qua, không lỗi.

- [ ] **Step 1: Test** `claude_subagent_becomes_child_run` (tasks/tests.rs, `TaskSession` thật + `Recorder`): fake phát `task_started{task_id:"t1",description:"Tìm lỗi"}`, một `assistant` text "đã xem" có `parent_tool_use_id` của t1, rồi `task_notification{task_id:"t1",status:"completed"}` → sink có `child_run` id `<run>~1` tiêu đề "Tìm lỗi", event `message` "đã xem" cho `<run>~1`, `child_finished(<run>~1,"done")`.
- [ ] **Step 2: Test** `claude_rate_limit_emits_limits`: fake phát `rate_limit_event` mẫu (lấy từ fixture stream-json thật nếu có, không thì theo tài liệu) → event `limits` có cửa sổ 5 giờ.
- [ ] **Step 3:** Run, thấy FAIL; implement; run lại thấy PASS.
- [ ] **Step 4:** Commit `feat(acp): subagent và hạn mức của Claude qua ClaudeConn`.

---

### Task 6: Nối `ClaudeConn` vào `start_task`, Chỉ hỏi của Claude làm thẳng

**Files:**
- Modify: `src-tauri/src/agents/adapters.rs` (`native_args`), `src-tauri/src/tasks/mod.rs` (`place_for`, `start_task_with`, chọn conn), `src-tauri/src/tasks/warm.rs`, `src-tauri/src/integrations/mcp.rs` (nếu cần hàm tạo tệp cấu hình cho task), `CLAUDE.md`, `docs/ARCHITECTURE.md`
- Test: `src-tauri/src/agents/adapters.rs`, `src-tauri/src/tasks/tests.rs`, live test mới trong `src-tauri/src/tasks/tests.rs` (`#[ignore]`)

**Interfaces:**
- Consumes: `ClaudeConn::start` (Task 2), `AgentConn` (Task 1), `TaskSession::set_mode_hook` (Task 4).
- Produces:
  - `AgentKind::native_args(self, approval: Approval, resume: Option<&str>, mcp_config: Option<&Path>, model: Option<&str>) -> Option<Vec<String>>`: `Some` chỉ cho Claude; luôn có `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompts host --permission-mode <theo Task 4>`, thêm `--resume <id>`, `--mcp-config <path>`, `--model <m>` khi có.
  - `fn uses_native(agent: AgentKind) -> bool`: `agent == Claude && env TG_CLAUDE_ACP != "1"`.
  - `place_for`: `(None, Approval::Deny, _)` → `Place::Direct` khi `uses_native(agent)` (thêm tham số `agent`), giữ `Place::Draft(None)` cho agent khác.

Luồng: khi `uses_native`, `start_task_with` dựng lệnh bằng `native_args` (resume lấy từ phiên cũ như hiện nay; MCP + tg-bridge ghi ra `mcp::ConfigFile`, giữ tệp sống tới khi run kết thúc), spawn bằng `spawn_adapter` (vẫn qua `env::command`), tạo `ClaudeConn::start(stdout, stdin, session)` thay cho `AcpClient::start`, đăng ký `session.set_mode_hook(…conn.set_mode…)`. Phiên mở sẵn (`warm.rs`) của Claude: spawn `native_args(Ask, None, cfg, None)` và gọi `initialize` + `new_session` như với ACP; khi lấy ra, `set_mode(approval)` theo chế độ thật.

- [ ] **Step 1: Test** `native_args_always_pin_mode_and_host` (Review Focus 1) trong `adapters.rs`: với mọi `Approval`, args chứa cặp `--permission-prompts host` và `--permission-mode <m>` đúng ánh xạ; `Deny` → `plan`; `resume = Some("s1")` → có `--resume s1`; không bao giờ chứa chuỗi `"mcpServers"` (JSON trên dòng lệnh).
- [ ] **Step 2: Test** `claude_question_works_in_place` trong `tasks/tests.rs`: `place_for(AgentKind::Claude, Approval::Deny, Some("direct"), None, None) == Place::Direct`; `AgentKind::Gemini` cùng tham số → `Place::Draft(None)`.
- [ ] **Step 3: Live test** (`#[ignore]`, `TG_LIVE_ACP=1`): `live_claude_native_two_questions` (hai câu, câu hai nhắc lại câu một), `live_claude_native_read_only_cannot_write` (Chỉ hỏi, bảo ghi `x.txt` → tệp không tồn tại), `live_claude_native_mode_switch_keeps_memory` (Chỉ hỏi → `set_approval(Ask)` → bảo tạo tệp → có event `permission`, cho phép → tệp có), theo khuôn `live_claude_*` hiện có.
- [ ] **Step 4:** Run `(cd src-tauri && cargo test native_args claude_question)`. Expected: FAIL; implement; run lại PASS. Live test chỉ chạy được trên máy có tài khoản Claude (chủ repo); trong container chỉ cần biên dịch qua `cargo test --no-run`.
- [ ] **Step 5:** Cập nhật `CLAUDE.md` (mục "Những điểm cần đọc nhiều file mới thấy": `ClaudeConn`, `AgentConn`, `TG_CLAUDE_ACP`, Chỉ hỏi của Claude là task `deny` làm thẳng) và `docs/ARCHITECTURE.md` (sơ đồ đường chạy).
- [ ] **Step 6:** Run đủ `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`. Expected: PASS.
- [ ] **Step 7:** Commit `feat(tasks): Claude chạy qua claude -p cho mọi chế độ`.

---

### Task 7: UI — Chỉ hỏi của Claude là task, đổi chế độ giữa phiên, "Làm luôn" cùng phiên

**Files:**
- Modify: `src/app/services/runs/runs.service.ts` (`start`, `setApproval`), `src/app/features/chat/chat.state.ts` (gửi tin theo chế độ, `resumeChoice`), `src/app/features/chat/composer/*` (bộ chọn chế độ gọi đổi giữa phiên), `src/app/features/chat/dock/proposal-card.ts` (Làm luôn), `src/app/core/mock/*` (MockBackend: `startTask` với `approval:'deny'`), `src/app/services/agents/agent-meta.ts` (nếu cần cờ `liveModes`)
- Test: `src/app/services/runs/runs.service.spec.ts`, `src/app/features/chat/agent-panel.spec.ts`

**Interfaces:**
- Consumes: `AgentBackend.startTask(… approval …)`, `AgentBackend.setApproval(runId, approval)` (đã có; Rust `set_approval` nhận cả `deny` từ Task 6).
- Produces:
  - `canSwitchLive(run: Run, to: Approval): boolean` (thuần, `services/runs/run.ts`): `true` khi run là task đang sống (`status` `running`/`idle`, không `restored`) và (agent là Claude **hoặc** cả hai chế độ khác `deny`). Gemini/Kiro/Codex từ/tới `deny` → `false`.
  - `RunsService.start(agent, prompt, cwd, …)`: Claude → `startTask(agent, prompt, cwd, { approval: 'deny', place: 'direct', thread, scope })`; agent khác giữ đường cũ.
  - Đổi chế độ ở ô chat: `canSwitchLive` → `setApproval`; không thì giữ cách hiện tại (run mới cùng `thread` + recap) và thêm dòng ghi chú "Đã mở phiên mới để cho phép sửa code" bằng `RunsService.note`.
  - "Làm luôn": run Claude đang sống → `setApproval(run.id, 'ask')` rồi `sendMessage(run.id, <kế hoạch>)`; không sống thì giữ cách cũ.

- [ ] **Step 1: Test** `canSwitchLive` (spec mới cạnh `run.ts`): Claude idle `deny → ask` true; Codex idle `deny → ask` false; Codex idle `ask → auto` true; Claude `restored` false.
- [ ] **Step 2: Test** trong `runs.service.spec.ts`: `start('claude', …)` gọi `backend.startTask` với `approval: 'deny'`, `place: 'direct'`; `start('codex', …)` gọi `backend.start`.
- [ ] **Step 3: Test** trong `agent-panel.spec.ts`: run Claude idle ở Chỉ hỏi, chọn Hỏi trước → `backend.setApproval(id,'ask')` được gọi, không có `startTask` mới; Codex cùng thao tác → `startTask` mới + dòng ghi chú.
- [ ] **Step 4: Test** "Làm luôn" với run Claude idle có `proposal` → `setApproval('ask')` rồi `sendMessage` chứa kế hoạch, không `startTask`.
- [ ] **Step 5:** Run `npm test -- --watch=false`. Expected: FAIL; implement; run lại PASS.
- [ ] **Step 6:** Chạy `npm start`, dùng Playwright mở app ở mock mode, gửi một câu ở Chỉ hỏi, đổi sang Hỏi trước, gửi câu nữa; chụp màn hình xác nhận cùng một cuộc trò chuyện, không có "Đã mở phiên mới". Lưu ảnh vào thư mục scratchpad, không commit.
- [ ] **Step 7:** Run đủ `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`. Expected: PASS.
- [ ] **Step 8:** Commit `feat(chat): đổi chế độ giữa phiên, Chỉ hỏi của Claude cùng phiên với Sửa code`.
