# Khởi động sẵn phiên agent (warm session)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Câu đầu tiên của một cuộc trò chuyện Sửa code trả lời nhanh ngang CLI đã mở sẵn (~2–3 s thay vì ~8 s).

**Architecture:** Khi người dùng bắt đầu gõ vào ô chat của một cuộc trò chuyện mới, lõi mở trước adapter ACP và `session/new` (không prompt, không tốn token) rồi giữ trong `WarmPool`. `start_task` lấy phiên đó nếu khớp khoá, bỏ qua bước spawn + initialize + session/new; nếu không khớp thì đi đường cũ. Adapter được khởi động trước khi có run, nên handler của `AcpClient` là `LateHandler` (gắn `TaskSession` sau) và token tg-bridge được giữ chỗ trước (`reserve`, gắn `ToolEnv` bằng `bind`).

**Tech Stack:** Tauri 2, Rust (tokio), Angular 22 signals, Vitest.

## Đo đạc (2026-11-05, máy chủ repo, `claude-agent-acp@0.100.0` đã cài global)

| Bước | Thời gian |
|---|---|
| spawn adapter + `initialize` + `session/new` (`sdk-initialize` của adapter ≈ 4,0 s) | ~4,8 s |
| `session/prompt` "hello" → token đầu | ~2,5 s |
| Tổng tới khi xong | ~8,0 s |
| `claude -p hello` (một lần, cold) | ~10 s |

CLI tương tác chỉ thấy 2 s vì nó khởi động trước khi người dùng gõ. Phần trả lời của hai bên như nhau; chênh lệch nằm hoàn toàn ở khởi động. Trước đó adapter chạy qua `npx -y` mỗi lần, cài global đã bỏ được phần đó.

## Phạm vi

Có warm: một agent, chế độ Sửa code (hoặc Chỉ hỏi qua ACP với quyền khác `deny`), nơi làm việc `direct`, cuộc trò chuyện mới hoặc run hiện tại không còn phiên sống và không cần `reuse`.

Không warm (đi đường cũ): `draft` (worktree chỉ tạo khi gửi), nhiều agent, Pipeline, nối lại phiên (`reuse`/`session/load`), Chỉ hỏi headless (`runner.rs`), `approval = deny`.

**Khoá khớp:** `agent` + `start_dir` (repo đã chuẩn hoá + `scope`) + dấu vân tay danh sách MCP server (không gồm tg-bridge) + tg-bridge bật/tắt. `prefs` (model, effort) áp lúc nhận bằng `options::apply`; `approval` là trạng thái của `TaskSession`, nên không thuộc khoá.

**Vòng đời:** tối đa một phiên warm (app chỉ có một ô chat). Warm mới với khoá khác → huỷ cái cũ. Khoá giống → giữ nguyên. Không ai nhận sau `WARM_TTL = 10 phút` → kill. Adapter chết khi đang chờ → bỏ khỏi pool. App thoát → `kill_on_drop`.

## Global Constraints

- Mọi tiến trình con qua `env::command`; adapter chạy với `.env("PATH", env::login_path())` và `env::isolate`.
- Chuỗi hiển thị cho người dùng, kể cả lỗi Rust, viết tiếng Việt.
- Thêm phương thức vào `AgentBackend` thì cài ở cả `TauriBackend` và `MockBackend`; lệnh Tauri mới đăng ký trong `generate_handler!`.
- Warm là tối ưu: mọi lỗi warm chỉ ghi `eprintln!`, không bao giờ hiện cho người dùng hay làm hỏng lượt gửi. Gửi khi warm chưa xong thì chờ phiên đó (không mở phiên thứ hai).
- Trước khi xong: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`.

## Review Focus

1. Gửi khi warm đang mở dở → dùng đúng phiên đó, chỉ một adapter chạy.
2. Đổi agent / scope / MCP server sau khi warm → `start_task` không dùng phiên sai, phiên cũ bị kill.
3. Notification adapter gửi trước khi có run (`available_commands_update`) được phát lại sau khi gắn, không mất, không trùng.
4. Yêu cầu từ agent trước khi gắn handler → trả lỗi, không treo.
5. Adapter chết trước khi gắn → `start_task` rơi về đường cũ, không báo lỗi.
6. Token tg-bridge đã reserve nhưng chưa bind → tool trả "Phiên tg-bridge không còn hiệu lực.", sau bind thì chạy.

## Chia việc

| Task | Người làm | File |
|---|---|---|
| 1. `LateHandler` | **Codex** | `src-tauri/src/acp/late.rs` (mới), `src-tauri/src/acp/mod.rs` |
| 2. `BridgeHub::reserve/bind` | **Codex** | `src-tauri/src/bridge.rs` |
| 3. `drive_session` nhận phiên đã mở + `prepare` không spawn | Claude | `src-tauri/src/acp_tasks.rs` |
| 4. `WarmPool` + lệnh `warm_task` | Claude | `src-tauri/src/warm.rs` (mới), `lib.rs`, `acp_tasks.rs` |
| 5. UI gọi warm | Claude | `core/backend.ts`, `core/tauri-backend.ts`, `core/mock-backend.ts`, `core/runs.service.ts`, `shell/agent-panel.ts` + spec |
| 6. Review chéo, build, đo lại, cập nhật `CLAUDE.md` | Claude review Codex, Codex review Claude | — |

Task 1 và 2 chạy song song với Task 3 (không chung file). Task 4 cần 1–3.

---

### Task 1: `LateHandler` (Codex)

**Files:** tạo `src-tauri/src/acp/late.rs`; sửa `src-tauri/src/acp/mod.rs` (thêm `pub mod late;`).

`ClientHandler` mà đích thật được gắn sau khi `AcpClient` đã chạy.

```rust
pub struct LateHandler { /* Mutex<State> */ }
impl LateHandler {
    pub fn new() -> Arc<Self>;
    /// Gắn đích. Phát lại theo thứ tự mọi notification đã đệm, rồi chuyển thẳng.
    /// Nếu adapter đã đóng trước khi gắn: phát lại phần đệm rồi gọi `target.on_closed()` đúng một lần.
    /// Gắn lần hai: trả Err, không đổi đích.
    pub fn attach(&self, target: Arc<dyn ClientHandler>) -> Result<(), String>;
    pub fn is_closed(&self) -> bool;
}
impl ClientHandler for LateHandler { ... }
```

Quy tắc:
- Trước khi gắn: `on_notification` đệm tối đa `BUFFER = 256` cái, quá thì bỏ cái cũ nhất. `on_request` trả ngay `Err(RpcError)` code `-32603`, message "TG Studio chưa sẵn sàng." `on_closed` ghi lại trạng thái đã đóng.
- Sau khi gắn: chuyển thẳng cả ba sang đích. Không giữ lock khi gọi vào đích (đích có thể gọi lại).
- Phát lại phải xong trước mọi notification đến sau `attach` (giữ thứ tự): giữ lock suốt lúc phát lại hoặc dùng cờ, miễn có test chứng minh.

Test (trong `late.rs`, `#[cfg(test)]`, handler ghi nhận giả):
- [ ] notification trước attach được phát lại đúng thứ tự, sau attach đi thẳng
- [ ] request trước attach trả lỗi -32603; sau attach đi tới đích
- [ ] closed trước attach → attach phát lại rồi gọi `on_closed` đúng 1 lần; closed sau attach → 1 lần
- [ ] đệm quá 256 giữ 256 cái mới nhất
- [ ] attach lần hai trả Err
- [ ] notification đến từ luồng khác trong lúc attach đang phát lại vẫn đúng thứ tự (thread + barrier)
- [ ] `(cd src-tauri && cargo test --offline acp::late)` xanh, `cargo test --offline` toàn bộ xanh

### Task 2: `BridgeHub::reserve` / `bind` (Codex)

**Files:** `src-tauri/src/bridge.rs`.

```rust
/// Token mới chưa gắn môi trường; gọi tool bằng token này trả "Phiên tg-bridge không còn hiệu lực." cho đến khi bind.
pub fn reserve(&self) -> String;
/// Gắn môi trường cho token đã reserve. Err nếu token không phải do reserve tạo ra hoặc đã bind/unregister.
pub fn bind(&self, token: &str, env: Arc<dyn ToolEnv>) -> Result<(), String>;
```

`register` giữ nguyên hành vi (có thể viết lại bằng `reserve` + `bind`). `unregister` xoá cả token đã reserve chưa bind.

Test:
- [ ] reserve rồi gọi tool qua `serve` (TCP thật trên 127.0.0.1 như các test hiện có) → lỗi "không còn hiệu lực"; bind rồi gọi → chạy
- [ ] bind token lạ → Err; bind hai lần → Err; unregister rồi bind → Err
- [ ] `(cd src-tauri && cargo test --offline bridge)` và toàn bộ xanh

### Task 3: `drive_session` nhận phiên đã mở (Claude)

**Files:** `src-tauri/src/acp_tasks.rs`.

- `SessionPlan` thêm `opened: Option<String>` (session id đã mở sẵn). Có thì bỏ `initialize`/`new_session`, gọi `on_opened`, áp `prefs`, rồi chạy lượt như cũ.
- Tách `prepare` thành `prepare_run` (worktree + bản ghi run, không spawn) và phần spawn `spawn_adapter(command, dir)` dùng chung cho `warm.rs`.
- Test bằng `acp/fake.rs`: phiên mở trước bằng `client.new_session`, `drive_session` với `opened` không gửi `initialize`/`session/new` lần nữa và vẫn ra `done`.

### Task 4: `WarmPool` + `warm_task` (Claude)

**Files:** tạo `src-tauri/src/warm.rs`; sửa `lib.rs` (state + `generate_handler!`), `acp_tasks.rs` (`start_task` lấy từ pool).

- `warm_task(agent, repo, scope)`: tính khoá, nếu pool đã có khoá này thì xong; nếu khác thì kill cái cũ; spawn adapter ở `start_dir`, `LateHandler`, `initialize`, `mcp::for_acp`, `new_session` (gồm `require_approvals`). Token tg-bridge lấy bằng `reserve`. stderr đệm đuôi 50 dòng cho đến khi gắn, sau đó phát event `stderr` như cũ.
- Pool giữ `Shared` future của bước mở phiên, để `start_task` gửi giữa chừng thì `await` đúng phiên đó.
- `start_task`: điều kiện ở mục Phạm vi + khoá khớp → `take()`; `prepare_run`; `TaskSession::new`; `late.attach(session)`; `hub.bind(token, TaskEnv)`; `drive_session` với `opened`. Lấy hụt (khác khoá, adapter chết, mở lỗi) → đường cũ, không báo lỗi.
- TTL 10 phút bằng `tokio::time::sleep` gắn thế hệ (generation) của mục trong pool.

### Task 5: UI (Claude)

- `AgentBackend.warmTask(agent, repo, scope): Promise<void>`; Tauri gọi `warm_task`; Mock không làm gì.
- `RunsService.warm(agent, repo, scope)` nuốt mọi lỗi.
- `AgentPanel`: khi ô chat có chữ lần đầu (và khi đổi agent/scope trong lúc ô chat có chữ), nếu thoả Phạm vi và không có phiên sống để gửi tiếp (`liveSession` sai) thì gọi `warm`. Gọi lặp với cùng khoá là vô hại (lõi bỏ qua).
- Spec: gõ chữ trong ô chat của cuộc trò chuyện mới → backend nhận `warmTask` đúng agent/repo/scope; khi có phiên sống hoặc place `draft` → không gọi.

### Task 6: Kiểm chứng

- [ ] Codex review diff Task 3–5, Claude review Task 1–2.
- [ ] `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)` xanh.
- [ ] `npm run build:app`, đo lại "hello" trên app: kỳ vọng ≤ 3,5 s nếu gõ xong sau khi warm kịp xong (~5 s).
- [ ] Thêm một dòng vào `CLAUDE.md` mục Kiến trúc về `WarmPool`.
