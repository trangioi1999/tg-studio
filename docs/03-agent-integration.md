# 03 · Tích hợp agent

Cách TG Studio khởi chạy, điều khiển và đọc kết quả của từng agent.

## 1. Hai cách nói chuyện với agent

| | Headless (GĐ0) | ACP (từ GĐ1) |
|---|---|---|
| Là gì | Chạy CLI một lần với cờ in JSON từng dòng | Agent Client Protocol — JSON-RPC 2.0 qua stdin/stdout, phiên dài |
| Ưu | Đơn giản, có usage chi tiết | Một client cho mọi agent; xin quyền, hủy, stream, đọc/ghi file qua app |
| Nhược | Không duyệt quyền được, mỗi CLI một định dạng | Usage chưa chuẩn hóa trong giao thức; Claude/Codex cần adapter |
| Dùng cho | Task chỉ-đọc, lấy usage | Mọi task có sửa code |

**Chiến lược:** ACP là đường chính. Headless giữ làm (a) dự phòng khi ACP lỗi, (b) nguồn usage khi ACP không trả.

## 2. Từng agent

| Agent | Binary | ACP | Headless | Usage | Đăng nhập |
|---|---|---|---|---|---|
| Claude Code | `claude` | qua adapter ACP (Claude Agent SDK, do Zed phát triển) | `claude -p … --output-format stream-json --verbose` | `result.usage` + `total_cost_usd` | gói Claude hoặc `ANTHROPIC_API_KEY` |
| Codex | `codex` | qua adapter ACP | `codex exec --json …` | `turn.completed.usage` | gói ChatGPT hoặc API key |
| Gemini CLI | `gemini` | có (xem `gemini --help` để biết cờ bật ACP) | `gemini -p … --output-format stream-json` | `result.stats` theo model | tài khoản Google hoặc API key |
| Kiro CLI | `kiro-cli` | `kiro-cli acp` (`--agent <tên>` để chọn cấu hình agent) | — | chưa có trong stream (xem `04-usage-and-cost.md`) | Builder ID / tài khoản Kiro |

Ghi chú:
- Danh sách agent hỗ trợ ACP và adapter: <https://agentclientprotocol.com/overview/agents>.
- Kiro quảng bá phần mở rộng riêng trong `agentCapabilities._meta.kiro.extensionMethods` ở phản hồi `initialize` — đọc từ đó thay vì hard-code. Docs: <https://kiro.dev/docs/cli/acp/>.
- Cờ và tên định dạng thay đổi theo phiên bản. **Ghim phiên bản đã test** trong app và cảnh báo khi người dùng chạy bản khác.

## 3. Giao thức ACP (v1) — phần TG Studio cần

Spec: <https://agentclientprotocol.com/protocol/v1/overview.md>

**App gọi agent:**

| Method | Khi nào |
|---|---|
| `initialize` | Ngay sau khi spawn; khai báo năng lực client (fs, terminal), nhận năng lực agent |
| `authenticate` | Nếu agent yêu cầu |
| `session/new` | Mở phiên với `cwd` = worktree của run, kèm danh sách MCP server |
| `session/load` | (tùy chọn) mở lại phiên cũ |
| `session/prompt` | Gửi yêu cầu; kết thúc khi agent xong turn |
| `session/set_mode` | (tùy chọn) đổi chế độ, ví dụ plan/edit |
| `session/cancel` | Notification — nút Dừng |

**Agent gọi app:**

| Method | TG Studio làm gì |
|---|---|
| `session/update` | Notification: chunk tin nhắn, tool call, plan, trạng thái → đẩy vào thread, timeline, terminal |
| `session/request_permission` | Hiện thẻ duyệt; trả lựa chọn người dùng (hoặc tự trả theo policy) |
| `fs/read_text_file`, `fs/write_text_file` | Đọc/ghi **chỉ trong worktree của run**; ghi xong cập nhật editor (con trỏ, vạch màu) |
| `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | Chạy lệnh trong PTY của app → hiện ở tab terminal của agent |

### Luồng một lượt chạy

```
spawn agent (cwd = worktree)
 → initialize
 → session/new { cwd, mcpServers: [tg-bridge, …] }
 → session/prompt { prompt }
    ← session/update (message / tool_call / plan …)   → UI
    ← session/request_permission                     → thẻ duyệt → trả lời
    ← fs/write_text_file                             → ghi trong worktree → editor
 ← kết quả prompt (stopReason)
 → (prompt tiếp, hoặc đóng phiên)
```

## 4. Module Rust dự kiến

```
src-tauri/src/
  acp/
    transport.rs   JSON-RPC 2.0 qua stdio: id, request/response, notification, timeout
    client.rs      initialize, session/*, cancel; route request từ agent sang handler
    handlers.rs    request_permission, fs/*, terminal/* (giới hạn trong worktree)
  agents/
    mod.rs         trait AgentAdapter { spawn_acp(), spawn_headless(), parse_usage() }
    claude.rs codex.rs gemini.rs kiro.rs
  worktree.rs
  policy.rs        quyền theo repo/bước pipeline
```

`AgentAdapter` là điểm mở rộng duy nhất: thêm agent = thêm một file implement trait.

## 5. Quyền (permission)

- Mỗi bước pipeline có bộ quyền: đọc file · ghi file trong worktree · chạy shell (Allow/Ask/Deny) · mạng · push/merge (luôn Never với agent).
- `request_permission` → so policy → nếu "Ask" thì hiện thẻ. Lựa chọn "Always allow" lưu theo **repo + agent + mẫu lệnh** (ví dụ `npm test *`).
- `fs/write_text_file` ra ngoài worktree → luôn từ chối.
- Headless: dùng cờ quyền của từng CLI ở mức chặt nhất (Claude `-p` mặc định từ chối thao tác cần duyệt).

## 6. Git worktree

```
<repo>/.tg/worktrees/<run-id>/      # thêm .tg/ vào .git/info/exclude
nhánh: tg/<agent>/<task-slug>-<run-id-ngắn>
```

- Tạo: `git worktree add -b <nhánh> <path> <base>` (base = HEAD nhánh người dùng lúc giao task).
- Merge queue: lấy `git diff <base>...<nhánh>`, hiện theo hunk; Accept = áp hunk vào nhánh làm việc của người dùng.
- Dọn: `git worktree remove` khi run đóng; nút "Giữ lại" để debug.
- Gọi `git` CLI thay vì libgit2 — worktree ổn định hơn, đúng cấu hình của người dùng.

## 7. Vòng đời tiến trình

- Mỗi run = 1 tiến trình con, `kill_on_drop`.
- Dừng: ACP `session/cancel` → chờ 5s → kill.
- Agent crash: run chuyển `failed`, giữ log, worktree giữ nguyên.
- Đóng app khi có run đang chạy: hỏi xác nhận; dừng tất cả.

## 8. Lưu ý theo hệ điều hành

| | macOS | Windows |
|---|---|---|
| PATH | App mở từ Finder không có PATH của terminal → hỏi login shell (`env.rs`) | PATH hệ thống thường đủ |
| Shim | — | CLI cài qua npm là `.cmd`; `which` thử `.exe/.cmd/.bat` |
| Terminal | PTY thường | ConPTY (`portable-pty`) |
| Đường dẫn | — | Có dấu cách, ký tự Unicode — luôn truyền như argument, không nối chuỗi shell |

## 9. Kiểm thử

- **Contract test:** ghi lại output thật của từng CLI (JSONL) vào `src-tauri/tests/fixtures/<agent>/<version>/`, test parser trên fixture.
- **ACP fake agent:** một agent giả viết bằng Rust nói ACP, kịch bản hóa được (xin quyền, ghi file, crash) để test client.
- **Smoke test thủ công** mỗi giai đoạn trên cả macOS và Windows với phiên bản CLI đã ghim.
