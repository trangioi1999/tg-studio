# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Lệnh

```bash
npm install                     # cần chạy lần đầu
npm run dev                     # app desktop (Tauri + Angular), cần Rust
npm start                       # chỉ UI trong trình duyệt, chạy với MockBackend, không cần Rust
npm run build                   # build Angular
npm run build:app               # đóng gói vào src-tauri/target/release/bundle/

npm test -- --watch=false                               # test Angular (Vitest), chạy một lần
npm test -- --watch=false --include src/app/app.spec.ts # một file spec
(cd src-tauri && cargo test)                            # test Rust
(cd src-tauri && cargo test claude_result_line)         # một test Rust
```

Repo chưa cấu hình lint. Prettier có `.prettierrc` nhưng không có script riêng.

## Kiến trúc

Tauri 2: UI Angular gọi lõi Rust, lõi Rust chạy các agent CLI (`claude`, `codex`, `gemini`, `kiro-cli`) thành tiến trình con. Sơ đồ, hợp đồng `agent-event` và nguồn usage của từng agent nằm trong `docs/ARCHITECTURE.md`.

**Luồng một lượt chạy**

1. `RunConsole` gọi `RunsService.start()`, rồi `AgentBackend.start()` chuyển thành lệnh Tauri `start_agent`.
2. `runner.rs` lấy tham số từ `AgentKind::headless_args`, spawn tiến trình con và trả về `runId`.
3. Mỗi dòng stdout đi qua `usage::parse_line`. Nếu dòng có usage, lõi phát thêm event `usage` trước event `log` của chính dòng đó.
4. `RunsService.apply()` gộp event vào signal `runs`. `describeLine()` đổi JSON thô thành dòng console ở phía UI, nên Rust chỉ chuyển nguyên dòng.

**Những điểm cần đọc nhiều file mới thấy**

- **Thứ tự event:** event `started` có thể đến trước khi `start()` nhận được `runId`. Vì vậy `upsert()` tạo run từ event đầu tiên, còn `prompt` và `cwd` được điền sau.
- **Hai backend:** `app.config.ts` chọn `TauriBackend` hoặc `MockBackend` qua `isTauri()`. Thêm phương thức vào `AgentBackend` thì phải cài ở cả hai. Thêm lệnh Tauri thì đăng ký thêm trong `generate_handler!` ở `lib.rs`.
- **Quy ước usage:** `inputTokens` luôn không gồm phần đọc từ cache. Codex và Gemini báo tổng nên phải trừ phần cache; Claude thì cộng `cache_creation_input_tokens` vào input. `cumulative` quyết định `mergeUsage` thay thế hay cộng dồn số cũ.
- **Chi phí:** dùng `costUsd` do CLI báo nếu có, không thì ước tính từ `PRICES` trong `pricing.ts`. Bảng giá hiện đều là `null`, nên UI chỉ hiện token.
- **Trạng thái dừng:** `stop_agent` kill tiến trình và event `exit` có `code` là null. UI phân biệt `stopped` với `failed` bằng tập `stopping` trong `RunsService`, không phải bằng dữ liệu từ lõi.
- **PATH:** mọi tiến trình con phải dùng `env::which` và `.env("PATH", env::login_path())`, nếu không app mở từ Finder sẽ không thấy CLI cài qua nvm hoặc Homebrew.
- **Kiro:** `headless_args` trả về `None`, và `detect.rs` dựa vào đó để đặt cờ `headless`. Kiro chỉ dò được, chưa chạy được cho đến khi có ACP ở giai đoạn 1.

**Thêm agent mới:** làm theo `docs/ARCHITECTURE.md`, và cập nhật thêm những chỗ tài liệu đó chưa nêu: `AgentKind::ALL`, `AGENT_IDS`, `PRICES`, `MockBackend.detectAgents`.

**Giao diện:** component trong `src/app/shell/` không có style riêng; toàn bộ CSS nằm trong `src/styles.scss`. Chuỗi hiển thị cho người dùng, kể cả lỗi trả về từ Rust, viết bằng tiếng Việt.

Trạng thái hiện tại là giai đoạn 0. Lộ trình các giai đoạn nằm trong `README.md`; chưa có ACP, thẻ duyệt quyền hay lưu trữ usage bền vững.
