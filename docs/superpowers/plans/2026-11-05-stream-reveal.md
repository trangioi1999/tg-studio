# Chữ chạy dần trong chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Làm cùng `2026-11-05-ask-session.md` trên nhánh `claude/ask-session`. Task 1 thuộc plan đó (cờ CLI và fixture đi chung với phiên Chỉ hỏi sống). Task 2–4 giao Codex, mỗi nhóm một worktree; Claude review và commit.

**Goal:** Câu trả lời của agent hiện dần ra (chữ chạy, con trỏ nhấp nháy) ở mọi chế độ (Chỉ hỏi, Sửa code, Pipeline) và với mọi agent.

**Architecture:** Hai lớp. (1) Lấy chữ thật theo thời gian thực: Claude ở Chỉ hỏi chạy thêm `--include-partial-messages`, và `describeLine` nối các `text_delta` vào một dòng tin nhắn. (2) Lớp hiển thị: `tg-markdown` có input `animate`, một signal `shown` đuổi theo `text` mỗi khung hình theo hàm thuần `nextReveal`, nên agent gửi cả khối (Codex) cũng chạy ra từ từ.

**Tech Stack:** Angular 22 (signals, standalone), Vitest, `marked`; Rust (Tauri 2), `serde_json`.

**Spec:** Phần A trong cuộc trao đổi ngày 2026-11-05 (tóm tắt ở mục Context). B (cổng MCP `tg-studio`), C (hook Claude Code), D (đọc transcript) là các plan riêng, viết sau.

## Context

- Sửa code (ACP): `agent_message_chunk` đã được `addLine` (`src/app/core/runs.service.ts:546`) nối vào tin nhắn. Chữ ra theo cụm, không có hiệu ứng.
- Chỉ hỏi với Claude: lệnh là `-p … --output-format stream-json --verbose` (`src-tauri/src/adapters.rs:83` và `:98-106`), nên cả tin nhắn đến một lần.
- Chỉ hỏi với Codex: `describeLine` chỉ đọc `item.completed`/`agent_message` (`describe-line.ts:58`), nên cũng đến cả khối.
- Con trỏ đã có: class `.typing` (`agent-panel.ts:333`), CSS `.md.typing` (`src/styles.scss:780`).
- Bẫy hiện có: `describeLine` biến mọi type JSON lạ thành dòng muted `[type]` (`describe-line.ts:82`). Nếu không chặn, mỗi `stream_event` thành một dòng và đẩy nội dung ra khỏi `MAX_LINES = 2000`.
- Đường `log` trực tiếp dùng `[...run.lines, line]` (`runs.service.ts:437`), không qua `addLine`, nên delta sẽ không được nối nếu không sửa chỗ này.

## Global Constraints

- Chuỗi hiển thị cho người dùng viết bằng tiếng Việt.
- CSS chỉ nằm trong `src/styles.scss`, component trong `shell/` không có style riêng. Màu con trỏ dùng `var(--run)`.
- Signals, `@if/@for`, không zone.js, không NgModule.
- Mọi thay đổi định dạng usage phải kèm unit test trong `usage.rs`.
- `headless_args` của Claude phải luôn giữ `--permission-mode plan`.
- Fixture CLI thật: chỉ dùng yêu cầu chỉ đọc; lọc đường dẫn nhà, email, session id, danh sách tool/plugin trước khi commit.
- Trước khi xong: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`.

## Review Focus

1. Câu trả lời rất dài (50.000 ký tự) đến một lần: UI không treo, hiện hết trong khoảng 100 khung hình (Task 3, `finishes a huge message fast`).
2. Emoji và chữ ngoài BMP: không bao giờ hiện nửa cặp surrogate (Task 3, `never splits a surrogate pair`).
3. Lượt kết thúc ngay sau tin nhắn (Codex gửi tin nhắn rồi `exit` vài ms sau): chữ vẫn chạy nốt, không nhảy ra cả khối (Task 4, `keeps revealing after animate turns off`).
4. Phiên Claude cũ trong lịch sử (không có `stream_event`) vẫn hiện câu trả lời như trước (Task 2: fixture `claude/2.1.317` giữ nguyên expected).
5. Hai khối text liền nhau, hoặc câu hỏi tiếp theo trong cùng phiên, không dính vào tin nhắn trước (Task 2, `seals a message once its final copy arrives`).

---

### Task 1: Claude gửi chữ theo thời gian thực ở Chỉ hỏi (Claude, trong plan ask-session)

Đã làm ở `2026-11-05-ask-session.md` Task 1: lệnh Chỉ hỏi của Claude có `--include-partial-messages`. Fixture thật (Claude Code 2.1.318, hai câu trong một tiến trình, đã lọc đường dẫn/session id/danh sách tool) ở `src-tauri/tests/fixtures/claude/2.1.318/ask-session.jsonl`. Định dạng delta: `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"…"}},…}`.

### Task 2: `describeLine` nối delta và bỏ bản trùng

**Files:**
- Modify: `src/app/core/describe-line.ts`, `src/app/core/runs.service.ts:434-438,525,545-553`
- Test: `src/app/core/describe-line.spec.ts`

**Interfaces:**
- Consumes: định dạng `stream_event` từ fixture của Task 1.
- Produces, trong `describe-line.ts`:
  - `export const MESSAGE_KEY = 'message'`, chuyển từ `runs.service.ts`.
  - `export const FINAL_KEY = 'message-final'`.
  - `export function addLine(lines: ConsoleLine[], line: ConsoleLine | null): ConsoleLine[]`, chuyển từ `runs.service.ts`. `RunsService` import lại hai thứ này.

- [ ] **Step 1: Viết test thất bại** trong `describe-line.spec.ts`:
  - Thêm fixture `claude/2.1.318-ask-session`, chép nguyên các dòng của `src-tauri/tests/fixtures/claude/2.1.318/ask-session.jsonl`, theo đúng cách fixture hiện có được nạp trong spec.
  - `streams Claude text deltas into one message`: gộp mọi dòng qua `lines.reduce((all, l) => addLine(all, describeLine('claude', l)), [])`. Kết quả có đúng **một** dòng `tone: 'text'` cho mỗi câu trả lời trong fixture (câu 1 là `hello`, câu 2 là câu tiếng Việt), không có dòng nào là `[stream_event]`, và vẫn có dòng tool `› Read …` (hoặc tool thực có trong fixture) cùng `✓ success`.
  - `seals a message once its final copy arrives`: chuỗi `[delta 'Xin ', delta 'chào', assistant text 'Xin chào', delta 'Câu hai']` cho ra hai dòng text `'Xin chào'` và `'Câu hai'`.
  - `keeps a final message that had no deltas`: `assistant` text không có delta đứng trước cho ra dòng `{ text, tone: 'text' }`, không có `key`.
  - Fixture `claude/2.1.317` giữ nguyên expected hiện có, nhưng test của nó gộp dòng qua `addLine` như test mới (`FINAL_KEY` là dấu tạm cho `addLine`, không bao giờ còn lại trong `run.lines`). Quyết định 2026-11-05 sau khi Codex phát hiện mâu thuẫn.
- [ ] **Step 2: Chạy** `npm test -- --watch=false --include src/app/core/describe-line.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Cài đặt:**
  - Nhánh `claude` của `describeLine` xử lý `type === 'stream_event'`. Nếu `event.type === 'content_block_delta'` và `delta.type === 'text_delta'` thì trả `{ text: delta.text, tone: 'text', key: MESSAGE_KEY }`. Mọi `stream_event` khác trả `null`.
  - Một dòng `assistant` mà **mọi** phần đều là text thì trả thêm `key: FINAL_KEY`. Dòng có `tool_use` giữ nguyên như cũ.
  - `addLine` nhận dòng `FINAL_KEY`. Nếu dòng cuối có `key === MESSAGE_KEY` và `last.text.trim().endsWith(line.text.trim())`: bỏ dòng mới và xoá `key` của dòng cuối (niêm phong, để delta sau mở dòng mới). Nếu không: thêm dòng mới, bỏ `key`.
  - `runs.service.ts:437` đổi `[...run.lines, line]` thành `addLine(run.lines, line)`.
- [ ] **Step 4: Chạy** `npm test -- --watch=false`. Expected: PASS toàn bộ, kể cả `runs.service.spec.ts`.
- [ ] **Step 5: Commit** `feat(chat): join streamed Claude text into one message`.

### Task 3: Hàm thuần `nextReveal`

**Files:**
- Create: `src/app/core/reveal.ts`, `src/app/core/reveal.spec.ts`

**Interfaces:**
- Produces:
  - `export function nextReveal(shown: number, text: string, dtMs: number): number`: số code unit cần hiện sau `dtMs` mili giây.
  - `export const REVEAL_PER_MS = 0.12`: khoảng 120 ký tự mỗi giây khi không có chữ tồn đọng.
  - `export const REVEAL_CATCHUP_MS = 250`: chữ tồn đọng được đuổi kịp trong khoảng chừng này.
  - `export const REVEAL_MAX_MS = 1500`: không tin nhắn nào hiện lâu hơn khoảng này (đuổi theo tỉ lệ giảm dần theo cấp số nhân nên không tự xong; quyết định 2026-11-05 sau khi test 50.000 ký tự của Codex dừng ở 49.941).

- [ ] **Step 1: Viết test thất bại:**
  - `advances at least one char per frame`: `nextReveal(0, 'abc', 1) >= 1`.
  - `never passes the end`: `nextReveal(2, 'abc', 1000) === 3`.
  - `jumps when text shrank`: `nextReveal(10, 'abc', 16) === 3`.
  - `catches up with a backlog`: với `text` dài 2.000 ký tự, sau 16 vòng lặp `dt = 16` thì `shown > 1000`.
  - `finishes a huge message fast`: với 50.000 ký tự và `dt = 16`, hiện hết trong ≤ 100 vòng.
  - `never splits a surrogate pair`: với `'a😀b'`, không có kết quả nào trên đường đi bằng `2`, tức là ngay sau high surrogate.
- [ ] **Step 2: Chạy** `npm test -- --watch=false --include src/app/core/reveal.spec.ts`. Expected: FAIL (`Cannot find module './reveal'`).
- [ ] **Step 3: Cài đặt** `step = max(2, ceil(dtMs * REVEAL_PER_MS), ceil(backlog * dtMs / REVEAL_CATCHUP_MS), ceil(text.length * dtMs / REVEAL_MAX_MS))`. Kết quả kẹp trong `[0, text.length]`. Nếu code unit tại `next - 1` là high surrogate (`0xD800–0xDBFF`) thì cộng thêm 1.
- [ ] **Step 4: Chạy lại.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): reveal pacing for streamed text`.

### Task 4: `tg-markdown` có `animate`, gắn vào chat

**Files:**
- Modify: `src/app/shell/markdown.ts`, `src/app/shell/agent-panel.ts:333`, `src/styles.scss:780`
- Test: `src/app/shell/markdown.spec.ts`

**Interfaces:**
- Consumes: `nextReveal` từ Task 3.
- Produces:
  - `Markdown.animate = input(false)`.
  - Class host `revealing` khi chữ đang hiện dở.
  - `html` render từ signal nội bộ `shown`, không còn render thẳng từ `text`.

- [ ] **Step 1: Viết test thất bại** trong `markdown.spec.ts`. Dùng `TestBed.createComponent(Markdown)`, `componentRef.setInput`, và `vi.stubGlobal('requestAnimationFrame', …)` với một hàng đợi tự đẩy tay, có `performance.now` giả.
  - `shows text at once without animate`: `textContent` chứa toàn văn ngay sau `detectChanges()`.
  - `reveals over frames with animate`: `animate=true`, text dài 300 ký tự. Sau một khung, `textContent.length` nhỏ hơn 300 và host có class `revealing`. Sau khi đẩy hết hàng đợi thì đủ 300 và mất class.
  - `keeps revealing after animate turns off`: đang hiện dở thì `setInput('animate', false)`. Khung tiếp theo vẫn chỉ tiến theo `nextReveal`, không nhảy ra toàn văn.
  - `respects reduced motion`: stub `matchMedia` trả `matches: true`, `animate=true` vẫn hiện toàn văn ngay.
  - `copy button survives reveal`: text có code block, sau khi hiện xong `pre .copy-code` tồn tại.
- [ ] **Step 2: Chạy** `npm test -- --watch=false --include src/app/shell/markdown.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Cài đặt:**
  - `shown = signal('')`, `html = computed(() => renderMarkdown(this.shown()))`.
  - Một `effect` theo dõi `text()`:
    - Nếu `!text.startsWith(shown)` (tin nhắn bị thay) hoặc đang ở chế độ giảm chuyển động thì đặt `shown = text`.
    - Nếu đang hiện dở, hoặc `animate()` đúng, thì chạy vòng `requestAnimationFrame` gọi `nextReveal` tới khi `shown === text`.
    - Ngoài hai trường hợp trên thì đặt `shown = text`.
  - Huỷ khung đang chờ trong `DestroyRef.onDestroy`.
  - Giảm chuyển động: `globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches`.
  - Host binding `'[class.revealing]': 'shown().length < text().length'`.
- [ ] **Step 4: Gắn vào chat:** ở `agent-panel.ts:333` thêm `[animate]="last && tr.status === 'running'"`. Run nạp lại từ lịch sử không ở trạng thái `running`, nên luôn hiện ngay.
- [ ] **Step 5: CSS:** selector con trỏ ở `styles.scss:780` thành `.md.typing > div > :last-child::after, .md.revealing > div > :last-child::after`. Thêm vào khối `@media (prefers-reduced-motion: reduce)` (dòng 188) quy tắc tắt `animation` của con trỏ.
- [ ] **Step 6: Chạy** `npm test -- --watch=false`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(chat): type out agent replies`.

### Task 5: Nghiệm thu và tài liệu

**Files:**
- Modify: `CLAUDE.md` (mục "Dòng chat"), `docs/user-guide.md` nếu có đoạn mô tả chat

- [ ] **Step 1:** Thêm một câu vào mục "Dòng chat" của `CLAUDE.md`: Claude Chỉ hỏi chạy `--include-partial-messages`; delta mang `MESSAGE_KEY`, bản `assistant` cuối mang `FINAL_KEY` và bị `addLine` bỏ nếu trùng; `tg-markdown[animate]` hiện dần theo `nextReveal` và không chạy lại tin nhắn cũ.
- [ ] **Step 2:** Chạy `npm run build && npm test -- --watch=false && (cd src-tauri && cargo test)`. Expected: tất cả PASS.
- [ ] **Step 3:** Chạy `npm start` (MockBackend). Hỏi một câu ở Chỉ hỏi và một task Sửa code: chữ chạy dần, con trỏ tắt khi xong. Mở lại một cuộc trò chuyện cũ: hiện ngay.
- [ ] **Step 4:** Chạy app thật (`npm run dev`), không cho agent sửa repo này trong lúc đó.
  - Claude Chỉ hỏi: chữ ra theo thời gian thực, không in lặp, usage và chi phí bằng với trước khi đổi.
  - Codex Chỉ hỏi: tin nhắn cả khối vẫn chạy ra.
  - Kiểm tra editor và Monaco trên bản `npm run build`.
- [ ] **Step 5:** Commit `docs: describe streamed replies`, rồi mở PR `feat/stream-reveal` → `main`.

---

## Kiểm tra end-to-end

- Tự động: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`.
- Tay: Task 5, Step 3–4.
- Nếu muốn chắc định dạng trên CLI mới hơn: lặp lại Task 1, Step 1 với phiên bản đó rồi chạy lại test của Task 2.
