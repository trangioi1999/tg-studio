# Thiết kế lại · Đợt 1 (theme) và Đợt 5 (mèo sprite) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đưa theme Kiln/Bisque có màu nhấn và chế độ chuyển động vào app (Đợt 1), và thay mèo ảnh tĩnh bằng mèo sprite 8 trạng thái theo event thật (Đợt 5).

**Architecture:**
- Đợt 1:
  - Giữ tên biến CSS hiện có trong `src/styles.scss`. Hai khối `[data-theme='kiln']` và `[data-theme='bisque']` cung cấp cùng một bộ biến.
  - `--cat`/`--cat-ink` đổi tên một lần thành `--accent`/`--accent-ink`, lấy giá trị theo `[data-accent]`.
  - `ThemeService` đặt `data-theme`, `data-accent`, `data-motion` trên `<html>` và lưu lựa chọn vào localStorage.
  - Monaco và xterm đọc màu từ biến CSS.
- Đợt 5:
  - `tg-mascot` chạy sprite sheet bằng CSS `steps()`.
  - `mascotPose` trả về 8 trạng thái mới.
- Hai đợt chạy song song trong hai worktree; chỉ cùng đụng `styles.scss`, ở hai vùng khác nhau.

**Tech Stack:** Angular 22 signals, Vitest, SCSS, Monaco, xterm.

**Spec:** `docs/superpowers/specs/2026-11-28-redesign-design.md` (mục 5.7, 5.8, 5.9). Bản mẫu: `docs/mockups/2026-11-28-redesign/index.html`. Sprite: `docs/mockups/2026-11-28-redesign/pet/`.

## Global Constraints

- CSS chỉ trong `src/styles.scss`; component không có style riêng. Chuỗi hiển thị tiếng Việt (song ngữ là Đợt 6).
- Mọi màu đi qua biến CSS: ngoài các khối token, không còn hex/rgb/oklch nào trong `styles.scss`. Ngoại lệ duy nhất là `--win-close`, giữ một giá trị cho cả hai theme.
- localStorage keys: `tg.theme` (`system` | `dark` | `light`), `tg.accent` (`ember` | `moss` | `tide` | `plum`), `tg.motion` (`full` | `light` | `off`). Mặc định: `dark`, `ember`, `full`.
- Thuộc tính trên `<html>`:
  - `data-theme` = `kiln` | `bisque`
  - `data-accent` = tên màu nhấn
  - `data-motion` = `full` | `light` | `off`
  - `src/index.html` đặt sẵn `data-theme="kiln" data-accent="ember" data-motion="full"` để không nháy khi mở.
- `prefers-reduced-motion: reduce` được coi như `off` cho mèo.
- Trước khi xong mỗi task phải qua: `npm run build`, `npm test -- --watch=false`. Không đụng Rust.

## Review Focus

1. **Theo hệ thống:** máy đổi sáng ↔ tối trong lúc app đang mở thì app đổi theo ngay, không cần mở lại. Test ở Task 1 (`follows the system while open`).
2. **localStorage hỏng** (giá trị lạ như `tg.theme = "purple"`): rơi về mặc định, không ném lỗi. Test ở Task 1.
3. **Theme sáng còn sót chữ trắng trên nền trắng** do một màu viết thẳng giá trị. Script kiểm token ở Task 2 bắt được.
4. **Đang mở tệp trong Monaco hoặc terminal mà đổi theme:** đổi ngay, không phải mở lại tab. Test ở Task 3.
5. **Mèo ở chế độ "Tắt" hoặc reduce motion:** đứng yên ở khung đầu, vẫn hiện, không biến mất. Test ở Task 5.

---

## Đợt 1 · Theme

### Task 1: `ThemeService`

**Files:**
- Create: `src/app/services/app/theme.service.ts`, `src/app/services/app/theme.service.spec.ts`
- Modify: `src/index.html` (thuộc tính mặc định trên `<html>`), `src/app/app.ts` (inject để service chạy khi mở app)

**Interfaces:**
- Produces:

```ts
export type ThemeMode = 'system' | 'dark' | 'light';
export type Accent = 'ember' | 'moss' | 'tide' | 'plum';
export type Motion = 'full' | 'light' | 'off';
@Injectable({ providedIn: 'root' }) export class ThemeService {
  readonly mode: WritableSignal<ThemeMode>;
  readonly accent: WritableSignal<Accent>;
  readonly motion: WritableSignal<Motion>;
  /** The theme actually applied: system resolved through prefers-color-scheme. */
  readonly resolved: Signal<'kiln' | 'bisque'>;
}
```

- [ ] **Step 1: Test** `theme.service.spec.ts`:
  - mặc định → `<html data-theme="kiln" data-accent="ember" data-motion="full">`
  - `mode.set('light')` → `data-theme="bisque"`, và `localStorage['tg.theme'] === 'light'`
  - `accent.set('tide')` → `data-accent="tide"`
  - localStorage `tg.theme = "purple"` → mode là `dark`
  - `follows the system while open`: mode `system`, giả lập `matchMedia('(prefers-color-scheme: light)')` đổi `matches` rồi phát event `change` → `resolved()` thành `'bisque'`
- [ ] **Step 2:** `npm test -- --watch=false --include src/app/services/app/theme.service.spec.ts`. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt.
  - Đọc localStorage một lần; giá trị lạ thì dùng mặc định.
  - Mỗi lần đổi thì ghi localStorage và đặt thuộc tính `<html>` (dùng `effect`).
  - `matchMedia` nghe event `change`, gỡ listener khi service bị huỷ.
- [ ] **Step 4:** Chạy lại test. Kết quả mong đợi: PASS.
- [ ] **Step 5:** Commit `feat(theme): ThemeService lưu chế độ, màu nhấn, chuyển động`.

### Task 2: Token Kiln và Bisque trong `styles.scss`

**Files:**
- Modify: `src/styles.scss` (khối `:root` dòng 3–57, cùng mọi giá trị màu viết thẳng ngoài khối, khoảng 21 chỗ)
- Create: `scripts/check-tokens.mjs`
- Modify: `package.json` (thêm `"check:tokens": "node scripts/check-tokens.mjs"`)

**Interfaces:**
- Consumes: thuộc tính `<html>` của Task 1.
- Produces:
  - Mọi biến màu hiện có, giữ nguyên tên: `--bg --panel --raised --hover --active --input --bubble --line-soft --line --line-strong --line-hover --text-strong --text --text-2 --term-bg --muted --faint`; các bộ `--run*`, `--wait*`, `--done*`, `--fail*`; `--add* --del* --focus --ok --warn --err --scrim --scrim-strong --shadow-pop`.
  - `--accent`, `--accent-ink` thay cho `--cat`, `--cat-ink`.
  - Màu cú pháp mới: `--syn-keyword --syn-fn --syn-string --syn-type --syn-comment --syn-delim --syn-number`. Monaco dùng ở Task 3, và thay các hex cú pháp hiện có trong `styles.scss`.

- [ ] **Step 1:** Viết `scripts/check-tokens.mjs`.
  - Script đọc `src/styles.scss` và lấy ra từng khối `:root`, `[data-theme='kiln']`, `[data-theme='bisque']`, `[data-accent=…]`.
  - Lỗi (thoát với mã 1) khi:
    - còn giá trị `#hex`, `rgb(`, `rgba(` hay `oklch(` nằm ngoài các khối đó (trừ `--win-close`);
    - một biến có trong khối kiln mà thiếu trong khối bisque, hoặc ngược lại.
- [ ] **Step 2:** `npm run check:tokens`. Kết quả mong đợi: FAIL, liệt kê các màu viết thẳng hiện có.
- [ ] **Step 3:** Chuyển màu sang các khối theme.
  - `:root` giữ phần không phải màu (font, cỡ chữ, bo góc, chiều cao, thời lượng).
  - Khối kiln lấy giá trị theo bản mẫu:

    | Biến | Giá trị |
    |---|---|
    | `--bg` | `oklch(14.5% 0.01 50)` |
    | `--panel` | `oklch(17.5% 0.012 50)` |
    | `--raised` | `oklch(21% 0.014 50)` |
    | `--hover` | `oklch(23% 0.015 50)` |
    | `--active` | `oklch(25% 0.016 50)` |
    | `--input` | `oklch(16% 0.011 50)` |
    | `--bubble` | `oklch(21% 0.014 50)` |
    | `--term-bg` | `oklch(12% 0.008 50)` |
    | `--line-soft` / `--line` / `--line-strong` / `--line-hover` | `oklch(96% 0.01 80 / 0.06)`, `/ 0.09`, `/ 0.16`, `/ 0.26` |
    | `--text-strong` | `oklch(98% 0.01 80)` |
    | `--text` | `oklch(94% 0.015 80)` |
    | `--text-2` | `oklch(80% 0.02 70)` |
    | `--muted` | `oklch(64% 0.02 60)` |
    | `--faint` | `oklch(58% 0.02 60)` |

    Màu trạng thái giữ giá trị hiện có.
  - Khối bisque:

    | Biến | Giá trị |
    |---|---|
    | `--bg` | `oklch(97% 0.01 80)` |
    | `--panel` | `oklch(94.5% 0.013 78)` |
    | `--raised` | `oklch(91% 0.016 76)` |
    | `--hover` | `oklch(89% 0.017 75)` |
    | `--active` | `oklch(87% 0.018 74)` |
    | `--input` | `oklch(98.5% 0.006 80)` |
    | `--bubble` | `oklch(92% 0.015 76)` |
    | `--term-bg` | `oklch(99% 0.005 80)` |
    | các bậc `--line` | `oklch(25% 0.02 45 / 0.06)`, `/ 0.1`, `/ 0.18`, `/ 0.28` |
    | `--text-strong` | `oklch(15% 0.02 45)` |
    | `--text` | `oklch(22% 0.02 45)` |
    | `--text-2` | `oklch(38% 0.02 45)` |
    | `--muted` | `oklch(50% 0.02 50)` |
    | `--faint` | `oklch(47% 0.02 50)` |
    | `--run` | `oklch(52% 0.14 245)` |
    | `--wait` | `oklch(56% 0.14 70)` |
    | `--done` | `oklch(50% 0.13 150)` |
    | `--fail` | `oklch(54% 0.18 27)` |
    | `--scrim` | `oklch(30% 0.02 50 / 0.25)` |
    | `--shadow-pop` | `0 16px 40px oklch(30% 0.03 50 / 0.2)` |

    Các biến `-bg`, `-line`, `-tint`, `-ink`, `-hover` của từng màu trạng thái suy ra bằng `color-mix(in oklch, var(--run) 14%, transparent)` cho `-bg`, 35% trộn với `--bg` cho `-line`, 8% với `--bg` cho `-tint`. Tương tự cho `wait`, `done`, `fail`.
  - Màu nhấn, mỗi màu hai bậc:

    | Màu | Theme tối | Theme sáng |
    |---|---|---|
    | ember | `oklch(70% 0.19 45)` | `oklch(58% 0.17 48)` |
    | moss | `oklch(72% 0.13 145)` | `oklch(52% 0.12 145)` |
    | tide | `oklch(70% 0.12 230)` | `oklch(50% 0.12 235)` |
    | plum | `oklch(68% 0.14 350)` | `oklch(50% 0.14 350)` |

    `--accent-ink` là `oklch(16% 0.02 40)` ở theme tối, `oklch(99% 0.005 80)` ở theme sáng.
  - Đổi tên `--cat` → `--accent`, `--cat-ink` → `--accent-ink` ở mọi chỗ dùng.
  - Bóng của mèo (`rgba(255, 140, 40, 0.35)`) thành `color-mix(in oklch, var(--accent) 35%, transparent)`.
- [ ] **Step 4:** Kiểm tra lại.
  - `npm run check:tokens`. Kết quả mong đợi: PASS.
  - `npm test -- --watch=false` và `npm run build` đều qua.
- [ ] **Step 5:** Commit `feat(theme): token Kiln và Bisque, màu nhấn chọn được`.

### Task 3: Monaco và xterm theo theme

**Files:**
- Modify: `src/app/features/editor/monaco.ts:105-135` (`defineTheme`), `src/app/features/workbench/xterm.ts:20`, `src/app/services/workbench/terminals*.ts` (chỗ giữ các xterm, nếu có)
- Test: `src/app/features/editor/monaco-theme.spec.ts` (tệp mới)

**Interfaces:**
- Consumes: `ThemeService.resolved`, `ThemeService.accent`.
- Produces: `export function editorTheme(read: (name: string) => string, base: 'vs' | 'vs-dark'): MonacoThemeData`, đặt trong `monaco.ts`. Hàm này tạo theme từ các biến `--bg`, `--text`, `--muted`, `--raised`, `--line`, `--syn-*`.

- [ ] **Step 1: Test** `monaco-theme.spec.ts`: với một hàm `read` giả, `editorTheme(read, 'vs')` trả về:
  - `base: 'vs'`
  - `colors['editor.background']` bằng giá trị `--bg`
  - quy tắc `keyword` lấy màu từ `--syn-keyword`, chuyển sang dạng hex 6 ký tự (Monaco không nhận oklch: đổi qua canvas, hoặc `color-mix` → `getComputedStyle` một phần tử tạm)

  Test thứ hai: đổi `resolved` thì `monaco.editor.setTheme` được gọi với `'tg-light'` hoặc `'tg-dark'` (mock api).
- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt.
  - Định nghĩa hai theme `tg-dark` và `tg-light` lúc tải Monaco.
  - Một `effect` trên `ThemeService` định nghĩa lại theme rồi gọi `setTheme`, vì màu nhấn có thể đổi.
  - xterm: đọc lại biến và gán `term.options.theme` cho mọi terminal đang mở khi theme đổi.
- [ ] **Step 4:** Chạy test. Kết quả mong đợi: PASS. Build qua.
- [ ] **Step 5:** Commit `feat(theme): Monaco và terminal đổi màu theo theme`.

### Task 4: Mục Giao diện trong Cài đặt

**Files:**
- Modify: `src/app/features/settings/settings.ts`, `src/app/services/app/ui.service.ts` (`SettingsTab` thêm `'appearance'`), `src/styles.scss` (class tiền tố `ap-`)
- Test: `src/app/features/settings/settings.spec.ts` (tạo mới nếu chưa có)

**Interfaces:**
- Consumes: `ThemeService` (Task 1).

- [ ] **Step 1: Test** `settings.spec.ts`:
  - tab "Giao diện" có ba nhóm: Chế độ (Theo hệ thống / Tối / Sáng), Màu nhấn (4 nút tròn có `aria-label` Ember, Moss, Tide, Plum, và `aria-pressed`), Chuyển động (Đầy đủ / Nhẹ / Tắt)
  - bấm "Sáng" → `ThemeService.mode() === 'light'`
  - bấm Tide → `accent() === 'tide'`
- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Thêm tab `appearance` ("Giao diện") đứng đầu danh sách tab. Bố cục theo bản mẫu: tên và mô tả bên trái, nút bên phải, kèm hai ô xem trước Kiln/Bisque. Ô xem trước là phần tử đặt `data-theme` riêng.
- [ ] **Step 4:** Chạy test. Kết quả mong đợi: PASS. Chạy `npm run build`.
- [ ] **Step 5:** Commit `feat(settings): mục Giao diện chọn theme, màu nhấn, chuyển động`.

---

## Đợt 5 · Mèo sprite

### Task 5: `tg-mascot` chạy sprite sheet

**Files:**
- Create: `public/mascot/sprite/{idle,thinking,typing,running,waiting,success,error,sleep}.webp`, chép từ `docs/mockups/2026-11-28-redesign/pet/*.webp` (8 khung ngang, mỗi khung 256×256)
- Modify: `src/app/shared/ui/mascot.ts`, `src/styles.scss` (khối `.mascot*` dòng 955–975), và các nơi gọi pose cũ: `features/chat/home/chat-home.ts`, `features/monitor/board.ts`, `features/chat/dock/context-alert.ts`
- Test: `src/app/shared/ui/mascot.spec.ts`

**Interfaces:**
- Produces:

```ts
export type MascotPose = 'idle' | 'thinking' | 'typing' | 'running' | 'waiting' | 'success' | 'error' | 'sleep' | 'wave';
/** Frames per sheet and the fps Codex picked (docs/mockups/2026-11-28-redesign/pet/manifest.json). */
export const SPRITES: Record<Exclude<MascotPose, 'wave'>, { frames: 8; fps: number }>;
// fps: idle 5, thinking 6, typing 10, running 12, waiting 8, success 10, error 6, sleep 4
```

  - Inputs của `Mascot`: `pose`, `size` (px, khung vuông), `lead` (`boolean`, mặc định `false`: mèo chính được chuyển động ở mức "Nhẹ").
  - Output `waved` giữ nguyên.
  - `wave` phát sprite `waiting` một vòng, rồi bắn `waved`.
  - Bỏ `coding` và `oops`; chỗ gọi đổi sang `typing` và `error`.

- [ ] **Step 1: Test** `mascot.spec.ts`:
  - `pose="typing"` → `.mascot-strip` có `background-image` chứa `mascot/sprite/typing.webp` và `animation-duration` là `0.8s` (8/10)
  - `pose="wave"` → sau event `animationiteration` thì bắn `waved` đúng một lần
  - `aria-label` theo pose (ví dụ `typing` → "Mèo TG đang gõ code", `running` → "Mèo TG đang chạy lệnh", `waiting` → "Mèo TG chờ bạn duyệt", `error` → "Mèo TG gặp lỗi")
- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Cài đặt.
  - Template: `.mascot` > `.mascot-strip`. Dải sprite rộng 800%, chạy `transform: translateX(0 → -100%)` với `steps(8)`, lặp vô hạn, thời lượng = `frames / fps`. Riêng `wave` chạy 1 vòng.
  - `.mascot` vuông theo `size`.
  - Mèo chỉ chiếm khoảng 83% khung, nên dải sprite phóng 118% và đặt `bottom: -4%` như bản mẫu.
  - CSS dừng animation (`animation-play-state: paused`, đứng ở khung đầu) khi:
    - `[data-motion='off']`
    - `[data-motion='light'] .mascot:not([data-lead])`
    - `@media (prefers-reduced-motion: reduce)`
  - Bỏ các keyframe nhún cũ và `.mascot-z`: sprite đã có sẵn chữ z.
- [ ] **Step 4: Test** cho Review Focus 5: với `data-motion="off"` trên `<html>`, `getComputedStyle(strip).animationPlayState === 'paused'` và mèo vẫn hiện. Nếu jsdom không tính được CSS, kiểm thuộc tính `data-lead` và kiểm bằng Playwright ở Task 6. Sau đó chạy test, kết quả mong đợi: PASS.
- [ ] **Step 5:** Commit `feat(mascot): mèo sprite 8 trạng thái của Codex`.

### Task 6: `mascotPose` theo event thật

**Files:**
- Modify: `src/app/features/chat/dock/dock-mascot.ts` (`mascotPose`; `DockMascot` truyền `lead`), `src/app/features/monitor/board.ts` (pose của thẻ), `src/app/features/chat/agent-window/agent-window.ts`
- Test: `src/app/features/chat/dock/dock-mascot.spec.ts`

**Interfaces:**
- Consumes: `MascotPose` (Task 5), `Run`, `ConsoleLine.head` (`{ name, arg }`), `StepState` từ `segmentsOf`.
- Produces: `mascotPose(run, clock): MascotState`, cùng chữ ký như cũ nhưng trả về các pose mới.

- [ ] **Step 1: Test** `dock-mascot.spec.ts`, mỗi dòng một trường hợp:

  | Tình huống | Pose |
  |---|---|
  | `running` có `permissions` | `waiting` |
  | `running`, chưa có dòng nào từ `turnStart` | `thinking` |
  | `running`, bước cuối đang chạy là `Bash` | `running` |
  | `running`, bước cuối đang chạy là `Update`/`Write`, hoặc segment cuối là chữ | `typing` |
  | `running`, segment cuối là `delegate` (đang chờ agent con) | `thinking` |
  | `failed` | `error` |
  | `restored` | `sleep` |
  | vừa xong trong `CHEER_MS` | `success` |
  | rảnh quá `NAP_MS` | `sleep` |

- [ ] **Step 2:** Chạy test. Kết quả mong đợi: FAIL.
- [ ] **Step 3:** Sửa `mascotPose`: lấy bước `running` cuối trong segment `work`; tên tool `Bash` (hoặc kind `execute`) thì ra `running`. `DockMascot` truyền `[lead]="true"`. Thẻ ở Bảng agent và cửa sổ lớn không truyền.
- [ ] **Step 4:** Chạy test. Kết quả mong đợi: PASS. Rồi chạy `npm test -- --watch=false` và `npm run build`.
  - Mở `npm start`, gửi một việc ở mock, xem mèo chuyển nghĩ → gõ → chờ duyệt → chạy lệnh → xong.
  - Chụp ảnh bằng Playwright ở mỗi trạng thái.
  - Đặt `data-motion="light"`: chỉ mèo ở ô chat chuyển động.
- [ ] **Step 5:** Commit `feat(mascot): mèo theo việc agent đang làm`.

---

## Thứ tự chạy

- Đợt 1 (Task 1 → 4) và Đợt 5 (Task 5 → 6) chạy song song, mỗi đợt một worktree.
- Gộp Đợt 1 trước. Đợt 5 rebase lên sau, chỉ có thể xung đột ở khối `.mascot*` trong `styles.scss`, vì nó dùng `--accent` thay `--cat`.
- Đợt 2 (khung mới), 3 (làn agent), 4 (composer và bảng context), 6–7 (song ngữ) có kế hoạch riêng, viết sau khi đợt này xong.
