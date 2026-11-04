# Giai đoạn 2 — Nhiều agent: Plan

**Goal:** 3 agent chạy song song cùng 1 task, chọn/ghép kết quả, merge (`docs/02-roadmap.md`).

**Nguyên tắc:** mỗi run vẫn là một task GĐ1 đầy đủ (worktree, nhánh, adapter, thẻ duyệt riêng). GĐ2 chỉ thêm khái niệm *nhóm* và các thao tác trên nhóm, không đổi vòng đời một run.

## Đã xong

### 2.2 Scheduler N agent, N worktree
- `start_task(agent, prompt, repo, group?)`; `group` lưu ở cột `task_id` (có sẵn từ schema v1), trả về trong `StoredRun.group`.
- `worktree::create` khóa trong tiến trình: tạo nhiều worktree cùng lúc trên một repo không ghi đè `info/exclude` (`parallel_creates_on_one_repo_all_succeed`).
- UI: chế độ *Song song* trong composer, chọn ≥ 2 agent; `RunsService.startParallel` chạy từng agent, agent nào không khởi động được thì báo riêng, không chặn các agent khác.

### 2.3 Màn So sánh
- `diff::accept_all` + lệnh `accept_all`: một patch `--binary` cho cả run, `apply --check` trên repo và worktree trước khi áp. Xung đột thì không đổi gì (`accept_all_conflict_changes_nothing`).
- `tg-compare`: mỗi agent một thẻ (tệp, +/−, token, chi phí, thời gian, tin nhắn cuối), "Xem thay đổi" mở review từng hunk, "Dùng bản này" → xác nhận → commit → dọn worktree của nhóm.
- Nghiệm thu: Playwright ở mock mode (3 agent) và `live_claude_parallel_group_use_one` (2 phiên Claude thật cùng lúc).

### 2.7 Con trỏ agent + vạch màu
- `RunsService.activity`: tệp agent đang làm, lấy từ event `tool` (`locations[].path/line`, `content[].type = diff`, `rawInput.file_path`). Update sau chỉ có `toolCallId`, nên nhớ đường dẫn và loại tool theo id. Xóa khi run kết thúc.
- Editor: chế độ "Theo agent" (bật mặc định, tắt khi người dùng tự chọn tệp), nhãn "đang sửa/đang xem" trong danh sách tệp, con trỏ có tên agent ở dòng đang sửa, nạp lại tệp + diff khi tool sửa file hoàn tất.
- Mock: thay đổi chỉ vào worktree khi tool Edit hoàn tất, như adapter thật. Playwright đo: vạch màu hiện ~186 ms sau khi sửa xong.

### 2.5 Mission control + hàng chờ
- Nút thứ hai ở activity bar; `UiService` giữ màn hình và view của console, nên mọi màn mở được một run (`openRun`).
- `Run.waits`: khoảng chờ duyệt lấy từ `permission` → `permission_resolved` (hoặc `exit`), chỉ có ở run trực tiếp.
- KPI, hàng chờ (Duyệt lệnh → Review → Commit; nhóm song song chỉ một dòng review, có lựa chọn chưa commit thì thành dòng Commit), timeline 12 run gần nhất, cột theo agent. Đồng hồ timeline tick 1 lần/giây và chỉ khi có run đang chạy.
- Playwright ở mock mode: 1 task đơn + nhóm 3 agent, duyệt từ hàng chờ, review nhóm mở màn So sánh.

### 2.6 Ghép hunk từ nhiều bản
- `compose.rs`: đọc hết patch của các hunk được chọn trước, rồi tạo worktree `mix` tại base chung (`worktree::create_at`) và `git apply --recount` từng hunk. Hunk nào không áp được thì xóa worktree ghép và báo tên tệp. Các bản khác base thì từ chối.
- `run_check`: chạy lệnh của người dùng qua shell hệ thống (`sh -c` / `cmd /C`) trong worktree ghép, giới hạn 10 phút, giữ 64 KB cuối của output.
- Bản ghép chỉ sống trong phiên app (`Composites`), không lưu SQLite. "Dùng bản ghép" đi qua `accept_all` như một run; `GroupChoice` có `compositeId`.
- UI: khối "Ghép thủ công" trong màn So sánh. Playwright ở mock mode: chọn 3 hunk từ 2 agent → tạo → kiểm tra → áp → commit.

### 2.4 Pipeline engine
- `start_task(..., reuse)`: bước sau chạy trong worktree của bước trước (bảng `runs` có cột `worktree_owner`, schema v4). Bước trước còn chạy thì từ chối; spawn hỏng không bao giờ xóa worktree dùng chung; xóa worktree từ bất kỳ bước nào cập nhật mọi bước.
- `PipelineService` (UI): mỗi bước có agent + mẫu prompt (`{{task}}`, `{{previous}}`, `{{diff}}` — diff cắt ở 30 000 ký tự). Bước xong thì chạy bước kế; bước lỗi/dừng thì dừng pipeline. Pipeline chỉ sống trong phiên app.
- UI: chế độ *Pipeline* trong ô giao việc (mặc định Plan → Build → Review, nhớ ở localStorage), thanh bước trong Thread.

## Còn lại (theo thứ tự đề xuất)

| ID | Việc | Ghi chú |
|---|---|---|
| 2.1 | Adapter ACP Codex, Gemini | Đã có lệnh khởi chạy trong `adapters.rs`; cần máy có tài khoản OpenAI/Google để chạy kịch bản của `live_claude_*`. **Chủ repo.** |
