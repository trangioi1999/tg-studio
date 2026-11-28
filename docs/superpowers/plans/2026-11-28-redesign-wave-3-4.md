# Thiết kế lại · Đợt 3 (làn agent) và Đợt 4 (composer, bảng context) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Đợt 3: tab Agent có làn sống cho từng agent trên một trục thời gian chung.
- Đợt 4: composer chỉ còn icon, bảng context có hạn mức 5 giờ và 1 tuần, animation gửi prompt, chữ hiện theo cụm.

**Architecture:**
- Đợt 3:
  - Mỗi dòng tool có thêm `at` (lúc bắt đầu) và `end` (lúc xong), lấy từ `atMs` của event trong `applyTool`.
  - `laneRows(runs, thread, now)` là hàm thuần, dựng làn và các đoạn.
  - `tg-agent-lanes` vẽ ra; làn được mở thì hiện nhật ký riêng.
- Đợt 4: sửa trong `features/chat/composer/*` và `features/chat/dock/*`.
- Hai đợt không đụng tệp của nhau, chạy song song được.

**Tech Stack:** Angular 22 signals, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-28-redesign-design.md` (mục 5.3, 5.4, 5.5). Bản mẫu: `docs/mockups/2026-11-28-redesign/index.html` (hàm `renderLanes`, `updateTracks`, `sendAnimation`, `typeInto`, `renderCtx`). Cần Đợt 1, 2, 5 đã gộp.

## Global Constraints

- CSS chỉ trong `src/styles.scss`. Chuỗi hiển thị tiếng Việt.
- Animation dùng `transform` và `opacity`, có bản dừng khi `[data-motion='off']` và khi `prefers-reduced-motion`.
- Chỉ vẽ theo dữ liệu thật: không có thời điểm thì không vẽ lên trục; không có số thì không hiện dòng.
- Trước khi xong mỗi task phải qua: `npm run build`, `npm test -- --watch=false`. Đợt 3 Task 1 có đụng `run-events.ts`, nên chạy thêm toàn bộ spec của `services/runs`.

## Review Focus

1. **Lịch sử nạp lại** (dòng không có `at`): làn vẫn hiện bước và trạng thái, thanh trục để trống, không vỡ. Test ở Task 1 của Đợt 3.
2. **Hai trăm thao tác trong một làn:** vẽ không giật. Gộp các đoạn liền nhau cùng loại, mỗi làn tối đa 120 đoạn. Test ở Task 1 của Đợt 3.
3. **Subagent `<cha>~n` đến trước run cha trong danh sách:** vẫn thụt dưới cha. Test ở Task 1 của Đợt 3.
4. **Không có hạn mức** (Gemini, hoặc chưa đọc được): bảng context không hiện hai dòng hạn mức. Test ở Task 2 của Đợt 4.
5. **Gửi tin khi đang bật mức chuyển động "Tắt":** tin hiện ngay, không có bóng bay. Test ở Task 3 của Đợt 4.

---

## Đợt 3 · Làn agent

### Task 1: Thời điểm của từng bước và `laneRows`

**Files:**
- Modify: `src/app/features/chat/conversation/describe-line.ts` (`ConsoleLine` thêm `at?: number; end?: number`), `src/app/services/runs/run-events.ts` (`applyTool`: lần đầu thấy `key` thì `at = e.atMs`; lúc trạng thái thành `completed` hoặc `failed` thì `end = e.atMs`)
- Create: `src/app/features/agents/lanes.ts`, `src/app/features/agents/lanes.spec.ts`

**Interfaces:**
- Produces:

```ts
export type SegKind = 'read' | 'edit' | 'exec' | 'wait';
export interface Seg { kind: SegKind; at: number; end: number | null }
export interface Lane {
  runId: string; agent: AgentId; task: string; depth: 0 | 1; sub: boolean;
  state: MascotPose; label: string; now: string; startedAt: number;
  segs: Seg[]; log: string[];
}
export function laneRows(runs: Run[], thread: string, now: number): { lanes: Lane[]; from: number; to: number };
```

**Quy tắc của `laneRows`:**
- Lấy run cùng `thread`, cha trước. Con là run có `parent`, hoặc subagent có id `<cha>~n`; con đứng ngay sau cha, `depth: 1`.
- `kind` của đoạn theo tên tool:

  | Tool | Loại đoạn |
  |---|---|
  | `Read`, `Search`, `Grep`, `Fetch` | `read` |
  | `Update`, `Write`, `Delete`, `Move` | `edit` |
  | `Bash` | `exec` |
  | khoảng đang có `permissions` | `wait` |

- Hai đoạn liền nhau cùng loại thì gộp làm một. Mỗi làn giữ tối đa 120 đoạn, bỏ các đoạn cũ nhất.
- `state`: dùng `mascotPose` của Đợt 5.
- `from` = `startedAt` nhỏ nhất; `to` = `now` nếu còn run đang chạy, nếu không thì `endedAt` lớn nhất.

- [ ] **Step 1: Test** `lanes.spec.ts`:
  - `run-events`: event tool `pending` ở `atMs` 1000, rồi `completed` ở 3000 → dòng có `at` 1000, `end` 3000
  - cha + con `parent` + subagent `p~1` (subagent đứng trước cha trong mảng) → thứ tự `[p, p~1, child]` hoặc theo `startedAt` trong nhóm con, con có `depth` 1
  - Read, Read, Update, Bash → các đoạn `read`, `edit`, `exec` (hai Read gộp làm một)
  - 300 bước → `segs.length <= 120`
  - dòng không có `at` → `segs` rỗng, `now` vẫn là bước cuối
- [ ] **Step 2:** `npm test -- --watch=false --include src/app/features/agents/lanes.spec.ts`. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt.
- [ ] **Step 4:** Chạy test, rồi toàn bộ spec `services/runs`. Kết quả mong đợi: PASS.
- [ ] **Step 5:** Commit `feat(agents): thời điểm từng bước và dữ liệu làn agent`.

### Task 2: `tg-agent-lanes`

**Files:**
- Modify: `src/app/features/agents/agent-lanes.ts` (thay chỗ giữ chỗ của Đợt 2), `src/styles.scss` (class tiền tố `ln-`, theo `.lane*`, `.axis`, `.track` của bản mẫu)
- Test: `src/app/features/agents/agent-lanes.spec.ts`

**Interfaces:**
- Consumes: `laneRows` (Task 1), `RunsService.runs`, `RunsService.now`, `UiService.openAgentWindow`, `tg-mascot` (Đợt 5).

**Mỗi làn:**
- Nút đầu làn: mèo 48 px, logo, tên agent, việc (subagent có chữ "subagent" đứng trước), chữ trạng thái, thời gian.
- Dòng bước đang làm.
- Thanh trục: mỗi đoạn là một `<i>`, đặt `left` và `width` theo % của khoảng `[from, to]`, cập nhật theo `runs.now()`. Không dùng transition cho `left`/`width`.
- Bấm đầu làn: mở hoặc đóng nhật ký (`log`). Nút "Mở to" mở cửa sổ lớn.
- Con thụt vào 16 px, có đường nối kiểu cây.
- Làn mới xuất hiện với animation `spawn` (opacity + translateY).
- Trên cùng: hàng mốc thời gian 0 s … N s. Dưới cùng: chú thích bốn màu.
- Chưa có làn: mèo ngủ và câu "Chưa có agent nào chạy. Gửi một việc, mỗi agent sẽ có một làn ở đây."

- [ ] **Step 1: Test:**
  - 3 làn: con có class thụt vào
  - bấm đầu làn → `aria-expanded="true"` và hiện các dòng `log`
  - đoạn có `at` = `from` + nửa khoảng → `left` khoảng 50%
  - không có run → có mèo `sleep` và câu trống
- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt.
- [ ] **Step 4:** Chạy test. Kết quả mong đợi: PASS. Chạy `npm run build`.
  - Mở `npm start`, gửi "chia việc…" ở mock.
  - Chụp Playwright tab Agent có 3 làn song song.
- [ ] **Step 5:** Commit `feat(agents): làn agent trên trục thời gian chung`.

---

## Đợt 4 · Composer và bảng context

### Task 1: Composer chỉ còn icon

**Files:**
- Modify: `src/app/features/chat/composer/composer.ts`, `agent-menu.ts`, `perm-menu.ts`, `place-menu.ts`, `context-chip.ts`, `src/app/features/chat/dock/live-status.ts`, `src/styles.scss`
- Test: các spec hiện có của composer và `agent-panel.spec.ts`

**Chi tiết:**
- Mỗi nút: icon 32×32, tooltip bằng CSS `[data-tip]` như bản mẫu, đồng thời có `aria-label` cùng nội dung.

  | Nút | Hiện | Tooltip |
  |---|---|---|
  | `+` | dấu cộng | "Thêm tệp, lệnh hoặc skill" |
  | agent | logo | "<Agent>, <model>" |
  | quyền | khiên | "Chỉ hỏi" / "Hỏi trước" / "Tự làm" |
  | nơi làm việc | thư mục | "Thư mục hiện tại" hoặc "Bản nháp từ <nhánh>" |
  | context | vòng % (`conic-gradient` theo `--accent`) | "6%  56.7k / 1M" |

- Menu mở ra giữ nguyên nội dung.
- Dải trạng thái phía trên composer: bỏ chữ "Esc để dừng", thay bằng phím `esc`.

- [ ] **Step 1: Test:** sửa các assert đang tìm chữ trên nút sang tìm `aria-label`. Thêm test: mỗi nút trong `.cx-row` có `aria-label` và `data-tip`; không nút nào có chữ hiển thị (`textContent.trim() === ''`, trừ huy hiệu).
- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt.
- [ ] **Step 4:** Chạy test. Kết quả mong đợi: PASS. Chạy `npm run build`.
- [ ] **Step 5:** Commit `feat(chat): composer chỉ còn icon có tooltip`.

### Task 2: Bảng context có hạn mức

**Files:**
- Modify: `src/app/features/chat/composer/context-panel.ts`, `src/styles.scss`
- Test: `src/app/features/chat/composer/context-panel.spec.ts` (tạo mới nếu chưa có)

**Interfaces:**
- Consumes: hạn mức của agent đang chọn, lấy từ cùng nguồn Cài đặt › Sử dụng dùng (`limitView` trong `services/usage/limits`, dữ liệu từ `RunsService`/`AgentsService`).

**Chi tiết:**
- Thêm khối dưới phần phân bổ token, ngăn bằng một đường kẻ: "Hạn mức 5 giờ" và "Hạn mức 1 tuần".
- Mỗi dòng có phần trăm (mono), thanh mảnh 4 px, và "Đặt lại sau 2 giờ 14 phút" hoặc "Đặt lại thứ Ba, 09:00", tuỳ hạn mức báo gì.
- Kiro dùng cửa sổ `monthly`, nên nhãn là "Hạn mức tháng".
- Không có cửa sổ nào thì không hiện khối này.

- [ ] **Step 1: Test:**
  - Claude có cửa sổ 5h (8%) và 7d (18%) → hai dòng "Hạn mức 5 giờ 8%", "Hạn mức 1 tuần 18%"
  - Gemini (không có) → không có khối `.ctx-limits`
- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt.
- [ ] **Step 4:** Chạy test. Kết quả mong đợi: PASS.
- [ ] **Step 5:** Commit `feat(chat): bảng context có hạn mức 5 giờ và 1 tuần`.

### Task 3: Animation gửi prompt và chữ hiện theo cụm

**Files:**
- Modify: `src/app/features/chat/agent-panel.ts` (chỗ `pending` hiện tin vừa gửi), `src/app/shared/utils/reveal.ts` (`nextReveal`), `src/styles.scss`
- Test: `src/app/shared/utils/reveal.spec.ts`, `src/app/features/chat/agent-panel.spec.ts`

**Chi tiết:**
- Gửi tin: chữ trong ô chat thành một bản sao (`.cx-ghost`), bay tới chỗ bong bóng tin nhắn bằng `transform` trong 480 ms (`cubic-bezier(.3, 1.4, .5, 1)`), rồi bong bóng thật hiện ra.
  - `[data-motion='off']` hoặc reduce motion: bỏ hẳn bản sao, bong bóng hiện ngay.
- `nextReveal` hiện theo cụm từ: luôn dừng ở cuối một từ, không cắt giữa từ. Tốc độ và giới hạn ~3 s giữ như cũ.

- [ ] **Step 1: Test:**
  - `nextReveal` không bao giờ trả về vị trí nằm giữa một từ (thử với "Xin chào thế giới")
  - motion `off` → sau khi gửi, `document.querySelector('.cx-ghost')` là null và bong bóng có ngay
- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt.
- [ ] **Step 4:** Chạy test. Kết quả mong đợi: PASS. Chạy `npm run build`.
  - Mở `npm start`, gửi một tin ở mock, quay GIF bằng Playwright.
- [ ] **Step 5:** Commit `feat(chat): tin bay lên khi gửi, chữ hiện theo cụm từ`.
