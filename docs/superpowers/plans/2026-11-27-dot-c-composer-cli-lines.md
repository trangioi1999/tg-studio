# Đợt C · Ô chat phương án A và dòng chat kiểu Claude CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ô chat thành một khối theo phương án A (dải trạng thái hoặc thẻ duyệt gắn liền phía trên, mèo ngồi trên mép, nút gửi tròn cam); thao tác của agent hiện kiểu `● Update(path) └ +3 −3` với diff nhỏ; thanh trái có nhóm "Đang chạy".

**Architecture:** Chỉ UI. Logic của `LiveStatus`, `Approvals`, `DockMascot`, `Composer` giữ nguyên; đổi chỗ đặt và hình thức. Dòng tool giàu hơn nhờ thêm trường tuỳ chọn vào `ConsoleLine` (chỉ trong phiên đang sống; lịch sử nạp lại vẫn hiện dòng gọn).

**Tech Stack:** Angular 22 signals, Vitest, Playwright (kiểm tra bằng mắt ở mock mode).

**Spec:** `docs/superpowers/specs/2026-11-27-claude-desktop-parity-design.md` (mục 5.1, 5.2). Mockup: `docs/mockups/2026-11-27-claude-desktop/Main.dc.html` (khung 1, ô chat đã là A), `Composer.dc.html` (cột trái: ba trạng thái của A).

**Phụ thuộc:** đợt A (chế độ đổi giữa phiên), đợt B (`Run.live`, chip context — chip đặt vào hàng nút ở đây nếu đợt B đã có, không thì để chỗ).

## Global Constraints

- CSS chỉ trong `src/styles.scss`, dùng biến sẵn có; thêm `--cat: #ff8a3d` (cam của mèo, nút gửi, ký hiệu `✻`) và `--cat-ink: #1a0e05` (chữ trên nền cam). Class mới tiền tố `cx-` (khối ô chat), `cl-` (dòng kiểu CLI), `rn-` (nhóm Đang chạy). Host component mới thêm vào danh sách `display: contents`.
- Mọi chuỗi tiếng Việt. Icon là SVG nét (không emoji). Nút chỉ có icon có `aria-label`.
- Không đổi hợp đồng `AgentBackend` hay Rust trong đợt này.
- Mèo giữ quy tắc tư thế `mascotPose` (`features/chat/dock/dock-mascot.ts`).
- Kiểm tra bằng mắt ở mock mode bản build và `npm start`, chụp màn hình so với mockup; ảnh để trong scratchpad, không commit.
- Trước khi xong mỗi task: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)` qua.

## Review Focus

1. **Đường dẫn tệp rất dài** trong `● Update(…)`: cắt giữa bằng "…" giữ tên tệp, không vỡ dòng, `title` có đường dẫn đầy đủ. Test ở Task 1 (`long_path_is_middle_truncated`).
2. **Diff lớn** (sửa 400 dòng): diff nhỏ chỉ hiện tối đa 6 dòng + "… và N dòng nữa", tổng `+a −b` vẫn đúng. Test ở Task 1 (`mini_diff_is_capped`).
3. **Cửa sổ hẹp** (chat 420 px): hàng nút ô chat xuống dòng gọn, mèo không đè nút; nút gửi luôn thấy. Kiểm bằng Playwright ở Task 2 (viewport 900×700, side panel mở).
4. **Có thẻ duyệt và agent đang chạy cùng lúc**: thẻ duyệt thay dải trạng thái, không hiện cả hai chồng lên. Test ở Task 2 (`approval_replaces_status_tray`).
5. **Nhiều run đang chạy ở nhiều dự án**: nhóm Đang chạy gom đúng, agent con thụt dưới cha, tối đa 8 dòng rồi "+N nữa". Test ở Task 3 (`running_group_nests_children_and_caps`).

---

### Task 1: Dòng tool kiểu Claude CLI

**Files:**
- Create: `src/app/features/chat/conversation/tool-step.ts` (hàm thuần), `src/app/features/chat/conversation/tool-step.spec.ts`
- Modify: `src/app/features/chat/conversation/describe-line.ts` (`ConsoleLine` thêm trường), `src/app/services/runs/run-events.ts` (`applyTool`), `src/app/features/chat/conversation/timeline.ts` (`WorkStep` thêm trường, `segmentsOf` mang sang), `src/app/features/chat/conversation/chat-turn.ts` (vẽ), `src/styles.scss`

**Interfaces:**
- Produces (`tool-step.ts`):

```ts
export interface MiniDiff { path: string; added: number; removed: number; lines: { sign: '+' | '-'; text: string }[]; more: number }
export interface ToolHead { name: string; arg: string | null }
/** Tên tool và đối số chính: `_meta.claudeCode.toolName` nếu có, không thì theo `kind`. */
export function toolHead(update: Record<string, unknown>): ToolHead;
/** Diff nhỏ từ `content[].type === 'diff'` (oldText/newText), tối đa `max` dòng đổi. */
export function miniDiff(update: Record<string, unknown>, max?: number): MiniDiff | null;
/** Một dòng tóm tắt kết quả từ `tool_call_update.content` (dòng cuối khác rỗng, ≤ 120 ký tự). */
export function resultLine(update: Record<string, unknown>): string | null;
export function middleTruncate(path: string, max?: number): string;
```
  - `toolHead`: `kind` → tên khi không có `_meta`: `execute` Bash, `read` Read, `edit` Update, `delete` Delete, `move` Move, `search` Search, `fetch` Fetch, `think` Think, còn lại dùng `title`. `arg` lấy theo thứ tự `rawInput.command` (mảng thì nối bằng dấu cách), `rawInput.file_path`, `rawInput.path`, `rawInput.pattern`, `rawInput.url`, `locations[0].path`; không có thì `null`.
  - `ConsoleLine` thêm `head?: ToolHead`, `result?: string`, `diff?: MiniDiff`. `applyTool` điền ba trường (giữ `text`/`label` cũ để tìm kiếm, log, lịch sử).
  - `WorkStep` thêm `head?`, `result?`, `diff?`; `segmentsOf` chép sang.
  - Vẽ (theo `Main.dc.html`): mỗi bước `● <b>Name</b>(arg)` (chấm màu theo `state`: `--done` xong, `--fail` lỗi, quay khi đang chạy), dòng dưới `└ <result>` hoặc `└ +a −b` khi có diff, rồi diff nhỏ (nền `--add-bg`/`--del-bg`). Bước không có `head` (lịch sử) vẽ như hiện nay. Trong một Nhật ký làm việc: 3 bước cuối luôn hiện, các bước trước gom trong `<details>` "N bước trước".

- [ ] **Step 1: Test** `tool-step.spec.ts`: `toolHead({kind:'execute', rawInput:{command:'npm test'}})` → `{name:'Bash', arg:'npm test'}`; `toolHead({_meta:{claudeCode:{toolName:'Grep'}}, rawInput:{pattern:'Plugins'}})` → `{name:'Grep', arg:'Plugins'}`; `miniDiff` với `content:[{type:'diff',path:'a.astro',oldText:'x\nPlugins\n',newText:'x\nMarketplace\n'}]` → `added 1, removed 1, lines [{sign:'-',text:'Plugins'},{sign:'+',text:'Marketplace'}]`; `resultLine` với text "212 dòng\n" → "212 dòng".
- [ ] **Step 2: Test** `long_path_is_middle_truncated` (Review Focus 1): `middleTruncate('src/app/features/chat/conversation/very/deep/folder/SiteLayout.astro', 40)` có độ dài ≤ 40, kết thúc bằng `SiteLayout.astro`, chứa `…`.
- [ ] **Step 3: Test** `mini_diff_is_capped` (Review Focus 2): diff 400 dòng thêm → `lines.length == 6`, `more == 394`, `added == 400`.
- [ ] **Step 4: Test** trong `timeline.spec.ts`: nhật ký 5 bước có `head` → segment `work` giữ `head`/`diff`; trong `chat-turn` (test component hoặc `agent-panel.spec.ts`) có 3 phần tử `.cl-step` hiện và một `<details>` chứa "2 bước trước".
- [ ] **Step 5:** Run `npm test -- --watch=false`: FAIL; implement; PASS.
- [ ] **Step 6:** Commit `feat(chat): thao tác của agent hiện kiểu Claude CLI`.

---

### Task 2: Ô chat phương án A

**Files:**
- Modify: `src/app/features/chat/composer/composer.ts` (khối, hàng nút, chỗ cho tray/thẻ duyệt/mèo), `src/app/features/chat/agent-panel.ts` (dock chỉ còn `tg-composer` + thẻ ngoài khối như `tg-proposal-card`, `tg-context-alert`), `src/app/features/chat/dock/live-status.ts` (vẽ thành dải trong khối), `src/app/features/chat/dock/approvals.ts` + `permission-card.ts` (vẽ thành dải duyệt trong khối, mèo `thinking`), `src/app/features/chat/dock/dock-mascot.ts` (vị trí: mép phải trên của khối; giữ `away` khi cuộn lên), `src/app/features/chat/composer/perm-menu.ts` (nhãn và icon: Chỉ hỏi, Hỏi trước, Tự làm), `src/styles.scss`
- Test: `src/app/features/chat/agent-panel.spec.ts`

**Interfaces:**
- Consumes: `ChatState` (`run()`, `send()`, `runs.stop()`, `attachments()`), `Run.live` (đợt B), chip `tg-context-chip` (đợt B).
- Produces: cấu trúc DOM của khối (cho test và đợt D):
  - `section.cx` (khối, bo `var(--r-xl)` = 20 px — thêm biến nếu chưa có), con theo thứ tự: `.cx-tray` (dải trạng thái, chỉ khi run `running` và không có thẻ duyệt) **hoặc** `.cx-approve` (thẻ duyệt đầu tiên của run đang chọn), `.cmp-attach`, `textarea#prompt`, `.cx-row` (hàng nút).
  - `.cx-row`: nút "+" tròn (`aria-label="Thêm tệp, lệnh hoặc skill"`, mở menu: Đính kèm tệp, Lệnh `/`; menu dùng lại logic đính kèm và popover lệnh hiện có), `tg-agent-menu`, `tg-perm-menu`, `tg-place-menu` (chỉ trước câu đầu, như hiện nay), khoảng trống, `tg-context-chip`, nút gửi `.cx-send` tròn 36 px nền `--cat` (khi run chạy: nút dừng nền `--text`).
  - Mèo: `tg-dock-mascot` đặt trong `section.cx`, `position:absolute; right:18px; bottom:calc(100% - 8px)`.
  - Vẫn gõ được khi agent chạy. Placeholder khi chạy: "Nhắn thêm, agent đọc sau bước này…". Gửi giữa lượt: giữ hành vi hiện có của `ChatState` (đợt A đã quyết theo agent).

- [ ] **Step 1: Test** `approval_replaces_status_tray` (Review Focus 4): run đang chạy có `permissions[0]` → có `.cx-approve` với nút "Cho phép lần này", không có `.cx-tray`; bỏ permission → có `.cx-tray` chứa đồng hồ.
- [ ] **Step 2: Test** nút gửi: không có run → `.cx-send[aria-label="Gửi"]`; run `running` → `.cx-send[aria-label="Dừng agent"]`, bấm gọi `runs.stop(id)`.
- [ ] **Step 3: Test** mèo nằm trong khối: `section.cx tg-dock-mascot` tồn tại khi có run.
- [ ] **Step 4:** Run `npm test -- --watch=false`: FAIL; implement; PASS (sửa test cũ chỉ ở chỗ selector đổi, không bỏ assert).
- [ ] **Step 5:** Playwright ở mock mode (1280×760 và 900×700 có side panel mở — Review Focus 3): ba trạng thái (đang gõ có tệp, agent đang chạy, chờ duyệt) so với `Composer.dc.html` cột trái; chụp vào scratchpad.
- [ ] **Step 6:** Commit `feat(chat): ô chat phương án A`.

---

### Task 3: Nhóm "Đang chạy" ở thanh trái

**Files:**
- Create: `src/app/layout/running-group.ts` (hàm thuần `runningRows`), `src/app/layout/running-group.spec.ts`
- Modify: `src/app/layout/thread-list.ts`, `src/styles.scss`

**Interfaces:**
- Consumes: `RunsService.runs`, `ThreadsService`, `UiService.openRun(id, view)`, `mascotPose` không cần.
- Produces:

```ts
export interface RunningRow { id: string; agent: AgentId; title: string; child: boolean; status: 'running' | 'needs_you'; project: string }
/** Run đang chạy hoặc chờ duyệt ở mọi dự án; con ngay dưới cha; tối đa `max`, kèm số còn lại. */
export function runningRows(runs: Run[], max?: number): { rows: RunningRow[]; more: number };
```
  - Cha: run không `parent`, `status === 'running'` hoặc có `permissions`. Con: run có `parent` (agent con tg-bridge) hoặc id dạng `<cha>~n` (subagent), đang chạy/chờ duyệt, đặt ngay dưới cha của nó (cha không chạy thì con vẫn hiện, không thụt). `title`: cha là tiêu đề cuộc trò chuyện (`prompt` rút gọn), con là "↳ <Agent> · <việc>".
  - Vẽ (theo `Main.dc.html` thanh trái): tiêu đề nhóm "Đang chạy · N" trên danh sách dự án, mỗi dòng logo agent + tiêu đề + chấm trạng thái (`--run` đang chạy, `--wait` cần bạn); bấm → `ui.openRun(id, 'chat')`. Nhóm ẩn khi rỗng.

- [ ] **Step 1: Test** `running_group_nests_children_and_caps` (Review Focus 5): 2 cha ở 2 dự án, cha A có 2 con → thứ tự `A, A~1, A-child, B`; `child` đúng; 12 run đang chạy với `max 8` → `rows.length 8`, `more 4`; run `idle` không có.
- [ ] **Step 2: Test** `thread-list`: có run đang chạy → hiện "Đang chạy · 1"; bấm dòng gọi `openRun`.
- [ ] **Step 3:** Run tests: FAIL; implement; PASS.
- [ ] **Step 4:** Run đủ ba lệnh kiểm tra. Commit `feat(layout): nhóm Đang chạy ở thanh trái`.
