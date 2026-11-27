# Đợt B · Token trong lúc chạy và context — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dòng trạng thái có token tăng theo thời gian thực (số thật với Claude, `~` với agent khác); mọi agent có báo đều có số context; Claude có bảng chia loại như `/context`; nhắc thu gọn khi gần đầy.

**Architecture:** Hai kind event mới `progress` và `context` đi qua `TaskSession` như mọi event (không lưu SQLite). Nguồn: `ClaudeConn` phát notification nội bộ `_tg/progress` / `_tg/context`; ACP lấy `usage_update.used/size`; Kiro lấy `contextUsagePercentage`. UI gộp vào `Run.live` / `Run.context`, vẽ ở dòng trạng thái, chip context và bảng context.

**Tech Stack:** Rust (serde_json), Angular 22 signals, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-claude-desktop-parity-design.md` (mục 4.4, 4.5, 5.3, 6). Mockup: `docs/mockups/2026-11-27-claude-desktop/Context.dc.html`.

**Phụ thuộc:** đợt A đã merge (`ClaudeConn`, `AgentConn`, Claude chạy qua `claude -p`).

## Global Constraints

- Mọi chuỗi cho người dùng bằng tiếng Việt. CSS chỉ trong `src/styles.scss`, class tiền tố `ctx-`.
- `progress` và `context` **không** ghi vào `run_lines` và không vào ledger/chi phí. Ledger chỉ lấy từ event `usage` như hiện nay.
- Kiểu ở `protocol.ts` khớp struct/JSON Rust (camelCase). Lệnh Tauri mới có ở `AgentBackend`, `TauriBackend`, `MockBackend`, `generate_handler!`.
- Mọi thay đổi định dạng usage kèm unit test trong `usage/mod.rs`.
- `get_context_usage` luôn gửi `detail: "summary"` (không gọi API, 0 token).
- Số ước lượng luôn có dấu `~` trước.
- Màu chip: `< 50 %` `--run`, `50–80 %` `--wait`, `> 80 %` `--fail`. Thẻ nhắc thu gọn từ `≥ 85 %`.
- Trước khi xong mỗi task: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)` qua.

## Review Focus

1. **`size` là 0 hoặc thiếu** (agent gửi `used` mà không có `size`): không chia cho 0, không hiện `NaN %`; chỉ hiện `used` token. Test ở Task 1 (`context_without_size_has_no_percent`).
2. **Event `progress` đến sau `turn_end`** (thứ tự event lệch): không làm dòng trạng thái hiện lại khi run đã `idle`. Test ở Task 3 (`late_progress_does_not_revive_status`).
3. **Run nạp lại từ lịch sử** (`restored`): không có context; chip ẩn, không hiện "0 %". Test ở Task 4 (`chip_hidden_without_context`).
4. **Agent stream rất nhanh** (hàng trăm chunk/giây): `progress` ước lượng bị gộp, tối đa 4 event/giây/run. Test ở Task 1 (`estimated_progress_is_throttled`).
5. **Bấm mở bảng context liên tục**: chỉ một `get_context_usage` mỗi 5 giây mỗi run. Test ở Task 2 (`context_refresh_is_rate_limited`).

---

### Task 1: Lõi — context từ ACP và Kiro, token ước lượng cho ACP

**Files:**
- Modify: `src-tauri/src/usage/mod.rs` (`parse_context`), `src-tauri/src/tasks/session.rs` (`usage_update`, Kiro metadata, `agent_message_chunk`)
- Test: `src-tauri/src/usage/mod.rs`, `src-tauri/src/tasks/session.rs`

**Interfaces:**
- Produces:
  - `pub fn parse_context(update: &Value) -> Option<Value>` trong `usage/mod.rs`: từ `usage_update` có `used` số → `{"used": u64, "size": u64|null, "percent": f64|null, "source": "acp"}`; `percent = used*100/size` làm tròn 1 chữ số khi `size > 0`, không thì `null`.
  - Event `context` (`AgentEvent.kind = "context"`, `data` = object trên). Kiro: `{"used": null, "size": null, "percent": <contextUsagePercentage>, "source": "kiro"}`.
  - Event `progress`: `{"inputTokens": null, "outputTokens": u64, "estimated": true}` với ACP, `outputTokens` = tổng ký tự `agent_message_chunk` của lượt hiện tại ÷ 4 (làm tròn lên); đặt lại về 0 ở `claim_turn`/`set_busy(true)`; tối đa một event mỗi 250 ms mỗi session (event cuối của lượt luôn phát khi `turn_finished`).
  - `AgentEvent` kind `progress`/`context` bị `headless::publish` bỏ qua khi ghi SQLite (giống `is_stream_chunk`).

- [ ] **Step 1: Test** `parse_context_reads_used_and_size` (usage/mod.rs): `{"sessionUpdate":"usage_update","used":53000,"size":200000}` → `used 53000`, `size 200000`, `percent 26.5`, `source "acp"`; `{"sessionUpdate":"usage_update","cost":{…}}` (không `used`) → `None`.
- [ ] **Step 2: Test** `context_without_size_has_no_percent` (Review Focus 1): `used 10`, `size 0` → `percent` là `null`; thiếu `size` → `size` và `percent` `null`.
- [ ] **Step 3: Test** `usage_update_emits_context` (session.rs, `Recorder`): sau `usage_update` `used 999 size 2000` có event `context` `percent 50.0`; Kiro `contextUsagePercentage 7.11` → `context` `percent 7.11`, `source "kiro"`.
- [ ] **Step 4: Test** `estimated_progress_is_throttled` (Review Focus 4): 200 chunk "abcd" liên tiếp trong cùng lượt → số event `progress` ≤ 2 trong khoảng < 250 ms; sau `turn_finished` event cuối có `outputTokens == 200`, `estimated == true`.
- [ ] **Step 5: Test** `progress_and_context_are_not_saved`: `publish` với kind `progress` và `context` không gọi ghi dòng vào store (dùng cách test sẵn có của `publish`/`is_stream_chunk`).
- [ ] **Step 6:** Run `(cd src-tauri && cargo test context)` và `cargo test progress`. Expected: FAIL; implement; run lại PASS.
- [ ] **Step 7:** Commit `feat(usage): context và token ước lượng từ ACP và Kiro`.

---

### Task 2: Lõi — token thật và bảng context của Claude

**Files:**
- Modify: `src-tauri/src/acp/claude_conn.rs`, `src-tauri/src/acp/fake_claude.rs`, `src-tauri/src/tasks/session.rs`, `src-tauri/src/tasks/mod.rs` (lệnh `refresh_context`), `src-tauri/src/lib.rs` (`generate_handler!`)
- Test: `src-tauri/src/acp/claude_conn.rs`, `src-tauri/src/tasks/tests.rs`

**Interfaces:**
- Consumes: `ClaudeConn` (đợt A), `TaskSession::on_notification`.
- Produces:
  - `ClaudeConn` phát `on_notification("_tg/progress", {"inputTokens", "outputTokens"})`: cộng `message_start.message.usage` (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens` vào input) và `message_delta.usage.output_tokens` của mọi message trong lượt; đặt lại khi bắt đầu lượt.
  - Sau mỗi `result`, `ClaudeConn` gửi `control_request` `{"subtype":"get_context_usage","detail":"summary"}` và phát `on_notification("_tg/context", <response>)`.
  - `ClaudeConn::refresh_context(&self)` gửi lại yêu cầu trên, bỏ qua nếu lần trước < 5 s.
  - `TaskSession`: `_tg/progress` → event `progress` `estimated: false`; `_tg/context` → event `context` `{"used": totalTokens, "size": maxTokens, "percent": percentage, "categories": [{id,name,tokens,kind}], "memoryFiles": [{path,tokens}], "mcpTools": [{server,count,tokens}], "autoCompactAt": autoCompactThreshold, "source": "claude"}` (gom `mcpTools` theo server; trường thiếu thì bỏ).
  - `TaskSession::set_context_hook(&self, hook: Arc<dyn Fn() + Send + Sync>)` và `TaskSession::refresh_context(&self)` gọi hook; đăng ký hook ở chỗ đợt A gọi `set_mode_hook`.
  - Lệnh Tauri `refresh_context(run_id: String) -> Result<(), String>` (trong `tasks/mod.rs`): tìm session trong `TaskRuns`, gọi `refresh_context`; không có session → `Err("Phiên này đã đóng.")`.

- [ ] **Step 1: Test** `claude_conn_reports_live_tokens`: fake phát `stream_event` `message_start` usage `{input_tokens:100, cache_read_input_tokens:20}` rồi hai `message_delta` `output_tokens` 5 rồi 12 → handler nhận `_tg/progress` cuối `inputTokens 120`, `outputTokens 12`.
- [ ] **Step 2: Test** `claude_conn_asks_context_after_turn`: sau `Result`, log fake có `get_context_usage` với `detail "summary"`; fake trả `{totalTokens:184000,maxTokens:1000000,percentage:18.4,categories:[{name:"Messages",tokens:99300,color:"x"}]}` → handler nhận `_tg/context` đúng nội dung đó.
- [ ] **Step 3: Test** `context_refresh_is_rate_limited` (Review Focus 5): gọi `refresh_context` ba lần liền → log fake có đúng một `get_context_usage`.
- [ ] **Step 4: Test** `claude_context_maps_to_event` (tasks/tests.rs): `_tg/context` mẫu ở Step 2 → event `context` có `used 184000`, `size 1000000`, `percent 18.4`, `categories[0].name == "Messages"`, `source "claude"`.
- [ ] **Step 5:** Run focused tests: FAIL; implement; PASS.
- [ ] **Step 6:** Commit `feat(acp): token thật và bảng context của Claude`.

---

### Task 3: UI — dữ liệu và dòng trạng thái có token

**Files:**
- Modify: `src/app/core/protocol.ts`, `src/app/services/runs/run.ts`, `src/app/services/runs/run-events.ts`, `src/app/features/chat/dock/live-status.ts`, `src/app/core/agent-backend.ts` (`refreshContext`), backend Tauri và Mock, `src/app/core/mock/*` (mock phát `progress` và `context`)
- Test: `src/app/services/runs/run-events.spec.ts` (tạo nếu chưa có), `src/app/features/chat/agent-panel.spec.ts`

**Interfaces:**
- Produces (`protocol.ts`):

```ts
export type AgentEventKind = /* các kind cũ */ | 'progress' | 'context';
export interface LiveTokens { inputTokens: number | null; outputTokens: number; estimated: boolean }
export interface ContextCategory { id?: string; name: string; tokens: number; kind?: 'used' | 'free' | 'buffer' | 'deferred' }
export interface ContextUsage {
  used: number | null; size: number | null; percent: number | null;
  categories?: ContextCategory[]; memoryFiles?: { path: string; tokens: number }[];
  mcpTools?: { server: string; count: number; tokens: number }[];
  autoCompactAt?: number; source: 'claude' | 'acp' | 'kiro';
}
```
  - `Run.live?: LiveTokens | null`, `Run.context?: ContextUsage | null`.
  - `run-events.ts`: `progress` → `live` (chỉ khi `status === 'running'`); `user` → `live = null`; `turn_end`/`exit` → `live = null`; `context` → `context`.
  - `AgentBackend.refreshContext(runId: string): Promise<void>`.
  - `live-status.ts`: sau đồng hồ thêm `· ↑ {in} · ↓ {out} token` (dùng `fmtTokens`; `in` ẩn khi `null`; tiền tố `~` khi `estimated`).

- [ ] **Step 1: Test** `progress_updates_live_tokens`: apply `progress` `{inputTokens:120,outputTokens:12,estimated:false}` cho run đang chạy → `run.live` đúng; `turn_end` → `null`.
- [ ] **Step 2: Test** `late_progress_does_not_revive_status` (Review Focus 2): run `idle`, apply `progress` → `run.live` vẫn `null`.
- [ ] **Step 3: Test** `context_event_sets_run_context`: apply `context` mẫu → `run.context.percent == 18.4`.
- [ ] **Step 4: Test** trong `agent-panel.spec.ts`: dòng trạng thái của run đang chạy có `live {null, 1500, true}` chứa chữ `~1,5k token` (theo `fmtTokens`).
- [ ] **Step 5:** Run `npm test -- --watch=false`: FAIL; implement; PASS.
- [ ] **Step 6:** Commit `feat(chat): token trong lúc chạy ở dòng trạng thái`.

---

### Task 4: UI — chip context, bảng context, nhắc thu gọn

**Files:**
- Create: `src/app/features/chat/composer/context-chip.ts`, `src/app/features/chat/composer/context-panel.ts`, `src/app/features/chat/dock/context-alert.ts`, `src/app/shared/utils/context.ts` (hàm thuần)
- Modify: `src/app/features/chat/composer/composer.ts` (gắn chip vào hàng nút), `src/app/features/chat/agent-panel.ts` (gắn `tg-context-alert` vào dock), `src/styles.scss` (`ctx-*`; host mới thêm vào danh sách `display: contents`)
- Test: `src/app/shared/utils/context.spec.ts`, `src/app/features/chat/composer/context-chip.spec.ts`

**Interfaces:**
- Consumes: `Run.context`, `AgentBackend.refreshContext`, `RunsService.sendMessage`, `AgentsService.commands` (để biết agent có lệnh compact).
- Produces (`shared/utils/context.ts`):
  - `contextTone(percent: number | null): 'run' | 'wait' | 'fail' | null` theo ngưỡng ở Global Constraints.
  - `contextLabel(c: ContextUsage): string`: có `used` và `size` → `"18% · 184k/1M"`; chỉ `percent` → `"7%"`; chỉ `used` → `"184k token"`.
  - `canCompact(agent: AgentId, commands: AgentCommand[]): boolean`: Claude luôn `true`; agent khác `true` khi có lệnh tên `compact`.

Giao diện theo `Context.dc.html`: chip vòng (conic theo `percent`) + `%` trên hàng nút ô chat; bấm mở bảng nổi phía trên ô chat (Esc / bấm ngoài để đóng) gồm số `%` lớn, `used / size`, thanh chia màu theo `categories` (vùng đệm vạch chéo), danh sách loại (tên tiếng Việt theo `id`: `messages` Tin nhắn, `mcp_tools` Tool MCP, `system_tools` Tool hệ thống, `memory_files` Tệp ghi nhớ, `skills` Skills, `system_prompt` System prompt, `mcp_instructions` Hướng dẫn MCP server, `custom_agents` Agent tuỳ chỉnh, `autocompact_buffer` Vùng đệm tự thu gọn, `free_space` Còn trống; id khác giữ `name` gốc), mục mở rộng "Tệp ghi nhớ · N" và "Tool MCP · N"; agent không có `categories` thì chỉ tổng và câu "<Agent> chỉ báo tổng đang dùng." (Kiro: "Kiro chỉ báo phần trăm."). Mở bảng gọi `refreshContext`. `tg-context-alert` hiện khi `percent ≥ 85` và `canCompact`: mèo `thinking`, câu "Context đã dùng {p}%. Thu gọn để agent nhớ tiếp mà không bị cắt ngang?", nút **Thu gọn** gửi `/compact`.

- [ ] **Step 1: Test** `context.spec.ts`: `contextTone(49.9) == 'run'`, `50 → 'wait'`, `80 → 'wait'`, `80.1 → 'fail'`, `null → null`; `contextLabel({used:184000,size:1000000,percent:18.4,source:'claude'}) == '18% · 184k/1M'`; `contextLabel({used:null,size:null,percent:7,source:'kiro'}) == '7%'`; `canCompact('codex', [])` false, `canCompact('claude', [])` true.
- [ ] **Step 2: Test** `chip_hidden_without_context` (Review Focus 3): run `restored` không `context` → không có phần tử `.ctx-chip`.
- [ ] **Step 3: Test** `opening_panel_refreshes_context`: bấm chip → `backend.refreshContext(run.id)` được gọi một lần; bảng hiện "Tin nhắn" cho category `id: 'messages'`.
- [ ] **Step 4: Test** alert: `percent 86`, agent Claude → có nút "Thu gọn", bấm → `sendMessage(id, '/compact')`; `percent 84` → không có.
- [ ] **Step 5:** Run `npm test -- --watch=false`: FAIL; implement; PASS.
- [ ] **Step 6:** Chạy `npm start` + Playwright (mock mode): gửi một câu, mở bảng context; chụp màn hình vào scratchpad, so với `Context.dc.html`.
- [ ] **Step 7:** Run đủ ba lệnh kiểm tra. Commit `feat(chat): chip và bảng context, nhắc thu gọn`.
