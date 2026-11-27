# Đợt D · Agent con chạy ngay trong chat và cửa sổ lớn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent con (giao qua tg-bridge, hoặc subagent có sẵn của Claude) mở ra thành terminal nhỏ ngay trong tin nhắn của agent cha; "Mở to" thành cửa sổ lớn có danh sách agent của cuộc trò chuyện; agent con làm thẳng trong thư mục dùng phiên mở sẵn nếu có.

**Architecture:** Một component `tg-agent-terminal` vẽ log của một run kiểu terminal (dùng lại `segmentsOf` + dòng kiểu CLI của đợt C). `tg-delegations` dùng nó cho phần mở rộng. Cửa sổ lớn `tg-agent-window` mở bằng `UiService.agentWindow`. Lõi: `start_task_with` lấy phiên mở sẵn cho agent con `Place::Direct`.

**Tech Stack:** Angular 22 signals, Vitest, Playwright; Rust (tokio).

**Spec:** `docs/superpowers/specs/2026-11-27-claude-desktop-parity-design.md` (mục 5.4). Mockup: `docs/mockups/2026-11-27-claude-desktop/Inline.dc.html` (khung 6), `Popup.dc.html` (khung 2).

**Phụ thuộc:** đợt A (subagent của Claude qua `ClaudeConn`), đợt B (`Run.context`, `Run.live`), đợt C (`tool-step.ts`, class `cl-`).

## Global Constraints

- CSS chỉ trong `src/styles.scss`, class tiền tố `at-` (terminal nhỏ), `aw-` (cửa sổ lớn). Host component mới thêm vào danh sách `display: contents` (trừ overlay cần `display:block`).
- Mọi chuỗi tiếng Việt; icon SVG nét; nút chỉ icon có `aria-label`.
- Terminal nhỏ cao cố định 10 dòng (`calc(10 * 1.7em)` với chữ 12 px mono), nền `#070709` (thêm biến `--term-bg`), chữ `--text-2`.
- Giữ trong DOM tối đa 500 dòng cuối của một run; phần cũ hơn ẩn sau nút "Hiện N dòng trước".
- Mỗi lúc một agent con mở trong một tin nhắn; agent con xong (`done`/`failed`/`stopped`) tự thu lại.
- Esc trong cửa sổ lớn đóng cửa sổ và trả focus về đúng dòng agent con đã mở nó.
- Không đổi luật agent con của spec 2026-11-09 (một tầng, tối đa 3 agent con tg-bridge đang chạy mỗi phiên cha).
- Trước khi xong mỗi task: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)` qua.

## Review Focus

1. **Agent con ra rất nhiều dòng** (log 5 000 dòng): DOM giữ ≤ 500 dòng, cuộn theo dòng mới không giật. Test ở Task 1 (`terminal_keeps_last_500_lines`).
2. **Người dùng kéo lên đọc** trong terminal nhỏ: không tự nhảy xuống khi có dòng mới; có nút "↓ Dòng mới" để quay lại. Test ở Task 1 (`terminal_stops_following_when_scrolled_up`).
3. **Agent con xong trong lúc đang mở**: tự thu lại, giữ dòng tóm tắt; nếu cửa sổ lớn đang mở cho run đó thì cửa sổ vẫn mở và hiện trạng thái cuối. Test ở Task 1 (`finished_child_collapses`) và Task 2.
4. **Cửa sổ lớn mở cho run vừa bị xoá** (xoá cuộc trò chuyện): cửa sổ tự đóng, không lỗi. Test ở Task 2 (`window_closes_when_run_disappears`).
5. **Nhắn riêng cho agent con không nhận được câu** (agent con tg-bridge `singleTurn` đang chạy): ô nhắn ẩn, không gửi câu đi đâu cả. Test ở Task 1 (`dm_hidden_for_single_turn_child`).

---

### Task 1: Terminal nhỏ trong tin nhắn cha

**Files:**
- Create: `src/app/features/chat/conversation/agent-terminal.ts`, `src/app/features/chat/conversation/agent-terminal.spec.ts`
- Modify: `src/app/features/chat/conversation/delegations.ts` (phần mở rộng dùng `tg-agent-terminal`; một mục mở; tự thu khi xong; nút Mở to), `src/app/services/app/ui.service.ts` (`agentWindow`), `src/styles.scss`

**Interfaces:**
- Consumes: `segmentsOf` (`timeline.ts`), `toolHead`/`miniDiff`/`resultLine` qua `WorkStep.head/result/diff` (đợt C), `mascotPose` (`dock-mascot.ts`), `RunsService.stop/sendMessage`, `Run.context`, `Run.live`.
- Produces:
  - `tg-agent-terminal` với `run = input.required<Run>()`, `compact = input(true)` (true: cao 10 dòng; false: chiếm hết chiều cao cha, dùng ở cửa sổ lớn), `maxLines = input(500)`.
  - Hàm thuần trong `agent-terminal.ts`: `terminalLines(run: Run, max: number): { lines: TermLine[]; hidden: number }` với `TermLine = { kind: 'prompt' | 'step' | 'text' | 'status'; text: string; state?: StepState; head?: ToolHead; result?: string }` — dòng `prompt` (`❯ <việc được giao>`), mỗi bước kiểu CLI, tin nhắn chữ (font thường), dòng trạng thái cuối khi chạy (`✻ <bước> (m:ss · ↓ token)`).
  - `canMessage(run: Run): boolean`: `true` khi run `idle` và không `restored`, hoặc run Claude đang `running` không `singleTurn`; agent con tg-bridge (có `parent`, `singleTurn`) → `false`.
  - `UiService.agentWindow = signal<string | null>(null)`; `openAgentWindow(runId: string, from?: HTMLElement)` lưu phần tử để trả focus.
  - Header terminal (theo `Inline.dc.html`): nút thu, mèo `mascotPose` 22×24, avatar, tên, việc, pill trạng thái, `m:ss · $ · ctx N%`, nút Dừng (khi chạy), nút Mở to (`aria-label="Mở to"`), dưới cùng ô "Nhắn riêng <Agent>" khi `canMessage`.

- [ ] **Step 1: Test** `terminal_keeps_last_500_lines` (Review Focus 1): run có 5 000 dòng tool → `terminalLines(run, 500).lines.length <= 500`, `hidden > 0`; component có nút "Hiện … dòng trước".
- [ ] **Step 2: Test** `terminal_stops_following_when_scrolled_up` (Review Focus 2): đặt `scrollTop` khác đáy rồi thêm dòng → `scrollTop` không đổi và có nút "↓ Dòng mới"; ở đáy rồi thêm dòng → cuộn tới đáy.
- [ ] **Step 3: Test** `finished_child_collapses` (Review Focus 3): mở mục của run `running`, chuyển run sang `done` → mục thu lại, còn dòng tóm tắt; mở mục B khi A đang mở → A thu lại.
- [ ] **Step 4: Test** `dm_hidden_for_single_turn_child` (Review Focus 5): run có `parent` và `singleTurn` → không có ô nhắn riêng; run Claude `idle` → có, gửi gọi `sendMessage(id, text)`.
- [ ] **Step 5: Test** bấm "Mở to" → `ui.agentWindow() === run.id`.
- [ ] **Step 6:** Run `npm test -- --watch=false`: FAIL; implement; PASS.
- [ ] **Step 7:** Commit `feat(chat): agent con chạy ngay trong tin nhắn như terminal nhỏ`.

---

### Task 2: Cửa sổ lớn xem agent

**Files:**
- Create: `src/app/features/chat/agent-window/agent-window.ts`, `src/app/features/chat/agent-window/agent-window.spec.ts`
- Modify: `src/app/app.ts` hoặc `src/app/layout/*` (gắn `tg-agent-window` một lần ở khung app), `src/styles.scss`

**Interfaces:**
- Consumes: `UiService.agentWindow`, `logSections` (`features/workbench/log-sections.ts`: các run cùng `thread`, con sau cha), `tg-agent-terminal` (`compact=false`), `WorkspaceService.open({kind:'changes', runId})`, tab Log ở khung dưới (cách mở hiện có của `Terminal`/`log-sections`).
- Produces: overlay `role="dialog"` theo `Popup.dc.html`: trái là danh sách agent của cuộc trò chuyện (cha, con thụt; tên, trạng thái), ↑/↓ đổi run, Enter đặt focus vào ô nhắn riêng; phải là header (avatar, tên, việc, "· việc con của <cha>", pill, `m:ss · $ · ctx`, nút Ghim xuống khung dưới, Dừng, Đóng), tab **Trực tiếp** (terminal lớn) / **Thay đổi · N** (danh sách tệp của run, bấm mở tab Thay đổi lọc run đó) / **Việc được giao** (prompt đầy đủ), ô nhắn riêng khi `canMessage`. Header không xuống dòng: tên việc cắt "…", nút là icon.

- [ ] **Step 1: Test** mở với run con → danh sách có cha và con, con được chọn; ↓ chọn run kế; Esc → `agentWindow()` null và focus trả về phần tử đã lưu.
- [ ] **Step 2: Test** `window_closes_when_run_disappears` (Review Focus 4): xoá run khỏi `runs` → `agentWindow()` null.
- [ ] **Step 3: Test** run `done` khi cửa sổ đang mở → cửa sổ vẫn mở, pill "Xong".
- [ ] **Step 4: Test** "Ghim xuống khung dưới" mở tab Log ở khung dưới với lọc theo run và đóng cửa sổ.
- [ ] **Step 5:** Run tests: FAIL; implement; PASS.
- [ ] **Step 6:** Playwright ở mock mode: mock giao việc cho Codex (mock có sẵn delegation), mở terminal nhỏ, bấm Mở to, chụp so với `Inline.dc.html` và `Popup.dc.html`.
- [ ] **Step 7:** Commit `feat(chat): cửa sổ lớn xem agent của cuộc trò chuyện`.

---

### Task 3: Subagent của Claude hiện như agent con, agent con dùng phiên mở sẵn

**Files:**
- Modify: `src/app/features/chat/conversation/delegations.ts` (nếu subagent `<cha>~n` chưa có dòng), `src-tauri/src/tasks/mod.rs` (`start_task_with`: agent con `Place::Direct` thử `WarmPool::take(&key_for(store, agent, cwd))`), `src/app/core/mock/*` (mock có một subagent Claude)
- Test: `src/app/features/chat/conversation/delegations.spec.ts`, `src-tauri/src/tasks/tests.rs`

**Interfaces:**
- Consumes: run `<cha>~n` do `ClaudeConn` + `TaskSession::subagent_update` tạo (đợt A Task 5), `WarmPool::take`, `warm::key_for`.
- Produces: subagent `<cha>~n` có dòng trong `tg-delegations` của cha (agent Claude, việc = tiêu đề subagent, mở được terminal nhỏ, nút Dừng ẩn — dừng subagent riêng chưa có lệnh, dừng cha thì dừng cả); agent con direct lấy phiên mở sẵn khi khoá khớp, không khớp thì mở như cũ.

- [ ] **Step 1: Test** `delegations.spec.ts`: cha có run `<cha>~1` (`parent` = cha) → một mục "Claude" với việc là tiêu đề, mở ra có `tg-agent-terminal`.
- [ ] **Step 2: Test** `delegate_direct_child_takes_warm_session` (tasks/tests.rs, theo khuôn test warm hiện có): pool có phiên đúng khoá (agent, cwd của cha, MCP, bridge) → agent con direct dùng phiên đó (pool rỗng sau đó); agent con `Place::Snapshot` → pool vẫn còn.
- [ ] **Step 3:** Run tests: FAIL; implement; PASS.
- [ ] **Step 4:** Run đủ ba lệnh kiểm tra. Commit `feat(tasks): subagent của Claude trong chat, agent con dùng phiên mở sẵn`.
