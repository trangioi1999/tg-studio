# 06 · Design system

Mockup tham chiếu: canvas **"Multi-Agent Coding App"** trên claude.ai (artboard *IDE · Editor + Agent panel* và *IDE · Mission control*). Hàng "Glass" trong canvas là hướng cũ, **không dùng** cho IDE.

## 1. Nguyên tắc

1. **Cuộc trò chuyện là trung tâm, khung giao diện lùi lại.** Nền gần đen, viền 1px, không gradient, không bóng đổ lớn.
2. **Màu = danh tính agent.** Khung UI trung tính; màu rực chỉ dùng cho agent và trạng thái.
3. **Mật độ cao, chữ nhỏ nhưng đủ tương phản.** 12–13px cho UI, 12.5px mono cho code.
4. **Mọi thao tác chính có phím tắt** và hiện phím tắt cạnh nút.
5. **Trạng thái không chỉ dựa vào màu** — luôn kèm chữ (Running / Needs you / Done).

## 2. Token màu (nguồn: `src/styles.scss`)

| Token | Giá trị | Dùng cho |
|---|---|---|
| `--bg` | `#0a0a0b` | Nền app, terminal |
| `--panel` | `#0e0e10` | Sidebar, title bar, status bar |
| `--raised` | `#131316` | Thẻ, composer |
| `--hover` | `#17171b` | Hover hàng |
| `--line` / `--line-soft` | `#1e1e22` / `#17171a` | Viền, phân cách |
| `--text` / `--text-2` | `#e4e4e7` / `#c4c4ca` | Chữ chính / phụ |
| `--muted` | `#8a8a93` | Nhãn, metadata (đạt ≥ 4.5:1 trên `--panel`) |
| `--focus` | `#8ab4ff` | Focus ring, trạng thái running |
| `--ok` / `--warn` / `--err` | `#6fd3a8` / `#e8b672` / `#f29b8b` | Xong / cần duyệt / lỗi |

**Màu agent** (`AGENT_META` trong `protocol.ts`):

| Agent | Màu | Viết tắt |
|---|---|---|
| Claude Code | `#E07B53` | CL |
| Codex | `#3FB68B` | CX |
| Gemini CLI | `#6E9BF5` | GM |
| Kiro CLI | `#A78BFA` | KR |

Thêm agent mới: chọn màu khác biệt cả về **độ sáng**, không chỉ sắc độ; chữ trên avatar dùng `#0a0a0b`.

**Syntax (editor):** keyword `#C4A7FF` · function `#7CC4FF` · string `#A5D6FF` · type `#F2CC8F` · comment `#7D8590` · punctuation `#A1A1AA`.
**Diff:** thêm nền `rgba(63,182,139,0.09)` + vạch màu agent; xóa nền `rgba(248,81,73,0.09)` + vạch `#F85149`.

## 3. Chữ

| Vai trò | Font | Cỡ / độ đậm |
|---|---|---|
| UI | Inter → `-apple-system` → `Segoe UI` | 13px / 400–600 |
| Nhãn nhóm (EXPLORER, USAGE…) | UI | 11px / 600, letter-spacing 0.06em, in hoa |
| Tiêu đề task | UI | 14–18px / 600, letter-spacing −0.01em |
| Code, log, path, số token | JetBrains Mono → `ui-monospace` | 12–12.5px |

Đóng gói font sau bằng `@fontsource/inter` và `@fontsource/jetbrains-mono` để app chạy offline.

## 4. Khoảng cách & kích thước

- Lưới 4px. Padding panel 12px; thẻ 10–12px; khoảng giữa nhóm 14px.
- Bo góc: 4px (avatar, tag) · 6px (nút, input) · 8–10px (thẻ, console).
- Chiều cao: title bar 40 · tab 36 · hàng cây 24 · nút 28–30 (sm 24) · status bar 24.
- Bố cục desktop: sidebar 260 · cột chat tối đa 760 · panel phải (cây tệp 220 + editor) co giãn, thành lớp phủ dưới 1200px.
- macOS: title bar dùng `titleBarStyle: Overlay`, chừa 84px bên trái cho nút cửa sổ.

## 5. Component

| Component | Ghi chú |
|---|---|
| `AgentAvatar` | Ô vuông bo 4px, màu agent, 2 chữ viết tắt. Cỡ 14/16/18/24/26 |
| Chip trạng thái | Nền màu trạng thái 14–16% alpha + chữ cùng tông |
| Nút | `primary` (nền chữ sáng), `ghost` (viền), `sm` |
| Segmented control | Nền `#151518`, mục chọn `#222226` |
| Thẻ xin duyệt | Nền `#19150F`, viền `#4A3820`, nút chính màu `--warn`, phím tắt ⌘↵ |
| ~~Thanh hunk~~ | Đã bỏ (2026-11-12): giữ/bỏ theo tệp ở tab Thay đổi |
| Khung usage | Grid: avatar · tên + nhãn nguồn + in/cache/out · thanh ctx · cost |
| Console | Mono, tone: text / tool (`#a9c6ff`) / muted / error / ok |

## 6. Trợ năng

- Tương phản chữ ≥ 4.5:1 (kể cả chữ 11px xám).
- Phần tử bấm được là `<button>`/`<a>` thật; nút chỉ có icon phải có `aria-label`.
- Focus ring `--focus` 2px luôn hiện khi điều hướng bằng bàn phím.
- Tôn trọng "Reduce motion" và "Increase contrast" của hệ điều hành.

## 7. Theme sáng (sau 1.0)

Giữ nguyên cấu trúc token; chỉ đổi giá trị trong `:root[data-theme='light']`. Màu agent giữ nguyên sắc độ, giảm độ sáng để đạt tương phản trên nền trắng.
