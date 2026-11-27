# TG Studio — Làm việc như Claude desktop (đợt 3)

- **Ngày:** 2026-11-27
- **Trạng thái:** chủ repo đã duyệt (2026-11-27: "oke duyệt, giao agent làm luôn đi"); mọi mục **[Đề xuất]** coi như đã chốt. Quyết định sau khi soát ở mục 11.
- **Mockup:** `docs/mockups/2026-11-27-claude-desktop/` (6 khung, nguồn HTML của canvas chủ repo đã duyệt; bảng tệp ↔ mục spec trong README ở đó).
- **Code tham chiếu:** `main` tại `ca5c649` (v0.7.0 + mèo TG).

Quy ước: **[Chủ repo]** là điều chủ repo đã nói hoặc đã chốt. **[Đề xuất]** là quyết định của người viết, chủ repo đổi được khi duyệt. **[Cần kiểm chứng]** phải chạy thử với CLI thật trước khi code dựa vào nó. **[Đã kiểm chứng]** đã chạy thử, ghi rõ với gì.

## 1. Ý định

**[Chủ repo]** muốn TG Studio "work giống bản Claude desktop". Hiện app "đang lỏ quá": mỗi chế độ chạy một kiểu, chuyển chế độ là mở phiên mới, thiếu những thứ Claude desktop và Claude CLI cho thấy (token thật, context, agent con đang làm gì). Năm việc:

1. **Một chuẩn cho mọi chế độ.** "Nên dùng chuẩn 1 cái luôn: hỏi hay edit hay auto đều thế." Chỉ hỏi, Hỏi trước, Tự làm là ba mức quyền của **cùng một phiên agent**, đổi được giữa chừng, không phải ba đường chạy khác nhau.
2. **Dòng trạng thái ở đáy như Claude CLI**, có token thật đang chạy: `✻ Đang sửa SiteLayout.astro… (1:24 · ↑ 18,2k · ↓ 3,4k token · Esc để dừng)`.
3. **Hiện context** như bảng `/context` của Claude Code: đã dùng bao nhiêu trên tổng, chia theo tin nhắn, tool MCP, tool hệ thống, tệp ghi nhớ, skills, vùng đệm, còn trống.
4. **Agent con chạy hiệu quả hơn và xem được nó làm gì**, kiểu Herdr: bấm vào là thấy luồng làm việc như một terminal. **[Chủ repo]** đã chọn: terminal nhỏ chạy **ngay trong tin nhắn của agent cha** (khung 6), "Mở to" thành cửa sổ lớn (khung 2).
5. **Giao diện theo mockup**, gốc theo Claude desktop / Antigravity, **[Chủ repo]** "nhớ dùng bộ mèo mới làm". Ô chat theo **phương án A** (khung 5, **[Chủ repo]** "theo cái A đi").

**[Chủ repo]** muốn sau khi duyệt thì "giao agent làm hết theo layout mới".

### Thành công là

- Người dùng mở cuộc trò chuyện ở **Chỉ hỏi**, hỏi hai câu, chuyển sang **Hỏi trước** và bảo "sửa luôn": agent nhớ cả hai câu (cùng phiên CLI, không có recap), thẻ duyệt hiện cho lần ghi đầu tiên. Chuyển sang **Tự làm**: agent ghi không hỏi (trừ lệnh bị policy chặn hay `must_ask`).
- Trong lúc Claude chạy, dòng trạng thái trên ô chat đếm giây và token tăng dần theo stream; số là số thật của CLI. Với agent chỉ báo token khi hết lượt, số có dấu `~` và được thay bằng số thật khi lượt xong.
- Chip context trên ô chat luôn có số với mọi agent có báo (Claude, Codex, Gemini: `used / size`; Kiro: %). Bấm vào chip của Claude thấy bảng chia đủ loại như khung 3.
- Claude giao Codex review: ngay trong tin nhắn của Claude có khối Codex, mở ra là terminal nhỏ cuộn theo từng bước Codex làm (`● Read(…) └ 212 dòng`), có Dừng và Mở to. Subagent có sẵn của Claude (tool Agent) cũng hiện như vậy.
- Màn Bảng agent cho thấy mọi agent đang chạy ở mọi dự án, mỗi thẻ có mèo đúng trạng thái, duyệt được ngay trên thẻ.

### Không làm

- Chạy CLI tương tác (TUI) trong PTY rồi đọc màn hình như Herdr. App nói chuyện với agent bằng dữ liệu có cấu trúc; "terminal" của agent con là log vẽ theo kiểu terminal từ event.
- Đóng gói Node hay Agent SDK TypeScript vào app.
- Thêm agent mới; đổi màn Thay đổi, So sánh, Pipeline, Chi phí ngoài phần style chung.
- Agent con lồng nhiều tầng (vẫn một tầng như spec 2026-11-09).
- Ký số, notarize, phát hành (giai đoạn 4 vẫn tạm dừng).

### Thất bại dù chạy được

- **Chỉ hỏi ghi được tệp**, dù chỉ một lần, với bất kỳ agent nào.
- Chuyển chế độ làm mất trí nhớ cuộc trò chuyện, hoặc lặng lẽ mở phiên mới mà người dùng không biết.
- Thẻ duyệt không hiện (agent tự duyệt theo thiết lập của CLI người dùng) ở chế độ Hỏi trước.
- Số token "thật" là số đoán mà không có dấu `~`; chi phí bị cộng hai lần sau khi đổi đường chạy.
- Terminal agent con giật, kéo chậm cả khung chat khi agent con ra nhiều dòng.
- Hồi quy: agent con, MCP, tg-bridge, phiên mở sẵn, lịch sử SQLite, hạn mức Claude, xoá cuộc trò chuyện, nối lại phiên.
- Trên Windows bật cửa sổ cmd trống, hoặc app mở từ Finder không thấy `claude`.

## 2. Hiện trạng (đọc từ code)

- **Hai đường chạy.** Chỉ hỏi của Claude và Codex đi qua `tasks/headless.rs` (`claude -p … --permission-mode plan`, một tiến trình sống cho cả cuộc trò chuyện; Codex mỗi câu một `codex exec resume --sandbox read-only`). Sửa code đi qua `tasks/mod.rs` + `tasks/session.rs` bằng ACP (`claude-agent-acp`, `codex-acp`, `gemini --acp`, `kiro-cli acp`). Chỉ hỏi của Gemini và Kiro đi ACP với quyền `deny` trong bản nháp tạm.
- **Đổi chế độ = run mới.** `RunsService.start` (Chỉ hỏi) và `startTask` (Sửa code) là hai lệnh khác nhau; đổi giữa Chỉ hỏi và Sửa code mở run mới cùng `thread`, kèm `recapOf`. `set_approval` chỉ đổi giữa `ask`/`auto`/`deny` trong một phiên ACP đã mở.
- **Context bị bỏ phí.** `usage::parse_acp` chỉ lấy `cost` của `usage_update`, bỏ `used`/`size`. `contextUsagePercentage` của Kiro chỉ dùng để nhận biết khung. UI không có khái niệm context.
- **Dòng trạng thái** `tg-live-status` (`features/chat/dock/live-status.ts`): agent, động từ, đồng hồ, bước gần nhất, nút Dừng. Không có token.
- **Agent con** `tg-delegations` (`features/chat/conversation/delegations.ts`): dòng lồng trong tin nhắn cha, bấm mở rộng tại chỗ bằng `segmentsOf`. Subagent có sẵn của Claude qua ACP thành run `<cha>~n` (`EventSink::child_run`), **chưa chạy thật với adapter**. Tab Log ở khung dưới gom log mọi run cùng `thread`.
- **Mèo** `tg-dock-mascot` đứng trên mép dock, đổi tư thế theo `mascotPose`.
- **Màn Giám sát** (`features/monitor/mission-control.ts`, screen `mission`): KPI, timeline, cột theo agent, hàng chờ.

### 2.1 Những gì CLI và SDK cho (tra cứu 2026-11-27)

| | Claude (`claude -p` stream-json) | Codex (codex-acp) | Gemini (`--acp`) | Kiro (`acp`) |
|---|---|---|---|---|
| Đổi quyền giữa phiên | `set_permission_mode` (plan, manual, acceptEdits, auto, dontAsk, bypassPermissions) **[Đã kiểm chứng: CLI 2.1.332, 0 token]** | `session/set_mode` nếu adapter khai báo mode **[Cần kiểm chứng]** | như Codex **[Cần kiểm chứng]** | như Codex **[Cần kiểm chứng]** |
| Xin duyệt về app | control request `can_use_tool` khi chạy với `--permission-prompts host` (cờ có trong `--help` 2.1.332; luồng duyệt **[Cần kiểm chứng]** vì cần tài khoản) | `session/request_permission` (đang dùng) | như Codex | như Codex |
| Context tổng | `get_context_usage` → `totalTokens`, `maxTokens`, `percentage` **[Đã kiểm chứng]**; `result.modelUsage[m].contextWindow` | `usage_update.used/size` | `usage_update.used/size` | `contextUsagePercentage` trong `_kiro.dev/metadata` |
| Context chia loại | `get_context_usage` → `categories[]` (id, name, tokens, kind), `memoryFiles`, `mcpTools`, `skills`, `agents`, `autoCompactThreshold` **[Đã kiểm chứng]**; `detail:"summary"` không gọi API | không | không | không |
| Token trong lúc chạy | `stream_event` (message_start / message_delta có `usage`) với `--include-partial-messages` | chỉ khi hết lượt (`session/prompt`) | chỉ khi hết lượt | không có token |
| Subagent | `task_started` / `task_progress` / `task_notification`, `parent_tool_use_id`, `stop_task`, subagent chạy nền | không | không | không |
| Khởi tạo | control request `initialize` → `commands`, `agents`, `models`, `current_permission_mode` **[Đã kiểm chứng]** | `initialize` + `session/new` (configOptions, commands) | như Codex | như Codex |

Nguồn: tài liệu Agent SDK (`code.claude.com/docs/en/agent-sdk/typescript.md`, `subagents.md`, `permissions.md`), RFD `session-usage` của ACP, mã `codex-acp` 2.12.1, `gemini-cli` acpSession.ts, mã `claude-agent-acp` 0.113.0.

## 3. Các cách đã cân nhắc

1. **ACP cho mọi agent, mọi chế độ.** Claude cũng qua `claude-agent-acp`. Một giao thức, ít code nhất. Mất bảng chia context, token theo stream, điều khiển subagent của Claude; vẫn phụ thuộc gói npm adapter và mẹo `CLAUDE_CODE_EXECUTABLE` trên Windows. Không đạt "giống Claude desktop".
2. **Mỗi agent dùng đường chuẩn nhất của nó; mọi chế độ chung một phiên.** Một giao diện phiên chung trong Rust, hai bộ điều khiển: Claude nói thẳng giao thức điều khiển của `claude -p` (chính giao thức Agent SDK dùng), Codex/Gemini/Kiro giữ ACP. Đổi chế độ là gửi lệnh vào phiên đang sống.
3. **Tiến trình Node chạy Agent SDK chính thức.** Phải đóng gói Node (nặng, khó ký số); SDK chỉ bọc đúng giao thức ở cách 2.

**Chọn cách 2.** Chủ repo giao phần "làm sao" cho người viết; đây là lựa chọn của người viết, chủ repo đổi được khi duyệt. Lý do: chỉ cách 2 cho được cả bốn thứ chủ repo hỏi (một chuẩn cho mọi chế độ, token thật, context chia loại, agent con xem được) với Claude, agent chính của chủ repo; với Codex/Gemini/Kiro, ACP đã là đường chuẩn nhất của chúng.

## 4. Thiết kế lõi

### 4.1 Một phiên cho mọi chế độ

**[Đề xuất]** Trong `src-tauri/src/tasks/` thêm một trait phiên (tên gợi ý `AgentDriver`) mà `TaskSession` dùng thay cho việc gọi thẳng `AcpClient`. Thao tác:

- `open(plan) -> session_id`: mở hoặc nạp lại phiên (resume), áp MCP server, tg-bridge, model/effort, chế độ ban đầu.
- `prompt(text, attachments)`: gửi một câu; kết thúc lượt bằng event `turn_end` như hiện nay.
- `interrupt()`: dừng lượt đang chạy, phiên vẫn sống (Esc). `stop_agent` vẫn kill cả tiến trình.
- `set_mode(Mode)`: đổi quyền giữa phiên.
- `set_config(model, effort)`.
- `context_usage() -> Option<ContextUsage>`.
- `close()`.

Hai cài đặt:

- **`ClaudeDriver`** (mới): tiến trình `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompts host --permission-mode <m> [--resume <id>] [--mcp-config <tệp 0600>] [--model …]`, luôn tạo bằng `env::command`, PATH đăng nhập.
- **`AcpDriver`**: phần ACP hiện có (`AcpClient`, `handlers.rs`, `LateHandler`), tách khỏi logic định tuyến của `TaskSession`.

`TaskSession` giữ toàn bộ phần không phụ thuộc giao thức: quyền (`approval`), policy, ghi SQLite trước khi phát event, cộng usage (`SessionTotals`), agent con (`EventSink::child_run`), tg-bridge, `turn_seq`. Mọi run, mọi chế độ đều là một `TaskSession`: **`tasks/headless.rs` không còn là đường chạy chính**. Khi cả bốn agent chạy được qua trait mới và test qua, xoá `headless.rs` (phần còn dùng như `is_stream_chunk` chuyển sang nơi khác), lệnh `start_agent`, và đường `--permission-mode plan` riêng.

**[Đề xuất]** Claude bỏ `claude-agent-acp`. Giữ code ACP cho Claude sau một cờ trong thời gian chuyển (để so sánh và lùi lại), xoá khi test thật của `ClaudeDriver` qua hết. Bỏ luôn `env::adapter_env`/`claude_executable` nếu không còn ai dùng.

### 4.2 Ánh xạ chế độ

Ba chế độ ở UI giữ tên hiện tại: **Chỉ hỏi**, **Hỏi trước**, **Tự làm** (`Approval`: `deny` / `ask` / `auto`).

| Chế độ | Claude (`set_permission_mode` + host) | Agent ACP |
|---|---|---|
| Chỉ hỏi | `plan`; host **từ chối** mọi `can_use_tool` không phải chỉ đọc | `deny` như hiện tại (từ chối `request_permission`, `fs/write_text_file`, `terminal/create`) + `session/set_mode` sang mode chỉ đọc nếu adapter có |
| Hỏi trước | `manual` (mặc định, mọi thao tác ghi hỏi host); host đưa lên thẻ duyệt | `ask` + `session/set_mode` về `default` (đang làm) |
| Tự làm | `acceptEdits`; host tự `allow` lệnh shell trừ lệnh cấm (`policy.rs`) và `policy::must_ask` (vẫn hiện thẻ); không bao giờ chọn "luôn cho phép" | `auto` như hiện tại |

- Chỉ hỏi được chặn **hai lớp**: chế độ của CLI và host từ chối. Lớp host là bắt buộc vì CLI có thể đọc `defaultMode` từ thiết lập của người dùng.
- **[Cần kiểm chứng]** Codex/Gemini/Kiro có mode chỉ đọc qua `session/set_mode` không, và lớp `deny` có chặn được tool ghi tệp nội bộ của chúng không (ghi không qua `fs/write_text_file`). Agent nào không chặn được chắc chắn thì Chỉ hỏi của agent đó **giữ cách hiện tại**: chạy trong bản nháp tạm; chuyển nó sang Hỏi trước/Tự làm thì mở phiên mới cùng `thread` kèm recap, UI ghi rõ một dòng "Đã mở phiên mới để cho phép sửa code". Đây là ngoại lệ duy nhất của "một phiên cho mọi chế độ".
- Đổi chế độ giữa lượt đang chạy: áp ngay cho thao tác kế tiếp (Claude nhận `set_permission_mode` bất kỳ lúc nào **[Đã kiểm chứng]**).
- Nơi làm việc (`direct` / `draft`) chọn lúc bắt đầu như hiện nay, không đổi theo chế độ.

### 4.3 Giao thức của `ClaudeDriver`

Mỗi dòng stdout là một JSON. **[Đề xuất]** xử lý:

- Lúc mở: gửi `control_request` `initialize` → phát `commands` (từ `commands`, `agents`), `options` (từ `models`), ghi `current_permission_mode`.
- Câu hỏi: một dòng `{"type":"user","message":{"role":"user","content":[…]}}` trên stdin; nội dung dựng bằng `attachments::claude_content` như hiện nay.
- `stream_event`: delta chữ → dòng tin nhắn (giữ `MESSAGE_KEY`/`FINAL_KEY` của `describe-line.ts`); `message_start`/`message_delta.usage` → event `progress` (mục 4.4).
- `assistant` / `user` có `tool_use` / `tool_result` → dòng tool (`● Tên(đối số)` + `└ kết quả`), sửa tệp có diff nhỏ (mục 5.1).
- `control_request` `can_use_tool` từ CLI → `PermissionRequest` cho UI (cùng kiểu với ACP để thẻ duyệt không đổi), trả `control_response` allow (có thể kèm `updatedInput`) / deny kèm lý do tiếng Việt.
- `result` → `turn_end`, usage cộng dồn (`SessionTotals`, chi phí cộng dồn của CLI trừ `cost_base` khi nối lại), rồi hỏi `get_context_usage` `summary` → event `context`.
- `system/task_started`, `task_progress`, `task_notification` và tin nhắn có `parent_tool_use_id` → run con `<cha>~n` qua `EventSink::child_run` / `child_finished`. Dừng một subagent: `stop_task`.
- `rate_limit_event` → `limits` (như headless hiện nay). `autocompact_state` → ngưỡng tự thu gọn trong `context`. `compact_boundary` → dòng ghi chú "Đã thu gọn context".
- Esc → `control_request` `interrupt`.

**[Cần kiểm chứng]** (cần tài khoản Claude): hình dạng `can_use_tool` và câu trả lời; `interrupt` giữa tool call; subagent nền có tiếp tục gửi event sau `result` của cha không; `--resume` + `--permission-prompts host` cùng lúc.

Agent giả cho test: thêm `acp/fake_claude.rs` (hoặc tương tự) nói giao thức stream-json, theo cách `acp/fake.rs` đang làm cho ACP.

### 4.4 Token trong lúc chạy

Event mới `progress`: `{ inputTokens, outputTokens, estimated }`, chỉ cho dòng trạng thái, **không** vào ledger.

- Claude: số thật từ `message_start.usage` (input, cache) và `message_delta.usage.output_tokens`, cộng các message trong lượt.
- ACP: `estimated: true`, output ước bằng số ký tự chữ đã stream ÷ 4; input để trống. Khi lượt xong, số thật từ `session/prompt` thay vào.
- Ledger và chi phí vẫn chỉ lấy từ event `usage` như hiện nay (quy ước `inputTokens` không gồm cache giữ nguyên).

### 4.5 Context

Event mới `context`:

```
{ used: number, size: number | null, percent: number,
  categories?: { id, name, tokens, kind: 'used'|'free'|'buffer'|'deferred' }[],
  memoryFiles?: { path, tokens }[], mcpTools?: { server, count, tokens }[],
  autoCompactAt?: number, source: 'claude' | 'acp' | 'kiro' }
```

- Claude: sau mỗi `result`, và khi người dùng mở bảng (chặn ≤ 1 lần / 5 giây). Dùng `detail: "summary"` (không gọi API, không tốn tiền trên Bedrock).
- ACP: mỗi `usage_update` có `used`/`size` (sửa `usage::parse_acp` để không bỏ phần này; vẫn có unit test trong `usage/mod.rs`).
- Kiro: `contextUsagePercentage` → `percent`, `used`/`size` trống.
- `Run.context` giữ bản mới nhất, chỉ trong phiên đang sống (không lưu SQLite). Phiên nạp lại không có context cho tới câu đầu tiên.

## 5. Giao diện

Theo mockup. Màu, cỡ chữ, bo góc dùng biến trong `src/styles.scss`; thêm biến cho màu cam của mèo (nút gửi, ký hiệu `✻`) nếu cần. Chuỗi tiếng Việt. Không nới CSP.

### 5.1 Cuộc trò chuyện (khung 1)

- Thao tác của agent hiện theo kiểu Claude CLI: `● Update(src/components/SiteLayout.astro)` rồi `└ +3 −3`, sửa tệp có diff nhỏ tối đa vài dòng ngay dưới. Các thao tác giữa hai tin nhắn vẫn gom thành Nhật ký làm việc như `segmentsOf` hiện nay; **[Đề xuất]** 3 bước gần nhất luôn hiện, phần trước thu gọn.
- Thanh trái thêm nhóm **Đang chạy** (mọi run đang chạy/chờ duyệt ở mọi dự án, agent con thụt vào).

### 5.2 Ô chat phương án A (khung 5)

- Một khối bo tròn lớn. Từ trên xuống: dải trạng thái (khi agent chạy) hoặc thẻ duyệt (khi chờ duyệt), tệp đính kèm, ô gõ, hàng nút.
- Hàng nút: "+" tròn (tệp, lệnh `/`, skill), agent + model, chế độ (Chỉ hỏi / Hỏi trước / Tự làm, đổi được giữa phiên theo mục 4.2), vòng context + %, nút gửi tròn màu cam; khi agent chạy thành nút dừng.
- Dải trạng thái: `✻ <bước hiện tại>… · m:ss · ↑ vào · ↓ ra token · N agent con · Esc để dừng`; số ước có `~`.
- Thẻ duyệt thay chỗ dải trạng thái, có mèo suy nghĩ, `Từ chối` / `Cho phép lần này` (và "luôn cho phép" như thẻ hiện tại). Thẻ duyệt của run khác vẫn có thông báo như `otherApprovals`.
- Vẫn gõ được khi agent đang chạy. **[Đề xuất]** Claude: câu gửi giữa lượt đi thẳng vào stdin (CLI xếp hàng); ACP: giữ chữ trong ô, tự gửi khi `turn_end`, ô ghi "Sẽ gửi khi agent xong bước này".
- Mèo ngồi trên mép phải của khối (thay chỗ `tg-dock-mascot` trên dock), quy tắc tư thế giữ `mascotPose`.
- Thay cho `tg-live-status`, `tg-approvals` (vị trí), `tg-composer` (hình thức). Logic của chúng giữ lại.

### 5.3 Context (khung 3)

- Chip vòng trên ô chat: dưới 50 % màu `--run`, 50–80 % `--wait`, trên 80 % `--fail`.
- Bấm chip mở bảng nổi: số lớn %, `used / size`, thanh chia màu theo loại, danh sách loại có token và %, mở rộng "Tệp ghi nhớ" và "Tool MCP". Agent không chia loại thì chỉ hiện tổng và một câu nói rõ agent đó chỉ báo gì.
- Từ 85 %: thẻ nhắc có mèo, nút **Thu gọn** (Claude: gửi `/compact` như `SessionPlan.compact`; agent khác chỉ hiện nút nếu lệnh compact có trong `commands` của nó).

### 5.4 Agent con ngay trong chat (khung 6) và cửa sổ lớn (khung 2)

- Trong `tg-delegations`, phần mở rộng thành **terminal nhỏ**: cao cố định ~10 dòng, chữ mono nền đen, luôn cuộn theo dòng mới (dừng cuộn khi người dùng kéo lên), header có mèo theo trạng thái, avatar, tên, việc, trạng thái, thời gian, chi phí, context, **Dừng**, **Mở to**.
- Mỗi lúc chỉ mở một agent con; mở cái khác thì cái cũ thu lại. Agent con xong tự thu lại, giữ dòng tóm tắt.
- Ô **Nhắn riêng** dưới terminal: **[Đề xuất]** chỉ hiện khi agent con nhận được câu (đang `idle`, hoặc là Claude). Agent con giao qua tg-bridge hiện là `singleTurn` (xong là thoát): giữ nguyên, ô nhắn ẩn với chúng ở đợt này.
- **Mở to**: cửa sổ phủ trên chat. Trái là danh sách agent của cuộc trò chuyện (cha, con thụt vào), ↑↓ đổi; phải là log đầy đủ, tab Trực tiếp / Thay đổi / Việc được giao; header như terminal nhỏ + "Ghim xuống khung dưới" (mở tab Log ở khung dưới, lọc theo run đó). Esc hoặc ✕ quay về đúng chỗ trong chat.
- Hiệu năng: chỉ render phần đang thấy của log (giới hạn số dòng giữ trong DOM, ví dụ 500 dòng cuối; phần cũ đọc khi kéo lên).
- **"Chạy hiệu quả hơn"** **[Đề xuất]**: agent con dùng `WarmPool` khi có phiên mở sẵn đúng khoá; subagent có sẵn của Claude chạy trong chính tiến trình của cha (không tiến trình mới); giữ giới hạn 3 agent con tg-bridge đang chạy mỗi phiên cha.

### 5.5 Bảng agent (khung 4)

- **[Đề xuất]** Thay nội dung màn Giám sát (`mission`) bằng Bảng agent, đổi tên nút ở thanh trái thành "Bảng agent". KPI của Giám sát thu thành một dòng số liệu trên đầu.
- Lọc: Tất cả / Cần bạn / Đang chạy / Xong / Đang ngủ. Lưới thẻ; mỗi thẻ: mèo theo `mascotPose`, avatar, tên agent, "↳ của <cha>" nếu là agent con, tên cuộc trò chuyện, dự án, trạng thái, 3 dòng log cuối (mono), thời gian, chi phí, thanh context. Thẻ chờ duyệt có nút duyệt ngay trên thẻ.
- Bấm thẻ mở cửa sổ lớn (5.4) của run đó.

## 6. Hợp đồng dữ liệu

- `AgentEvent.kind` thêm `progress`, `context`. Struct Rust `#[serde(rename_all = "camelCase")]`, `protocol.ts` khớp.
- `Run` thêm `context?: ContextUsage | null`, `live?: { inputTokens, outputTokens, estimated }`.
- Lệnh Tauri: gộp `start_agent` vào `start_task` (`approval: deny` là Chỉ hỏi); `set_approval` nhận cả `deny`; thêm `interrupt_run(runId)`, `context_usage(runId)`. Mỗi lệnh mới đăng ký trong `generate_handler!` và có ở cả `TauriBackend` và `MockBackend`.
- Lịch sử: run cũ có cột như cũ; run Chỉ hỏi cũ (từ `headless.rs`) vẫn nạp và hiện được. Không đổi schema trừ khi cần cột cho chế độ hiện tại của run.

## 7. Ràng buộc (từ CLAUDE.md / AGENTS.md)

- Mọi tiến trình con qua `env::command`/`env::std_command`, `.env("PATH", env::login_path())`, `CREATE_NO_WINDOW` trên Windows.
- Ghi SQLite trước khi phát event; lỗi ghi không làm hỏng lượt.
- MCP: Claude nhận đường dẫn tệp 0600, không bao giờ JSON có token trên dòng lệnh.
- Mọi giao tiếp UI ↔ lõi qua `AgentBackend`. Component chỉ ở `features/` và `layout/`. CSS chỉ trong `src/styles.scss`, tên class riêng.
- Thay đổi định dạng usage kèm unit test trong `usage/mod.rs`.
- Trước khi xong mỗi đợt: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`.
- Không tự chạy workflow GitHub.

## 8. Thứ tự làm

Rủi ro lớn nhất trước. Mỗi đợt build, test xong mới sang đợt sau; mỗi đợt merge được riêng.

1. **Đợt A · Một phiên cho mọi chế độ.** Trait phiên, `AcpDriver` (tách từ code hiện có, không đổi hành vi), `ClaudeDriver` + agent giả, ánh xạ chế độ, đổi chế độ giữa phiên ở UI, Chỉ hỏi của Codex sang ACP, gộp `start_agent`. Test thật (`TG_LIVE_ACP=1`): Claude hai câu cùng phiên, Chỉ hỏi không ghi được (`live_read_only_run_cannot_write` cho đường mới), Chỉ hỏi → Hỏi trước giữ trí nhớ, thẻ duyệt hiện ở Hỏi trước.
2. **Đợt B · Token và context.** Event `progress`, `context`; sửa `parse_acp`; chip, bảng context, nút Thu gọn.
3. **Đợt C · Ô chat A và dòng chat kiểu CLI.** Khối ô chat, dải trạng thái, thẻ duyệt trong khối, mèo trên khối, dòng tool `● … └ …` có diff nhỏ, nhóm Đang chạy ở thanh trái.
4. **Đợt D · Agent con.** Terminal nhỏ trong chat, cửa sổ lớn, subagent có sẵn của Claude qua `ClaudeDriver`, dùng `WarmPool` cho agent con.
5. **Đợt E · Bảng agent.**

Đợt B và C dựa trên A (event, chế độ); D dựa trên A (subagent của Claude) và C (style); E dựa trên D (cửa sổ lớn).

## 9. Để người làm tự quyết

- Tên trait, cách chia module trong `tasks/`, cấu trúc agent giả.
- Cách ước token cho ACP (÷ 4 là gợi ý).
- Ngưỡng màu chính xác, số dòng giữ trong DOM, chu kỳ hỏi context khi bảng mở.
- Có giữ cờ lùi về `claude-agent-acp` hay không sau khi test thật qua.
- Chi tiết bố cục theo mockup ở cỡ hẹp (dưới 1100 px).

## 10. Cần kiểm chứng trước khi code dựa vào (tổng hợp)

1. `can_use_tool` của `claude -p --permission-prompts host`: hình dạng yêu cầu, câu trả lời allow/deny/updatedInput; Chỉ hỏi (`plan`) có gọi host cho tool ghi không.
2. `interrupt` giữa tool call; `--resume` cùng `--permission-prompts host`; subagent nền gửi event sau `result`.
3. Codex/Gemini/Kiro: mode chỉ đọc qua `session/set_mode`; `deny` có chặn được mọi đường ghi.
4. Lệnh compact của Codex/Gemini/Kiro qua ACP.
5. Kiro CLI v3 còn gửi `_kiro.dev/metadata` không (tài liệu nói chuyển sang `_kiro.dev/session/update`).

## 11. Quyết định sau khi soát (2026-11-27)

Người viết quyết, theo phạm vi chủ repo đã giao:

1. **Cổng kiểm chứng cho Claude.** Đợt A bắt đầu bằng một bước thử (`ClaudeDriver` với agent giả + test thật đánh dấu `#[ignore]`). Test thật cần tài khoản Claude nên **chủ repo chạy trên máy mình** (`TG_LIVE_ACP=1 … live_claude_native_*`). Nếu `can_use_tool` không đi về host ở `plan`/`manual`, hoặc không dùng được với `--resume`: Claude giữ `claude-agent-acp` cho Sửa code (sau cùng trait, đổi một dòng), `ClaudeDriver` chỉ dùng cho Chỉ hỏi như `headless.rs` hôm nay, và không xoá đường cũ. Code cũ chỉ bị xoá sau khi chủ repo báo test thật qua.
2. **Tệp kế hoạch của Claude ở Chỉ hỏi.** Host cho phép đúng một ngoại lệ: ghi vào `~/.claude/plans/` (đường dẫn chuẩn hoá, không theo symlink ra ngoài). Mọi ghi khác bị từ chối. "Làm luôn" (`features/chat/dock/proposal.ts`) giữ cách bắt lần ghi đó; khi bấm, thay vì mở run mới, đổi chế độ của **cùng phiên** sang Hỏi trước rồi gửi kế hoạch.
3. **Codex ở Chỉ hỏi.** Nếu `codex-acp` không có mode chỉ đọc chắc chắn (mục 10.3), Codex giữ `codex exec --sandbox read-only` trên thư mục thật (thấy cả phần chưa commit). Khi đó `headless.rs` chỉ còn phần Codex, và đổi chế độ của Codex là phiên mới kèm recap (như hôm nay), có dòng ghi chú. Không đưa Codex về bản nháp tạm.
4. **Nơi làm việc của cuộc trò chuyện bắt đầu ở Chỉ hỏi:** `direct` trong thư mục của người dùng, như mặc định của UI. Sổ `tg-direct/` tạo lúc bắt đầu như mọi run direct (chỉ là tệp sổ sách trong git dir). Thư mục chưa phải repo git: Chỉ hỏi vẫn chạy, chuyển sang Hỏi trước/Tự làm thì báo cần repo như hôm nay.
5. **Bảng agent: phạm vi và "Đang ngủ".** Đọc từ `RunsService.runs` (gồm lịch sử đã nạp từ SQLite), không cần truy vấn mới. Hiện: mọi run đang chạy / chờ duyệt, cộng run kết thúc trong 24 giờ qua, mỗi cuộc trò chuyện một thẻ (run mới nhất + agent con của nó). Trạng thái thẻ theo `mascotPose`: "Đang ngủ" = phiên đã đóng (`restored`) hoặc 5 phút không có event; "Xong" = `idle`/`done` gần đây.
6. **Mockup** nằm trong repo (đầu tài liệu); mục 5 là mô tả, tệp `.dc.html` là bố cục chuẩn.
