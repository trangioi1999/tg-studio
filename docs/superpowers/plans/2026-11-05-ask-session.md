# Phiên Chỉ hỏi sống của Claude

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ở Chỉ hỏi, Claude giữ một tiến trình `claude` cho cả cuộc trò chuyện như CLI tương tác: câu tiếp theo không khởi động lại CLI, không nạp lại phiên, không chạy lại hook `SessionStart`; chữ chạy ra theo thời gian thực.

**Architecture:** `start_agent` của Claude chạy `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode plan`, gửi câu đầu qua stdin và giữ stdin mở. Mỗi dòng `result` kết thúc một câu: lõi phát `turn_end`, run về `idle`. `send_message` nhận cả run headless: ghi câu tiếp vào stdin. Hết `IDLE_LIMIT` không có câu mới thì đóng stdin, CLI thoát mã 0, run `done`. Codex giữ nguyên (mỗi câu một `codex exec resume`).

**Plan đi cùng:** `2026-11-05-stream-reveal.md` (Task 2–4 do Codex làm song song).

## Đo đạc (2026-11-05, Claude Code 2.1.318)

- Lịch sử app (SQLite, hai lượt "hello" của chủ repo ở Chỉ hỏi): `claude -p --resume` mất **2,5 s** tới dòng `init` ở mỗi câu; câu trả lời đến cả khối lúc 4,7 s và 7,3 s.
- Một tiến trình nhận hai câu qua stdin (`scratchpad` probe): câu thứ hai có chữ đầu sau **2,3 s** kể từ lúc gửi, có `system:init` lặp lại ở đầu mỗi câu, `result` cuối mỗi câu, đóng stdin thì thoát mã 0.
- Usage trong một tiến trình: `result.usage` là của **từng câu**, `total_cost_usd` **cộng dồn** theo tiến trình (0,201 → 0,209), giống adapter ACP.
- Warm trước câu đầu cho Chỉ hỏi: 4 lần đo, chênh lệch nằm trong dao động của API (3,6–7,3 s). Không làm.

## Global Constraints

- Lệnh Chỉ hỏi của Claude luôn có `--permission-mode plan` (test `read_only_runs_are_blocked_from_writing_by_the_cli`, live `live_read_only_run_cannot_write`).
- Mọi thay đổi định dạng usage phải kèm unit test trong `usage.rs`.
- Tiến trình con qua `env::command`, `.env("PATH", env::login_path())`, `env::isolate`.
- Chuỗi hiển thị cho người dùng viết tiếng Việt.
- `AgentBackend` không đổi chữ ký: `sendMessage` đã có.
- Trước khi xong: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`.

## Review Focus

1. Câu thứ hai trong cùng tiến trình: usage cộng đúng (token cộng, chi phí lấy số cộng dồn của CLI), không đếm hai lần, `cumulative: true`.
2. Dừng giữa câu: kill tiến trình, run `stopped` như trước; câu sau mở tiến trình mới với `--resume`.
3. Prompt có xuống dòng trên Windows (`.cmd`): giờ đi qua stdin dạng JSON nên không còn cần nhánh batch riêng cho Claude.
4. Gửi câu khi run đang trả lời → lỗi "Agent đang chạy", không ghi chồng vào stdin.
5. Tiến trình chết khi đang `idle` → `exit` đến, `send_message` sau đó báo "Phiên này đã đóng." và UI mở run mới với `--resume`.
6. Lịch sử: run nạp lại sau khi mở app không còn tiến trình, câu tiếp đi đường `--resume` như cũ.

## Chia việc

| Task | Người làm | File |
|---|---|---|
| 1. Cờ CLI + fixture | Claude | `adapters.rs`, `tests/fixtures/claude/2.1.318/ask-session.jsonl` |
| 2. Cộng usage nhiều câu | Claude | `usage.rs` |
| 3. Phiên sống trong `runner.rs` + `send_message` | Claude | `runner.rs`, `acp_tasks.rs` (`send_message`), `lib.rs` |
| 4. UI gửi câu tiếp vào phiên Chỉ hỏi | Claude | `shell/agent-panel.ts` (+ spec), `core/mock-backend.ts` |
| stream-reveal 2–4 | Codex | xem plan kia |
| 5. Review chéo, live test, build app | Claude + Codex | — |

---

### Task 1: Cờ CLI

- [ ] Test: `headless_args(Claude)` = `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode plan`, **không** có prompt trong args. `headless_input(Claude, prompt)` trả dòng JSON `{"type":"user","message":{"role":"user","content":prompt}}\n` (đúng ký tự xuống dòng trong prompt được escape). Codex giữ nguyên.
- [ ] `headless_invocation`: Claude luôn trả `(args, Some(input))`; nhánh batch chỉ còn cho Codex.
- [ ] `resume_args` Claude vẫn nối `--resume <id>`; test resume vẫn có `--permission-mode plan`.

### Task 2: Usage nhiều câu

- [ ] `usage::SessionTotals` (`add(&Usage) -> Usage`): cộng `input_tokens`, `cached_input_tokens`, `output_tokens` qua các câu; `cost_usd` lấy số mới nhất (CLI đã cộng dồn); kết quả `cumulative: true`.
- [ ] Test `claude_ask_session_fixture_usage`: chạy `parse_line` trên mọi dòng fixture, ra đúng **hai** `Usage` (hai dòng `result`), qua `SessionTotals` thì token = tổng hai câu, cost = `total_cost_usd` của dòng cuối. Các `stream_event` có `usage` không bị đếm.

### Task 3: Phiên sống trong `runner.rs`

- [ ] `HeadlessSessions` (state): `run_id → Arc<HeadlessSession { stdin: tokio::Mutex<Option<ChildStdin>>, busy: AtomicBool }>`; chỉ Claude.
- [ ] Vòng đọc stdout: dòng `result` → phát `usage` qua `SessionTotals`, rồi `log`, rồi `turn_end` `{status: "done" | "failed"}` (`is_error`), `busy = false`, `set_run_status(idle)`, hẹn giờ idle (thế hệ tăng mỗi câu). Hết giờ → đóng stdin.
- [ ] `send_headless(app, run_id, prompt) -> Option<Result<(), String>>` trong `runner.rs`; `acp_tasks::send_message` gọi nó trước. Đang bận → "Agent đang chạy. Hãy chờ hoặc dừng trước."; stdin đã đóng → "Phiên này đã đóng.". Phát event `user` như ACP, `set_run_status(running)`.
- [ ] `exit` dọn `HeadlessSessions`. `stop_agent` giữ nguyên (kill).
- [ ] Live test `live_claude_ask_session_two_questions` (`#[ignore]`, `TG_LIVE_ACP`): hai câu trong một tiến trình, câu hai nhớ câu một, có hai `turn_end`, tệp trong thư mục không đổi.

### Task 4: UI

- [ ] `AgentPanel.send()`: Chỉ hỏi qua CLI, run hiện tại không phải task, cùng agent, `status === 'idle'` → `runs.sendMessage`. Còn lại giữ nguyên (run mới với `resumeFrom`).
- [ ] `MockBackend`: run headless của Claude cũng nhận `sendMessage` và trả lời bằng `turn_end` (đủ để spec chạy).
- [ ] Spec: câu thứ hai ở Chỉ hỏi với Claude gửi vào run cũ, không gọi `start`; với Codex vẫn gọi `start` với `resumeFrom`.
- [ ] `CLAUDE.md`: sửa mục "Chỉ hỏi chạy trên thư mục thật" và "Phiên nhiều câu".
