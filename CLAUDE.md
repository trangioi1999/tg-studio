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
(cd src-tauri && TG_LIVE_ACP=1 cargo test live_claude -- --ignored --nocapture)  # chạy adapter Claude thật, tốn token
```

Repo chưa cấu hình lint. Prettier có `.prettierrc` nhưng không có script riêng.

## Kiến trúc

Tauri 2: UI Angular gọi lõi Rust, lõi Rust chạy các agent CLI (`claude`, `codex`, `gemini`, `kiro-cli`) thành tiến trình con. Sơ đồ, hợp đồng `agent-event` và nguồn usage của từng agent nằm trong `docs/ARCHITECTURE.md`; đặc tả sản phẩm và tích hợp nằm trong `docs/01`–`07`.

**Luồng một lượt chạy**

1. Ô giao việc trong `AgentPanel` (panel phải) gọi `RunsService.start()`, rồi `AgentBackend.start()` chuyển thành lệnh Tauri `start_agent`.
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
- **Lịch sử:** `runner.rs` ghi event vào SQLite (`store.rs`) trước khi phát lên UI, và lỗi ghi không được làm hỏng lượt chạy. Lượt nạp lại có `restored: true`, nên logic usage của phiên phải dùng `sessionRuns`, không dùng `runs`.

- **Task sửa code:** đi qua `acp_tasks.rs`, không qua `runner.rs`. Logic định tuyến nằm ở `TaskSession` (`acp_runner.rs`), test bằng agent giả `acp/fake.rs`. `stop_agent` dùng chung cho cả hai loại run. Token của task chỉ có trong kết quả `session/prompt`, không có trong `usage_update`.
- **Chạy song song:** các run cùng một yêu cầu có chung `group` (cột `task_id` trong SQLite). "Dùng bản này" đi qua `diff::accept_all`, không lặp `accept_hunk`, để không bao giờ áp dở một run. Lựa chọn của nhóm giữ ở `RunsService.choices`.
- **Hạn mức gói:** event `limits` thuộc về tài khoản, không thuộc run; `RunsService.apply` xử lý nó trước `upsert`. Nguồn duy nhất hiện có là `rate_limit_event` của Claude headless.
- **Layout IDE:** `Explorer` (trái) · `Workbench` (giữa: tab tệp/Thay đổi/So sánh + `Terminal`) · `AgentPanel` (phải: Thread/Plan/Runs + ô giao việc). `WorkspaceService` giữ thư mục/repo, các tab và bộ đệm tệp + diff của từng run (`refresh(runId)`); component nào Accept/Reject hay lưu tệp thì gọi `refresh` để các nơi khác cập nhật. `UiService` giữ màn hình (IDE / Mission control / Usage); mở một run từ chỗ khác bằng `ui.openRun(id, view)`.
- **Thanh hunk trong editor:** view zone chỉ để giữ chỗ, thanh nút là content widget, vì lớp chữ của Monaco nằm trên view zone và nuốt click.
- **Phím tắt:** nhãn lấy từ `core/keys.ts` (⌘ trên macOS, Ctrl nơi khác); handler nhận cả `meta` và `control`.
- **Editor:** Monaco tải lazy qua `core/monaco.ts`; worker là `core/editor.worker.ts` (cần `webWorkerTsConfig` và loader `.ttf` trong `angular.json`). Import Monaco qua `monaco-editor/editor/editor.api.js`, không import `monaco-editor` (kéo theo language service).

**Thêm agent mới:** làm theo `docs/ARCHITECTURE.md`.

**Giao việc cho Codex:** phân công và cách chạy `codex exec` trong worktree nằm ở `docs/superpowers/plans/2026-11-03-roadmap-master.md`.

**Giao diện:** component trong `src/app/shell/` không có style riêng; toàn bộ CSS nằm trong `src/styles.scss`. Chuỗi hiển thị cho người dùng, kể cả lỗi trả về từ Rust, viết bằng tiếng Việt.

Trạng thái hiện tại là giai đoạn 2 (đã có chạy song song + So sánh). Lộ trình nằm trong `docs/02-roadmap.md`.
