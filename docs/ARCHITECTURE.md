# Kiến trúc TG Studio

```
Angular UI (signals)
   │  invoke('start_agent' | 'stop_agent' | 'detect_agents' | 'open_project' | 'list_runs')
   │  listen('agent-event')
   ▼
Rust core (Tauri 2)
   ├─ detect.rs   tìm CLI trên login PATH
   ├─ runner.rs   1 tiến trình con / lượt chạy, stream từng dòng
   ├─ usage.rs    dòng JSON → Usage chuẩn hóa
   ├─ store.rs    lịch sử lượt chạy (SQLite)
   ├─ acp/        JSON-RPC, phiên ACP, fs + terminal trong worktree
   ├─ acp_runner.rs  định tuyến yêu cầu của agent, xin duyệt theo policy
   ├─ acp_tasks.rs   vòng đời tiến trình adapter, lệnh Tauri của task
   ├─ policy.rs   lệnh nào tự cho phép, tự từ chối, hay hỏi người dùng
   ├─ worktree.rs, diff.rs  worktree theo run, duyệt và commit theo hunk
   └─ adapters.rs tham số chạy của từng agent
   │  spawn (stdio)
   ▼
Agent CLI: claude · codex · gemini · kiro-cli
```

## Hợp đồng sự kiện `agent-event`

```ts
{ runId, agent: 'claude'|'codex'|'gemini'|'kiro',
  kind: 'started'|'log'|'stderr'|'usage'|'exit',
  line?, usage?, code?, atMs }
```

`usage` luôn được chuẩn hóa:

| Trường | Ý nghĩa |
|---|---|
| `inputTokens` | input **không** tính phần cache |
| `cachedInputTokens` | input đọc từ cache |
| `outputTokens` | output |
| `costUsd` | chỉ có khi CLI tự báo (Claude Code) |
| `cumulative` | `true`: số tổng của lượt chạy → thay thế; `false`: số của 1 turn → cộng dồn |

Nguồn số liệu từng agent:

| Agent | Dòng chứa usage |
|---|---|
| Claude Code | `{"type":"result", "usage":{…}, "total_cost_usd":…}` (dòng cuối) |
| Codex | `{"type":"turn.completed", "usage":{input_tokens, cached_input_tokens, output_tokens}}` |
| Gemini CLI | `{"type":"result", "stats":{"models":{…:{"tokens":{…}}}}}` |
| Kiro CLI | chưa có — giai đoạn 1/3 |

## Thêm một agent mới

1. Thêm biến thể vào `AgentKind` (`agents/adapters.rs`): tên, binary, tham số headless.
2. Thêm hàm `parse_*` trong `usage/mod.rs` + test.
3. Thêm vào `AgentId`, `AGENT_META` và `AGENT_IDS` (`src/app/core/protocol.ts`), `PRICES` (`usage/pricing.ts`), `MockBackend.detectAgents`, và nhánh trong `chat/describe-line.ts`. Thêm vào `AgentKind::ALL` ở bước 1.
4. Ghi output thật của CLI vào `src-tauri/tests/fixtures/<agent>/<version>/` và thêm contract test.

## Task sửa code (ACP)

Mỗi task có một git worktree riêng trong `<repo>/.tg/worktrees/<run-id>` và một tiến trình adapter ACP. Hàng chờ duyệt là `git diff` trong worktree: accept một hunk sẽ áp nó vào repo người dùng và stage nó trong worktree, nên hunk đó tự rời hàng chờ. Reject bỏ hunk khỏi worktree.

Adapter Claude (`claude-agent-acp`) tự sửa file và chạy lệnh bằng tool của Claude Code, không gọi `fs/*` hay `terminal/*` của app. File vẫn chỉ được ghi trong worktree vì `cwd` của phiên là worktree, và mọi lần sửa đều qua thẻ duyệt. Claude tự cho phép lệnh chỉ-đọc (`cat`, `ls`…) mà không hỏi app.

Usage của task: `usage_update` chỉ có chi phí (và độ đầy context), token nằm trong `usage` của kết quả `session/prompt`. `TaskSession::turn_finished` ghép hai nguồn thành một event `usage` cumulative.

Layout IDE (theo mockup trong `06-design-system.md`): Explorer cây thư mục của worktree đang chọn (chấm màu agent + M/A, nhãn "đang sửa"), các tab ở giữa (tệp, Thay đổi, So sánh), log từng agent ở dưới, panel agent bên phải (usage của task, transcript, thẻ duyệt, plan, danh sách run, ô giao việc có `@mention`). Thanh tiêu đề cho đổi thư mục làm việc (`open_project` kiểm tra đường dẫn, trả về thư mục gốc, nhánh và trạng thái Git).

Editor: `workspace/files.rs` liệt kê, đọc và ghi file trong worktree (đường dẫn tương đối, không đụng `.git`, từ chối symlink ra ngoài). Ghi bị từ chối khi agent đang chạy. Vạch màu tính ở UI từ hunk của `get_diff` (`workspace/editor/line-marks.ts`). Monaco bundle cục bộ, tải lazy, chỉ có worker cơ bản và tô màu Monarch. Khi agent đang chạy, editor đi theo `RunsService.activity` (tệp agent vừa đọc/sửa, từ event `tool`) và nạp lại tệp ngay khi tool sửa file hoàn tất.

Chạy song song: chế độ *Song song* gọi `start_task` cho từng agent với cùng một `group` (lưu ở cột `task_id`). Mỗi run vẫn có worktree, nhánh và tiến trình adapter riêng; `worktree::create` khóa trong tiến trình để các lần tạo cùng lúc không ghi đè `info/exclude`. Màn So sánh gọi `accept_all`: áp toàn bộ thay đổi của một run (cả file nhị phân) thành một patch, kiểm tra trước trên cả repo và worktree, nên hoặc áp hết hoặc không áp gì. Lựa chọn của nhóm nằm trong `RunsService.choices`, nên rời màn So sánh không làm mất bước commit.

Ghép thủ công (`workspace/compose.rs`): hunk chọn từ nhiều run của một nhóm được áp vào một worktree `mix` tạo từ base chung; lệnh kiểm tra của người dùng chạy trong đó; "Dùng bản ghép" đi qua `accept_all` như một run. Bản ghép không lưu qua lần mở app.

Quyền: `git push`, merge và `gh pr merge` luôn bị từ chối. Lệnh khớp rule "Always allow" được tự cho phép; lệnh ghép và các lệnh chạy được mã tùy ý (`bash`, `python`, `npx`…) không bao giờ có rule. UI không gửi option `allow_always` của agent, vì agent mới quyết định option đó bao trùm những gì.

## Hạn mức gói (Claude)

`claude -p --output-format stream-json` phát `rate_limit_event`; `rate_limit_info.unifiedWindows` có `five_hour`, `seven_day`… với `utilization` (0–1) và `resetsAt` (giây). `usage::parse_limits` đổi thành `LimitWindow`, `tasks/headless.rs` phát event `limits`, `store/` giữ bản mới nhất mỗi agent (bảng `account_limits`, schema v3) và `account_limits` trả lại khi mở app. Adapter ACP chỉ chuyển tiếp event này (trong `usage_update._meta["_claude/rateLimit"]`) khi nó đến sau phản hồi đầu tiên của model, nên thực tế task Sửa code chưa có số. Đăng nhập bằng API key thì không có cửa sổ nào, UI không hiện số.

## Usage ledger, giá và ngân sách

`store/` schema v5: `prices` (giá theo agent, có `from_ms`), `settings` (ngân sách, JSON), `mcp_servers`. `usage_report(since)` trả về các lượt chạy với usage cuối cùng (cùng cách gộp như UI). Chi phí: số CLI báo luôn thắng; không có thì ước tính bằng giá có hiệu lực lúc lượt chạy **bắt đầu** (`usage/pricing.ts`), nên đổi giá không đổi số cũ. `BudgetService` dừng run vượt ngân sách mỗi task và chặn việc mới khi chạm ngân sách ngày; vì nhiều agent chỉ báo chi phí khi xong, việc dừng chỉ xảy ra khi đã có số. Biểu đồ dùng `AGENT_META[agent].chart`: cùng sắc độ với màu agent nhưng độ sáng đã qua kiểm tra của `validate_palette.js` (dải sáng, tách màu cho người mù màu ΔE ≥ 8, tương phản) trên nền tối.

## MCP và Skills

`integrations/mcp.rs`: server lưu trong bảng `mcp_servers` (JSON). Khi một task ACP bắt đầu, `drive` lấy các server bật cho agent đó và gửi trong `session/new`; server http chỉ gửi khi `initialize` của agent báo `mcpCapabilities.http`, nếu không thì ghi một dòng vào log. Claude headless nhận `--mcp-config` (không dùng `--strict-mcp-config`, nên cấu hình riêng của người dùng vẫn chạy). `integrations/skills.rs`: thư viện ở `<app data>/skills/<tên>/SKILL.md`; cài vào `<repo>/.claude/skills` hoặc `~/.claude/skills`, bản khác sẵn có được chép thành `SKILL.md.bak-<ms>` trước.

## tg-bridge

`integrations/bridge.rs`. Khi một task ACP bắt đầu (và tg-bridge đang bật, cài đặt `bridge`), `tasks/mod.rs` đăng ký một `TaskEnv` với `BridgeHub` để lấy token, rồi thêm server stdio `tg-bridge` vào `session/new`: lệnh là chính file chạy của app với `--mcp-bridge`, env `TG_BRIDGE_ADDR` + `TG_BRIDGE_TOKEN`. `main.rs` xử lý cờ này **trước** khi Tauri khởi động (nếu không, plugin single-instance sẽ chuyển sang cửa sổ đang mở). Tiến trình bridge nói MCP qua stdio và chuyển mỗi `tools/call` thành một dòng JSON gửi tới `BridgeHub` (TCP, chỉ 127.0.0.1); hub tra token ra `TaskEnv` của run, token bị thu hồi khi run kết thúc.

Tool: `report_progress` và `handoff_to` thành event `bridge` (UI: thanh tiến độ, thẻ/hàng chờ "Chuyển việc"); `write_note`/`read_notes` dùng bảng `bridge_notes` (schema v6) theo phạm vi task = nhóm song song, không thì run gốc của worktree (các bước pipeline dùng chung); `request_approval` hiện thẻ duyệt qua `TaskSession::ask`; `get_task_context` trả về yêu cầu, worktree, tệp đã đổi. Policy tự cho phép tool `mcp__tg-bridge__*` (chúng chỉ ghi/đề xuất). Chấp nhận chuyển việc: agent mới làm tiếp trong worktree của run đề xuất nếu run đó đã xong, không thì một task mới.

## Lịch sử lượt chạy

`tasks/headless.rs` ghi mọi event vào `tg-studio.db` trong thư mục dữ liệu của app, trước khi phát lên UI. Khi khởi động: lượt còn `running` chuyển thành `interrupted`, và nếu không mở được file thì app dùng DB trong bộ nhớ, chỉ mất lịch sử. UI nạp lại 100 lượt gần nhất qua `list_runs`; các lượt này có `restored: true` nên không tính vào usage của phiên hiện tại.

## Đổi frontend sau này

UI chỉ nói chuyện với lõi qua `AgentBackend` (`src/app/core/backend.ts`) và các kiểu trong `protocol.ts`.
Một frontend khác (React, web dashboard…) chỉ cần tái dùng hai hợp đồng đó; phần Rust giữ nguyên.
