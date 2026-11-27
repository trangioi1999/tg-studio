# Đợt E · Bảng agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Màn Giám sát thành Bảng agent: lưới thẻ cho mọi cuộc trò chuyện đang chạy hoặc xong trong 24 giờ, mỗi thẻ có mèo đúng tư thế, log cuối, chi phí, context; duyệt ngay trên thẻ; bấm thẻ mở cửa sổ lớn.

**Architecture:** Hàm thuần `boardCards` đọc `RunsService.runs` (gồm lịch sử đã nạp). Component mới `tg-agent-board` thay nội dung màn `mission`; KPI cũ thu thành một dòng số liệu. Không đổi lõi Rust.

**Tech Stack:** Angular 22 signals, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-27-claude-desktop-parity-design.md` (mục 5.5, 11.5). Mockup: `docs/mockups/2026-11-27-claude-desktop/Agents.dc.html` (khung 4).

**Phụ thuộc:** đợt D (`UiService.openAgentWindow`, `tg-agent-window`), đợt B (`Run.context`), đợt C (`tool-step.ts`).

## Global Constraints

- CSS chỉ trong `src/styles.scss`, class tiền tố `ab-`. Màn dùng khung `tg-page` (`shared/ui/page.ts`), host có class `center screen`.
- Mọi chuỗi tiếng Việt. Nút ở thanh trái đổi nhãn "Giám sát" → "Bảng agent"; `Screen` vẫn là `'mission'` (không đổi khoá đã lưu).
- Thẻ là `<button>` hoặc `<a>` thật (bấm/Enter mở cửa sổ lớn); nút duyệt trên thẻ dừng lan sự kiện để không mở cửa sổ.
- Mèo theo `mascotPose`; trạng thái thẻ: **Cần bạn** (có `permissions`), **Đang chạy** (`running`), **Xong** (`idle`/`done` trong 5 phút từ event cuối, hoặc vừa kết thúc), **Đang ngủ** (`restored`, hoặc 5 phút không event), **Lỗi** (`failed`).
- Phạm vi: mọi cuộc trò chuyện có run đang chạy/chờ duyệt, cộng cuộc trò chuyện có run kết thúc trong 24 giờ qua; mỗi cuộc trò chuyện một thẻ cho run chính mới nhất, agent con là thẻ riêng ghi "↳ của <cha>".
- Trước khi xong mỗi task: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)` qua.

## Review Focus

1. **Không có agent nào chạy và lịch sử trống**: màn có trạng thái rỗng (mèo `sleep`, "Chưa có agent nào chạy hôm nay.") thay vì lưới trống. Test ở Task 2 (`empty_board_shows_sleeping_cat`).
2. **Run kết thúc 25 giờ trước**: không có thẻ. Test ở Task 1 (`old_runs_are_left_out`).
3. **Duyệt trên thẻ khi thẻ duyệt đã được trả lời ở nơi khác** (người dùng bấm ở ô chat trước): nút trên thẻ biến mất theo signal, bấm muộn không gửi trả lời thứ hai. Test ở Task 2 (`card_approval_disappears_when_answered`).
4. **Bộ lọc không còn thẻ nào** (lọc "Cần bạn" khi không ai chờ): câu "Không có agent nào cần bạn." và nút về "Tất cả". Test ở Task 2.
5. **Agent con của cuộc trò chuyện đã ngủ nhưng con vẫn chạy**: thẻ con vẫn hiện "Đang chạy", thẻ cha theo trạng thái riêng. Test ở Task 1 (`child_state_is_its_own`).

---

### Task 1: Dữ liệu bảng

**Files:**
- Create: `src/app/features/monitor/board.ts`, `src/app/features/monitor/board.spec.ts`

**Interfaces:**
- Consumes: `Run`, `mascotPose` (`features/chat/dock/dock-mascot.ts`), `RunsService.lastEvent`, `costOf`.
- Produces:

```ts
export type BoardState = 'needs_you' | 'running' | 'done' | 'sleep' | 'failed';
export interface BoardCard {
  runId: string; agent: AgentId; title: string; project: string; parentTitle: string | null;
  state: BoardState; pose: MascotPose; tail: string[]; durationMs: number; costUsd: number | null;
  contextPercent: number | null; permission: PermissionRequest | null;
}
export function boardCards(runs: Run[], lastEvent: Record<string, number>, now: number): BoardCard[];
export function boardCounts(cards: BoardCard[]): Record<BoardState | 'all', number>;
```
  - Thứ tự: `needs_you`, `running`, `failed`, `done`, `sleep`; cùng nhóm thì mới nhất trước.
  - `tail`: 3 dòng cuối dạng CLI (`● Name(arg) └ result`) hoặc chữ tin nhắn cuối, mỗi dòng ≤ 80 ký tự.

- [ ] **Step 1: Test** `board.spec.ts`: một run `running`, một `idle` có `permissions`, một `done` 2 giờ trước, một `restored` → thứ tự `needs_you, running, done?/sleep` đúng quy tắc; `pose` của run `running` có bước tool là `'coding'`; `boardCounts` khớp.
- [ ] **Step 2: Test** `old_runs_are_left_out` (Review Focus 2): run kết thúc `now - 25h` → không có thẻ.
- [ ] **Step 3: Test** `child_state_is_its_own` (Review Focus 5): cha `restored`, con (`parent` = cha) `running` → thẻ con `state 'running'`, `parentTitle` là tiêu đề cha.
- [ ] **Step 4:** Run tests: FAIL; implement; PASS.
- [ ] **Step 5:** Commit `feat(monitor): dữ liệu cho Bảng agent`.

---

### Task 2: Màn Bảng agent

**Files:**
- Create: `src/app/features/monitor/agent-board.ts`, `src/app/features/monitor/agent-board.spec.ts`
- Modify: `src/app/features/monitor/mission-control.ts` (gỡ khỏi màn hoặc giữ KPI làm dòng số liệu), chỗ render màn `mission` (`app.ts`/layout), `src/app/layout/thread-list.ts` (nhãn nút), `src/styles.scss`

**Interfaces:**
- Consumes: `boardCards`, `boardCounts` (Task 1), `UiService.openAgentWindow` (đợt D), `RunsService.respondPermission`, KPI hiện có của `mission-control.ts` (`stats`).
- Produces: `tg-agent-board` theo `Agents.dc.html`: `tg-page` tiêu đề "Bảng agent", mô tả "Mọi agent đang chạy trên các dự án. Bấm một thẻ để mở cửa sổ xem nó làm gì.", dòng số liệu (KPI cũ), bộ lọc (Tất cả · N / Cần bạn · N / Đang chạy · N / Xong · N / Đang ngủ · N, `role="tablist"`), lưới `repeat(auto-fill, minmax(360px, 1fr))`; thẻ: mèo 54×60, avatar, tên agent, "↳ của <cha>", tiêu đề, dự án, pill trạng thái, khối log mono 3 dòng, (thẻ Cần bạn) nút "Từ chối" / "Cho phép lần này", dòng `m:ss · $ · ctx N%` có thanh context.

- [ ] **Step 1: Test** `empty_board_shows_sleeping_cat` (Review Focus 1): không có run → có ảnh `mascot/sleep.webp` và câu "Chưa có agent nào chạy hôm nay.".
- [ ] **Step 2: Test** bấm thẻ → `openAgentWindow(runId)`; bấm "Cho phép lần này" → `respondPermission(runId, requestId, 'allow_once' option, false)` và **không** mở cửa sổ.
- [ ] **Step 3: Test** `card_approval_disappears_when_answered` (Review Focus 3): xoá `permissions` của run → nút duyệt trên thẻ biến mất, thẻ chuyển "Đang chạy".
- [ ] **Step 4: Test** lọc "Cần bạn" khi không ai chờ → câu "Không có agent nào cần bạn." và nút "Xem tất cả" đặt lại bộ lọc.
- [ ] **Step 5: Test** thanh trái hiện nhãn "Bảng agent".
- [ ] **Step 6:** Run tests: FAIL; implement; PASS (cập nhật test cũ của `mission-control` cho chỗ đã chuyển, không bỏ assert về KPI).
- [ ] **Step 7:** Playwright ở mock mode: mở Bảng agent khi có run đang chạy và một run chờ duyệt, chụp so với `Agents.dc.html`.
- [ ] **Step 8:** Run đủ ba lệnh kiểm tra. Cập nhật `docs/user-guide.md` (Bảng agent, đổi chế độ giữa phiên, bảng context, agent con trong chat) và `CLAUDE.md` mục Layout. Commit `feat(monitor): Bảng agent thay màn Giám sát`.
