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

## Còn lại (theo thứ tự đề xuất)

| ID | Việc | Ghi chú |
|---|---|---|
| 2.7 | Con trỏ agent + vạch màu cập nhật ≤ 1s | Editor nghe event `tool` có `locations`/`content.type = diff` để nạp lại file đang mở. Không cần tài khoản ngoài. |
| 2.5 | Mission control + merge queue | Timeline từ `startedAt/endedAt` và khoảng chờ duyệt (event `permission` → `permission_resolved`). Merge queue = các nhóm/run đã accept nhưng chưa commit. |
| 2.6 | Cherry-pick hunk từ nhiều worktree; chạy test trên bản ghép | Ghép trong một worktree tạm từ base, áp hunk đã chọn từ nhiều run, chạy lệnh test do người dùng nhập (qua thẻ duyệt). |
| 2.4 | Pipeline engine | Bước = (agent, prompt mẫu, quyền); output bước trước (tin nhắn cuối, diff) chèn vào prompt bước sau. Test bằng `acp/fake.rs`. |
| 2.1 | Adapter ACP Codex, Gemini | Đã có lệnh khởi chạy trong `adapters.rs`; cần máy có tài khoản OpenAI/Google để chạy kịch bản của `live_claude_*`. **Chủ repo.** |
