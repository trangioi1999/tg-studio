# Kiến trúc TG Studio

```
Angular UI (signals, src/app/)
   │  AgentBackend: invoke('start_agent' | 'start_task' | 'send_message' | 'stop_agent' | 'get_diff' | 'commit_files' | …)
   │  listen('agent-event')
   ▼
Rust core (Tauri 2, src-tauri/src/)
   ├─ agents/        danh sách agent (adapters), dò CLI (detect), model và lệnh (options)
   ├─ tasks/         headless.rs: Chỉ hỏi qua CLI · mod.rs: vòng đời task ACP · session.rs: TaskSession
   │                 (định tuyến yêu cầu của agent, thẻ duyệt, subagent) · changes.rs: diff, commit, tệp
   │                 bridge_env.rs: tool tg-bridge · delegate.rs: agent con · warm.rs: phiên mở sẵn
   ├─ acp/           JSON-RPC, phiên ACP, fs + terminal cho agent
   ├─ workspace/     project, worktree (bản nháp và ảnh chụp thư mục), diff, compose (ghép), files
   ├─ integrations/  tg-bridge, MCP, skills, policy (lệnh nào tự cho phép, tự từ chối, hay hỏi)
   ├─ usage/         dòng JSON → Usage chuẩn hóa, hạn mức Claude, sổ usage
   ├─ store/         lịch sử và cài đặt (SQLite), mỗi loại bản ghi một tệp
   └─ system/        PATH từ login shell, tài nguyên, chẩn đoán, phiên bản
   │  spawn (stdio)
   ▼
Agent CLI: claude · codex · gemini · kiro-cli   (Sửa code: adapter ACP, kể cả claude-agent-acp, codex-acp)
```

## Hợp đồng sự kiện `agent-event`

```ts
{ runId, agent: 'claude'|'codex'|'gemini'|'kiro',
  kind: 'started'|'log'|'stderr'|'usage'|'exit'|'limits'|'message'|'tool'|'plan'
      |'permission'|'permission_resolved'|'bridge'|'user'|'turn_end'|'commands',
  line?, usage?, code?, atMs, data? }
```

`started` có thể mang `data.parent` (run con của một agent khác) và `data.subagent` (subagent có sẵn của Claude). `bridge` mang tool của tg-bridge trong `data.tool`: `report_progress`, `handoff_to`, `delegate`, `delegate_done`. `turn_end` kết thúc một câu (run về `idle`); `exit` chỉ phát khi tiến trình kết thúc.

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
3. Thêm vào `AgentId`, `AGENT_META` và `AGENT_IDS` (`src/app/core/protocol.ts`), `PRICES` (`services/usage/pricing.ts`), `MockBackend.detectAgents`, và nhánh trong `features/chat/conversation/describe-line.ts`. Thêm vào `AgentKind::ALL` ở bước 1.
4. Ghi output thật của CLI vào `src-tauri/tests/fixtures/<agent>/<version>/` và thêm contract test.

## Task sửa code (ACP)

Mỗi task có một tiến trình adapter ACP và một nơi làm việc (`Worktree`):

- **Thư mục hiện tại** (`direct`, mặc định): agent sửa thẳng thư mục của người dùng. `branch` rỗng, `base` là tree chụp thư mục lúc bắt đầu (`worktree::direct`, index tạm trong git dir `tg-direct/`), nên diff chỉ có phần agent sửa, không lẫn phần người dùng đang làm dở.
- **Bản nháp** (`draft`): git worktree riêng trong `<repo>/.tg/worktrees/<run-id>`, nhánh `tg/<agent>/…`, tạo từ nhánh người dùng chọn.

Tab Thay đổi làm việc theo tệp như Git. `diff::pending` so nơi làm việc với tree "đã nhận" (`tg-accepted`, hoặc `tg-direct/<run>.accepted`) vì agent có thể tự `git add`/`commit`. `commit_files` commit đúng các tệp đã chọn (`git commit --only`, giữ phần người dùng tự stage) rồi `mark_committed` cập nhật tree đã nhận của mọi run direct trong repo. `revert_files` trả tệp về tree đó (trước khi agent sửa, không về HEAD). `own_changes` là tệp chưa commit mà agent không đụng. Bản nháp thì "Áp vào thư mục" (`accept_all`) một lần rồi commit. Bỏ một đoạn lẻ vẫn làm được trong editor (`reject_hunk`).

Adapter Claude (`claude-agent-acp`) tự sửa file và chạy lệnh bằng tool của Claude Code, không gọi `fs/*` hay `terminal/*` của app. File vẫn chỉ được ghi trong worktree vì `cwd` của phiên là worktree, và mọi lần sửa đều qua thẻ duyệt. Claude tự cho phép lệnh chỉ-đọc (`cat`, `ls`…) mà không hỏi app.

Usage của task: `usage_update` chỉ có chi phí (và độ đầy context), token nằm trong `usage` của kết quả `session/prompt`. `TaskSession::turn_finished` ghép hai nguồn thành một event `usage` cumulative.

Bố cục (theo `docs/superpowers/specs/2026-11-04-chat-first-design.md`): cột trái là dự án → cuộc trò chuyện (`ThreadList`), giữa là chat (`AgentPanel`, thẻ duyệt ghim trên ô chat, agent con lồng trong tin nhắn), phải là cây tệp và các tab tệp, Thay đổi, So sánh (`SidePanel`). Thanh tiêu đề cho đổi thư mục làm việc (`open_project` kiểm tra đường dẫn, trả về thư mục gốc, nhánh và trạng thái Git).

Editor: `workspace/files.rs` liệt kê, đọc và ghi file trong worktree (đường dẫn tương đối, không đụng `.git`, từ chối symlink ra ngoài). Ghi bị từ chối khi agent đang chạy. Vạch màu tính ở UI từ hunk của `get_diff` (`features/editor/line-marks.ts`). Monaco bundle cục bộ, tải lazy, chỉ có worker cơ bản và tô màu Monarch. Khi agent đang chạy, editor đi theo `RunsService.activity` (tệp agent vừa đọc/sửa, từ event `tool`) và nạp lại tệp ngay khi tool sửa file hoàn tất.

Chạy song song: chế độ *Song song* gọi `start_task` cho từng agent với cùng một `group` (lưu ở cột `task_id`). Mỗi run vẫn có worktree, nhánh và tiến trình adapter riêng; `worktree::create` khóa trong tiến trình để các lần tạo cùng lúc không ghi đè `info/exclude`. Màn So sánh gọi `accept_all`: áp toàn bộ thay đổi của một run (cả file nhị phân) thành một patch, kiểm tra trước trên cả repo và worktree, nên hoặc áp hết hoặc không áp gì. Lựa chọn của nhóm nằm trong `RunsService.choices`, nên rời màn So sánh không làm mất bước commit.

Ghép thủ công (`workspace/compose.rs`): hunk chọn từ nhiều run của một nhóm được áp vào một worktree `mix` tạo từ base chung; lệnh kiểm tra của người dùng chạy trong đó; "Dùng bản ghép" đi qua `accept_all` như một run. Bản ghép không lưu qua lần mở app.

Quyền: `git push`, merge và `gh pr merge` luôn bị từ chối. Lệnh khớp rule "Always allow" được tự cho phép; lệnh ghép và các lệnh chạy được mã tùy ý (`bash`, `python`, `npx`…) không bao giờ có rule. UI không gửi option `allow_always` của agent, vì agent mới quyết định option đó bao trùm những gì.

## Hạn mức gói (Claude)

`claude -p --output-format stream-json` phát `rate_limit_event`; `rate_limit_info.unifiedWindows` có `five_hour`, `seven_day`… với `utilization` (0–1) và `resetsAt` (giây). `usage::parse_limits` đổi thành `LimitWindow`, `tasks/headless.rs` phát event `limits`, `store/` giữ bản mới nhất mỗi agent (bảng `account_limits`, schema v3) và `account_limits` trả lại khi mở app. Adapter ACP chỉ chuyển tiếp event này (trong `usage_update._meta["_claude/rateLimit"]`) khi nó đến sau phản hồi đầu tiên của model, nên thực tế task Sửa code chưa có số. Đăng nhập bằng API key thì không có cửa sổ nào, UI không hiện số.

## Usage ledger, giá và ngân sách

`store/` schema v5: `prices` (giá theo agent, có `from_ms`), `settings` (ngân sách, JSON), `mcp_servers`. `usage_report(since)` trả về các lượt chạy với usage cuối cùng (cùng cách gộp như UI). Chi phí: số CLI báo luôn thắng; không có thì ước tính bằng giá có hiệu lực lúc lượt chạy **bắt đầu** (`services/usage/pricing.ts`), nên đổi giá không đổi số cũ. `BudgetService` dừng run vượt ngân sách mỗi task và chặn việc mới khi chạm ngân sách ngày; vì nhiều agent chỉ báo chi phí khi xong, việc dừng chỉ xảy ra khi đã có số. Biểu đồ dùng `AGENT_META[agent].chart`: cùng sắc độ với màu agent nhưng độ sáng đã qua kiểm tra của `validate_palette.js` (dải sáng, tách màu cho người mù màu ΔE ≥ 8, tương phản) trên nền tối.

## MCP và Skills

`integrations/mcp.rs`: server lưu trong bảng `mcp_servers` (JSON). Khi một task ACP bắt đầu, `drive` lấy các server bật cho agent đó và gửi trong `session/new`; server http chỉ gửi khi `initialize` của agent báo `mcpCapabilities.http`, nếu không thì ghi một dòng vào log. Claude headless nhận `--mcp-config` (không dùng `--strict-mcp-config`, nên cấu hình riêng của người dùng vẫn chạy). `integrations/skills.rs`: thư viện ở `<app data>/skills/<tên>/SKILL.md`; cài vào `<repo>/.claude/skills` hoặc `~/.claude/skills`, bản khác sẵn có được chép thành `SKILL.md.bak-<ms>` trước.

## tg-bridge

`integrations/bridge.rs`. Khi một task ACP bắt đầu (và tg-bridge đang bật, cài đặt `bridge`), `tasks/mod.rs` đăng ký một `TaskEnv` với `BridgeHub` để lấy token, rồi thêm server stdio `tg-bridge` vào `session/new`: lệnh là chính file chạy của app với `--mcp-bridge`, env `TG_BRIDGE_ADDR` + `TG_BRIDGE_TOKEN`. `main.rs` xử lý cờ này **trước** khi Tauri khởi động (nếu không, plugin single-instance sẽ chuyển sang cửa sổ đang mở). Tiến trình bridge nói MCP qua stdio và chuyển mỗi `tools/call` thành một dòng JSON gửi tới `BridgeHub` (TCP, chỉ 127.0.0.1); hub tra token ra `TaskEnv` của run, token bị thu hồi khi run kết thúc.

Tool: `report_progress`, `handoff_to`, `delegate` thành event `bridge` (UI: thanh tiến độ, thẻ/hàng chờ "Chuyển việc"); `write_note`/`read_notes` dùng bảng `bridge_notes` (schema v6) theo phạm vi task = nhóm song song, không thì run gốc của worktree (các bước pipeline dùng chung); `request_approval` hiện thẻ duyệt qua `TaskSession::ask`; `get_task_context` trả về yêu cầu, worktree, tệp đã đổi. Policy tự cho phép tool `mcp__tg-bridge__*` (chúng chỉ ghi/đề xuất). Chấp nhận chuyển việc: agent mới làm tiếp trong worktree của run đề xuất nếu run đó đã xong, không thì một task mới.

## Agent con

`delegate` / `wait_delegated` / `resolve_delegated` (`tasks/bridge_env.rs`) cho agent giao một phần việc cho agent khác chạy song song. Quyền theo phiên cha: Hỏi trước hiện thẻ qua `TaskSession::ask`, Tự động chạy luôn, Chỉ hỏi từ chối. Tối đa 3 agent con đang chạy mỗi cha; agent con có `TG_BRIDGE_CHILD=1` nên không thấy tool giao việc và `handoff_to`. `stop_agent` dừng cả con.

Run con theo nơi làm việc của cha (`place_for`). Cha làm thẳng trong thư mục thì con cũng vậy, xong chỉ xoá sổ `tg-direct/` của con (diff của cha đã có phần con sửa). Cha ở bản nháp thì lõi chụp thư mục cha (`delegate::snapshot`: commit tạm trên HEAD, không đổi nhánh hay index), mở con trong `Place::Snapshot`, một lượt; xong thì `delegate::merge_back` gộp 3 chiều từng tệp (`git merge-file`), xung đột giữ bản nháp con và báo `conflicts` để cha tự gộp.

Run con có `parent_run_id` (schema v11) và cùng `thread` với cha. UI ẩn nó khỏi dòng chính và hiện trong `tg-delegations`, ngay chỗ cha đã giao, từ event `bridge` `delegate`/`delegate_done`.

Subagent có sẵn của Claude Code: `AcpClient` khai báo `clientCapabilities.subagents`, adapter gửi `subagent_update` và cập nhật của phiên con với `sessionId` riêng; `TaskSession` chuyển chúng sang run `<cha>~n` (`EventSink::child_run`/`child_finished`, `Store::insert_child_run`). Chưa chạy thật với adapter.

## Lịch sử lượt chạy

`tasks/headless.rs` ghi mọi event vào `tg-studio.db` trong thư mục dữ liệu của app, trước khi phát lên UI. Khi khởi động: lượt còn `running` chuyển thành `interrupted`, và nếu không mở được file thì app dùng DB trong bộ nhớ, chỉ mất lịch sử. UI nạp lại 100 lượt gần nhất qua `list_runs`; các lượt này có `restored: true` nên không tính vào usage của phiên hiện tại.

## Đổi frontend sau này

UI chỉ nói chuyện với lõi qua `AgentBackend` (`src/app/core/backend.ts`) và các kiểu trong `core/protocol.ts`.
Một frontend khác (React, web dashboard…) chỉ cần tái dùng hai hợp đồng đó; phần Rust giữ nguyên.
