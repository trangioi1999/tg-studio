# TG Studio

Desktop IDE điều phối nhiều coding agent — **Claude Code, Codex, Gemini CLI, Kiro CLI** — chạy trên macOS và Windows.
Giao diện Angular, lõi Rust (Tauri 2).

> Trạng thái: **Giai đoạn 4** (đóng gói). Đã có: task sửa code qua ACP trong worktree riêng, duyệt lệnh, review/accept từng hunk ngay trong editor, chạy song song + so sánh + ghép, pipeline Plan → Build → Review, Mission control, màn Usage (giá, ngân sách, CSV, hạn mức Claude), MCP + Skills, onboarding. Lõi đã chạy với Claude thật; Codex, Gemini, Kiro qua ACP chưa thử. Còn lại: ký số, tự cập nhật, beta. Xem `docs/02-roadmap.md`; cách dùng: `docs/user-guide.md`.

## Giao diện

**Chat với agent:** cột trái có logo agent và nhãn trạng thái màu (Đang làm, Chờ duyệt, Xong, Lỗi). Các bước agent làm gom vào một dòng Nhật ký làm việc, câu trả lời hiển thị Markdown, thẻ thay đổi dẫn sang panel diff bên phải.

![Chat, nhật ký làm việc và thay đổi chờ duyệt](docs/images/chat-review.png)

**Duyệt lệnh:** thẻ duyệt ghim ngay trên ô chat; cột trái chuyển sang nhãn vàng Chờ duyệt.

![Thẻ duyệt lệnh](docs/images/approval.png)

**Chọn agent và model:** danh sách model và mức suy nghĩ đọc từ chính CLI. Cuối menu là Giao cho nhiều agent và Theo các bước.

![Menu chọn agent, model và mức suy nghĩ](docs/images/agent-menu.png)

**Chạy song song và so sánh:** cùng một yêu cầu cho nhiều agent, chọn một bản hoặc ghép từng thay đổi rồi chạy test trên bản ghép.

![So sánh và ghép kết quả của nhiều agent](docs/images/compare.png)

**Mission control:** hàng chờ việc của bạn, timeline có đoạn chờ duyệt, một cột cho mỗi agent.

![Mission control](docs/images/mission-control.png)

**Usage:** chi phí và token theo ngày theo agent, bảng giá, ngân sách, hạn mức gói, xuất CSV.

![Màn Usage](docs/images/usage.png)

<sub>Ảnh chụp ở chế độ mock (`npm start`), dữ liệu là mẫu.</sub>

**Review giao diện:** mở `docs/ui-review/index.html` trong trình duyệt. **Toàn cảnh** xếp 16 màn hình theo luồng trên một bảng kéo/phóng to được, **▶ Trình chiếu** tự chạy lần lượt từng màn kèm chú thích, **Review** để đánh dấu Đạt / Cần sửa và chép kết quả.

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

1. Lần đầu mở, hướng dẫn 4 bước dò CLI, đăng nhập, chọn repo và chạy thử.
2. Gõ yêu cầu ở ô bên phải, chọn chế độ (Chỉ đọc, Sửa code, Song song, Pipeline), bấm **Chạy** (Ctrl+↵ / ⌘↵).
3. Duyệt lệnh khi agent hỏi, rồi Accept / Reject từng thay đổi và Commit. Chi tiết: [docs/user-guide.md](docs/user-guide.md).

Gợi ý yêu cầu đầu tiên: *"Giải thích cấu trúc thư mục này trong 5 gạch đầu dòng"* — chỉ cần đọc file nên chạy trơn tru ở chế độ headless.

## Lưu ý

- **Quyền:** chế độ *Chỉ đọc* chạy headless, nên thao tác cần duyệt sẽ bị từ chối. Chế độ *Sửa code* chạy qua ACP, có thẻ xin duyệt, và lần đầu tải adapter bằng `npx` nếu máy chưa có.
- **Codex** yêu cầu thư mục làm việc là một git repo.
- **Gemini CLI:** nếu phiên bản của bạn đặt tên định dạng stream khác, sửa trong `src-tauri/src/adapters.rs` (xem `gemini --help`).
- **Kiro CLI:** không có chế độ headless, nên chỉ dùng được ở Sửa code / Song song / Pipeline qua ACP (`kiro-cli acp`); chưa kiểm chứng với Kiro thật.
- **Chi phí:** Claude Code tự báo `total_cost_usd`. Codex/Gemini chỉ có token — nhập bảng giá ở màn Usage nếu muốn ước tính tiền.
- **PATH trên macOS:** app mở từ Finder không thấy PATH của terminal (nvm, Homebrew). Lõi Rust tự hỏi login shell để lấy PATH — xem `src-tauri/src/env.rs`.
- Thư mục `src-tauri/icons/android` và `ios` do `tauri icon` tạo ra, không cần cho desktop, xóa được.

## Cấu trúc

```
src/app/
  core/           protocol (kiểu dữ liệu chung với Rust), backend (Tauri | mock),
                  agents.service, runs.service (signals), pricing, describe-line
  shell/          title bar, agents panel, run console, usage panel, status bar,
                  permission card, diff viewer, code editor (Monaco)
src-tauri/src/
  adapters.rs     danh sách agent + tham số chạy headless
  detect.rs       dò CLI trong PATH, đọc --version
  runner.rs       chạy tiến trình con, stream stdout/stderr → event "agent-event"
  usage.rs        chuẩn hóa token/chi phí của từng CLI (+ unit test)
  env.rs          lấy PATH từ login shell
  store.rs        lịch sử lượt chạy (SQLite)
  acp/, acp_runner.rs, acp_tasks.rs   task sửa code qua ACP
  worktree.rs, diff.rs, workspace.rs  worktree, hàng chờ hunk, file cho editor
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
| [docs/user-guide.md](docs/user-guide.md) | Hướng dẫn sử dụng cho người dùng |
| [CHANGELOG.md](CHANGELOG.md) | Thay đổi theo phiên bản |

## Lộ trình

| Giai đoạn | Nội dung |
|---|---|
| **0 — Nền móng** | Dò agent, chạy headless, log, usage theo agent |
| 1 — Một agent trọn vẹn | ACP client, thẻ duyệt quyền, diff viewer, git worktree |
| 2 — Nhiều agent | Chạy song song, Mission control, so sánh kết quả, pipeline |
| 3 — Usage & tích hợp | Usage ledger (SQLite), ngân sách, quota gói, registry MCP/skills |
| **4 — Đóng gói** (đang ở đây) | Ký số + notarize macOS, installer Windows, tự cập nhật |

Chi tiết từng task: [docs/02-roadmap.md](docs/02-roadmap.md).
