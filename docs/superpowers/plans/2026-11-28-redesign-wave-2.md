# Thiết kế lại · Đợt 2 (khung mới) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đổi khung app theo bản mẫu: sidebar gọn, Cài đặt gom mọi tuỳ chọn, bỏ thanh trạng thái, panel phải có ba tab Agent | Thay đổi | Tệp và ngăn Terminal | Log. Không mất tính năng nào.

**Architecture:**
- Chỉ đổi bố cục và chỗ đặt. Logic (`WorkspaceService`, `DiffViewer`, `Explorer`, editor, `Terminal`, `BudgetService`, `VersionService`, `ResourceMeter`) giữ nguyên, chỉ chuyển chỗ gắn.
- `UiService` có thêm `panelTab`. `Screen` bỏ `'usage'`. `SettingsTab` đổi danh sách.

**Tech Stack:** Angular 22 signals, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-28-redesign-design.md` (mục 5.1, 5.2, 5.5, 5.7). Bản mẫu: `docs/mockups/2026-11-28-redesign/index.html`. Cần Đợt 1 (theme) đã gộp, vì CSS dùng `--accent` và mục Giao diện đã có.

## Global Constraints

- CSS chỉ trong `src/styles.scss`, đặt tên class riêng. Chuỗi hiển thị tiếng Việt.
- Không mất tính năng. Mỗi thứ của khung cũ chuyển sang đúng một chỗ mới:

  | Thứ cũ | Chỗ mới |
  |---|---|
  | `StatusBar`: thông báo ngân sách | thông báo nổi góc dưới phải (`tg-notices`) |
  | `StatusBar`: nhãn phiên bản, kiểm tra cập nhật | Cài đặt › Giới thiệu |
  | `StatusBar`: dòng "Chế độ giả lập" | chip "Giả lập" trên thanh tiêu đề |
  | `StatusBar`: hạn mức | Cài đặt › Sử dụng (Đợt 4 đưa thêm vào bảng context) |
  | `ResourceMeter` | Cài đặt › Giới thiệu |
  | màn `usage` (Chi phí) | Cài đặt › Sử dụng |
  | Explorer, tab editor, So sánh | tab Tệp |
  | tab cố định "Thay đổi" của Workbench | tab Thay đổi |
  | Terminal, Log | ngăn dưới |
  | nhóm "Đang chạy" ở sidebar | bỏ (Bảng agent có số "Cần bạn") |

- `ui.openRun(id, view)`, `workspace.open({kind:'changes'…})` và `ui.openSettings(tab)` vẫn chạy. Chỗ nào đang mở tab Thay đổi của Workbench thì giờ chuyển `panelTab` sang `'changes'`.
- Phím tắt giữ nguyên: ⌘N, ⌘B, ⌘P (QuickOpen tệp), Esc. Thêm ⌘K (Task 3).
- Trước khi xong mỗi task phải qua: `npm run build`, `npm test -- --watch=false`. Không đụng Rust.

## Review Focus

1. **Gõ ⌘P khi đang ở tab Agent:** QuickOpen mở tệp thì panel tự chuyển sang tab Tệp. Test ở Task 4.
2. **Bấm "Xem thay đổi" ở một agent con hoặc thẻ Bảng agent:** mở chat của run đó, panel ở tab Thay đổi. Test ở Task 4.
3. **Cửa sổ hẹp (< 1200 px):** sidebar thu thành dải icon, Tìm kiếm / Bảng agent / Cài đặt vẫn bấm được. Test ở Task 3.
4. **Có thông báo ngân sách sau khi bỏ thanh trạng thái:** vẫn hiện, đóng được. Test ở Task 2.
5. **Đang có agent chạy lệnh mà thu ngăn Terminal:** terminal không bị huỷ, mở lại vẫn còn output (giữ cách `TerminalsService` chuyển phần tử). Test ở Task 4.

---

### Task 1: Cài đặt gom mọi tuỳ chọn

**Files:**
- Modify:
  - `src/app/services/app/ui.service.ts` (`Screen` bỏ `'usage'`; `SettingsTab` thành `'general' | 'appearance' | 'agents' | 'connections' | 'usage' | 'about'`; `openSettings` mặc định `'general'`)
  - `src/app/features/settings/settings.ts` (cột tab dọc bên trái như bản mẫu)
  - `src/app/app.html`
  - mọi chỗ gọi `ui.screen.set('usage')` hoặc `openSettings('prices'|'diagnostics')`
- Test: `src/app/features/settings/settings.spec.ts`

**Interfaces:**
- Produces: `SettingsTab` như trên.
- Nội dung từng mục:

  | Mục | Nội dung |
  |---|---|
  | `general` | ngôn ngữ (tạm chỉ hiện "Tiếng Việt", chọn được ở Đợt 6) |
  | `appearance` | phần của Đợt 1 |
  | `agents` | `tg-agents-panel` |
  | `connections` | `tg-integrations` |
  | `usage` | hạn mức từng agent (`limitView` và `limitsTitle` từ `services/usage/limits`), rồi nội dung màn Chi phí cũ (`tg-usage-screen` hoặc các khối con của nó), rồi `tg-price-settings` |
  | `about` | phiên bản và nút kiểm tra cập nhật (`VersionService`), `tg-resource-meter`, gói chẩn đoán |

- [ ] **Step 1: Test** `settings.spec.ts`:
  - có 6 mục: Chung, Giao diện, Agent, Kết nối, Sử dụng, Giới thiệu
  - `openSettings('usage')` → hiện bảng hạn mức và phần chi phí
  - `openSettings('about')` → hiện nhãn phiên bản và nút "Lưu gói chẩn đoán"
- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt. Spec cũ của các màn này phải sửa theo chỗ mới; không xoá assert nào.
- [ ] **Step 4:** Chạy test. Kết quả mong đợi: PASS. Chạy `npm run build`.
- [ ] **Step 5:** Commit `feat(settings): gom Chi phí, phiên bản, tài nguyên vào Cài đặt`.

### Task 2: Bỏ thanh trạng thái

**Files:**
- Create: `src/app/layout/notices.ts` (`tg-notices`, chuyển từ `status-bar.ts`)
- Modify: `src/app/app.html` (bỏ `<tg-status-bar />`, thêm `<tg-notices />`), `src/app/layout/title-bar.ts` (chip "Giả lập" khi `backend.mode === 'mock'`, tooltip là câu cũ)
- Delete: `src/app/layout/status-bar.ts`. Phần test còn ý nghĩa trong `status-bar.spec.ts` chuyển sang test của `notices` và Cài đặt.
- Test: `src/app/layout/notices.spec.ts`

- [ ] **Step 1: Test:**
  - có notice từ `BudgetService` → `tg-notices` hiện; bấm đóng → gọi `budget.dismiss(i)`
  - chế độ mock → thanh tiêu đề có chip "Giả lập"
  - không còn phần tử `.statusbar`
- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt. `.shell` không còn hàng của thanh trạng thái.
- [ ] **Step 4:** Chạy test. Kết quả mong đợi: PASS. Chạy `npm run build`.
- [ ] **Step 5:** Commit `feat(layout): bỏ thanh trạng thái, thông báo nổi, chip Giả lập`.

### Task 3: Sidebar mới và ⌘K

**Files:**
- Modify: `src/app/layout/thread-list.ts`, `src/app/features/files/quick-open.ts`, `src/styles.scss`
- Delete: `src/app/layout/running-group.ts` và spec của nó (`runningRows` không còn ai dùng)
- Test: `src/app/layout/thread-list.spec.ts` (tạo mới), `src/app/features/files/quick-open.spec.ts`

**Interfaces:**
- `QuickOpen` có thêm `mode: 'files' | 'all'`:
  - ⌘P → `files`, như hiện nay.
  - ⌘K → `all`: cuộc trò chuyện (khớp tiêu đề, chọn thì `ui.openRun`) đứng trước tệp.
  - Cả hai đều bỏ qua khi cửa sổ lớn đang mở.

- [ ] **Step 1: Test:**
  - Thứ tự trong sidebar: Trò chuyện mới, Tìm kiếm (hiện phím ⌘K), Bảng agent (badge = số yêu cầu duyệt đang mở, ẩn khi 0), Dự án…
  - Đáy sidebar: đúng một nút Cài đặt.
  - Không còn "Đang chạy".
  - Không còn dải 3 nút màn hình cũ.
  - Rail (`sidebarCollapsed`): ba nút icon Tìm kiếm, Bảng agent, Cài đặt có `aria-label`.
  - ⌘K mở QuickOpen ở `all`, gõ chữ trong tiêu đề một cuộc trò chuyện → dòng đầu là cuộc trò chuyện đó.
- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt theo bản mẫu: dòng nav cao 32 px, icon 16 px.
- [ ] **Step 4:** Chạy test. Kết quả mong đợi: PASS. Chạy `npm run build`.
- [ ] **Step 5:** Commit `feat(layout): sidebar Tìm kiếm, Bảng agent, Cài đặt; ⌘K tìm cuộc trò chuyện`.

### Task 4: Panel phải ba tab và ngăn dưới

**Files:**
- Modify:
  - `src/app/services/app/ui.service.ts` (`readonly panelTab = signal<'agents' | 'changes' | 'files'>('agents')`; `openRun(id, view)` với view là changes thì đặt `panelTab` sang `'changes'`)
  - `src/app/layout/side-panel.ts` (thanh tab, ba pane, ngăn dưới)
  - `src/app/features/workbench/workbench.ts` (bỏ tab cố định Thay đổi/So sánh và nút đóng panel; chỉ còn tab tệp và editor)
  - `src/app/features/workbench/terminal.ts` (thành ngăn dưới: tab Terminal | Log, nút thu/mở, nhớ chiều cao qua `LayoutService` như `--h-term`)
  - `src/app/layout/title-bar.ts` (bên phải: nút `…` và nút ẩn/hiện panel)
- Create: `src/app/features/agents/agent-lanes.ts`. Ở đợt này chỉ là chỗ giữ chỗ: danh sách run của cuộc trò chuyện (`logSections`), mỗi run một dòng gồm logo, việc, trạng thái. Đợt 3 thay bằng làn thật.
- Test: `src/app/layout/side-panel.spec.ts`

**Interfaces:**
- Pane Thay đổi:
  - `DiffViewer` của run đang chọn.
  - Nếu run thuộc nhóm chạy song song: nút "So sánh" ở đầu pane, mở `Compare` ngay trong pane.
- Pane Tệp: `Explorer` + `Workbench`.
- Nút `…`: menu thao tác cuộc trò chuyện đang có (đổi tên hoặc xoá, theo những gì `ThreadsService` hỗ trợ). Không có thao tác nào thì không hiện nút.

- [ ] **Step 1: Test** `side-panel.spec.ts`:
  - 3 tab có `role="tab"`; tab Thay đổi đếm `workspace.diffs()[run].length`
  - `ui.openRun(id, 'changes')` → `panelTab() === 'changes'`
  - QuickOpen mở một tệp → `panelTab() === 'files'`
  - thu ngăn dưới rồi mở lại → cùng một phần tử xterm (không tạo lại)
  - không còn tab "Thay đổi" trong thanh tab của Workbench
- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt.
  - Panel không tự đổi tab khi có event mới, chỉ đổi khi người dùng hoặc lệnh mở yêu cầu.
  - Ở màn Bảng agent và Cài đặt, panel ẩn như hiện nay.
- [ ] **Step 4:** Chạy test. Kết quả mong đợi: PASS. Chạy `npm test -- --watch=false` và `npm run build`.
  - Mở `npm start`, chạy một việc ở mock.
  - Chụp Playwright: tab Agent, tab Thay đổi có diff, tab Tệp mở một tệp, ngăn Terminal.
- [ ] **Step 5:** Cập nhật `CLAUDE.md` (mục Layout, mục Thay đổi kiểu git chỉ phần vị trí) và `docs/user-guide.md` theo bố cục mới. Commit `feat(layout): panel phải Agent | Thay đổi | Tệp, ngăn Terminal | Log`.

---

## Sau đợt này

- Đợt 3 (làn agent thật trong `agent-lanes.ts`) và Đợt 4 (composer chỉ icon, bảng context có hạn mức, animation gửi) chạy song song được: Đợt 3 sửa `features/agents/agent-lanes.ts` và `run-events.ts` (thời điểm bắt đầu/kết thúc của tool); Đợt 4 sửa `features/chat/composer/*`, `dock/*`.
