# TG Studio

Desktop IDE điều phối nhiều coding agent — **Claude Code, Codex, Gemini CLI, Kiro CLI** — chạy trên macOS và Windows.
Giao diện Angular, lõi Rust (Tauri 2).

> Trạng thái: **Giai đoạn 0** — dò agent trên máy, chạy agent ở chế độ headless, xem log và token/chi phí theo từng agent.

## Cài môi trường (làm 1 lần trên macOS)

```bash
xcode-select --install                                           # Xcode Command Line Tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust (rustup)
node -v                                                          # cần Node 20+ (bạn đang dùng nvm là được)
```

Windows: cài Rust (rustup), Node 20+, và *Visual Studio Build Tools* với gói "Desktop development with C++".

## Chạy

```bash
npm install
npm run dev          # mở app desktop (Angular + Tauri), sửa code là tự reload
npm start            # chỉ chạy UI trong trình duyệt ở "mock mode" — dựng giao diện nhanh, không cần Rust
npm test             # test Angular
(cd src-tauri && cargo test)   # test bộ đọc usage của từng agent
npm run build:app    # đóng gói: src-tauri/target/release/bundle/ (.app, .dmg)
```

Lần đầu `npm run dev` sẽ tải và biên dịch các crate Rust, mất vài phút. Những lần sau nhanh.

## Dùng thử

1. Cột trái tự dò các CLI đã cài. CLI nào thiếu sẽ hiện lệnh cài.
2. Ở giữa: chọn agent, nhập yêu cầu, chọn thư mục làm việc, bấm **Chạy** (⌘↵).
3. Cột phải: token (in / cache / out) và chi phí của từng agent trong phiên.

Gợi ý yêu cầu đầu tiên: *"Giải thích cấu trúc thư mục này trong 5 gạch đầu dòng"* — chỉ cần đọc file nên chạy trơn tru ở chế độ headless.

## Lưu ý ở giai đoạn 0

- **Quyền:** ở chế độ headless (`claude -p`), các thao tác cần duyệt (sửa file, chạy lệnh) sẽ bị từ chối. Thẻ "xin duyệt" như trong mockup đến ở giai đoạn 1 qua ACP.
- **Codex** yêu cầu thư mục làm việc là một git repo.
- **Gemini CLI:** nếu phiên bản của bạn đặt tên định dạng stream khác, sửa trong `src-tauri/src/adapters.rs` (xem `gemini --help`).
- **Kiro CLI:** mới dò được, chưa chạy — Kiro chạy qua ACP (`kiro-cli acp`) ở giai đoạn 1.
- **Chi phí:** Claude Code tự báo `total_cost_usd`. Codex/Gemini chỉ có token — điền bảng giá trong `src/app/core/pricing.ts` nếu muốn ước tính tiền.
- **PATH trên macOS:** app mở từ Finder không thấy PATH của terminal (nvm, Homebrew). Lõi Rust tự hỏi login shell để lấy PATH — xem `src-tauri/src/env.rs`.
- Thư mục `src-tauri/icons/android` và `ios` do `tauri icon` tạo ra, không cần cho desktop, xóa được.

## Cấu trúc

```
src/app/
  core/           protocol (kiểu dữ liệu chung với Rust), backend (Tauri | mock),
                  agents.service, runs.service (signals), pricing, describe-line
  shell/          title bar, agents panel, run console, usage panel, status bar
src-tauri/src/
  adapters.rs     danh sách agent + tham số chạy headless
  detect.rs       dò CLI trong PATH, đọc --version
  runner.rs       chạy tiến trình con, stream stdout/stderr → event "agent-event"
  usage.rs        chuẩn hóa token/chi phí của từng CLI (+ unit test)
  env.rs          lấy PATH từ login shell
docs/ARCHITECTURE.md
```

## Tài liệu

| File | Nội dung |
|---|---|
| [docs/01-product-spec.md](docs/01-product-spec.md) | Tầm nhìn, người dùng, tính năng từng màn, tiêu chí "xong khi" |
| [docs/02-roadmap.md](docs/02-roadmap.md) | Giai đoạn 0–4, checklist task, rủi ro, backlog |
| [docs/03-agent-integration.md](docs/03-agent-integration.md) | ACP vs headless, từng agent, luồng quyền, git worktree |
| [docs/04-usage-and-cost.md](docs/04-usage-and-cost.md) | Token, chi phí, quota, Usage Ledger (SQLite), ngân sách |
| [docs/05-mcp-skills-plugins.md](docs/05-mcp-skills-plugins.md) | Registry MCP/skills, config từng agent, MCP tg-bridge |
| [docs/06-design-system.md](docs/06-design-system.md) | Màu, chữ, khoảng cách, component, trợ năng |
| [docs/07-release.md](docs/07-release.md) | Ký số, notarize, installer, tự cập nhật, CI |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Kiến trúc code hiện tại, hợp đồng sự kiện |

## Lộ trình

| Giai đoạn | Nội dung |
|---|---|
| **0 — Nền móng** (đang ở đây) | Dò agent, chạy headless, log, usage theo agent |
| 1 — Một agent trọn vẹn | ACP client, thẻ duyệt quyền, diff viewer, git worktree |
| 2 — Nhiều agent | Chạy song song, Mission control, so sánh kết quả, pipeline |
| 3 — Usage & tích hợp | Usage ledger (SQLite), ngân sách, quota gói, registry MCP/skills |
| 4 — Đóng gói | Ký số + notarize macOS, installer Windows, tự cập nhật |

Chi tiết từng task: [docs/02-roadmap.md](docs/02-roadmap.md).
