# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/); phiên bản theo SemVer. Phiên bản nằm ở `package.json`, đồng bộ sang Rust bằng `npm run version:sync`.

## [Chưa phát hành]

### Giai đoạn 4 — Đóng gói
- Workflow phát hành: tag `vX.Y.Z` tạo bản nháp release với installer macOS (universal) và Windows; chạy tay thì installer nằm ở Artifacts.
- `npm run version:sync` / `version:check`; CI kiểm tra phiên bản khớp.

### Giai đoạn 3 — Usage & tích hợp
- Màn Usage: KPI, biểu đồ theo ngày theo agent, bảng lượt chạy, xuất CSV.
- Bảng giá có lịch sử (đổi giá không đổi số cũ), ngân sách mỗi task / mỗi ngày, tự dừng khi đã có số chi phí.
- Hạn mức gói Claude (5 giờ / 7 ngày) từ `rate_limit_event`.
- Registry MCP bật một lần cho mọi agent (đưa vào từng phiên, không sửa file cấu hình); thư viện Skills cài vào Claude Code.

### Giai đoạn 2 — Nhiều agent
- Chạy song song nhiều agent, màn So sánh, "Dùng bản này", ghép hunk từ nhiều bản và chạy lệnh kiểm tra.
- Pipeline Plan → Build → Review trong cùng một worktree.
- Mission control: hàng chờ, timeline có đoạn chờ duyệt, cột theo agent.
- Layout IDE: Explorer, tab editor, Accept/Reject ngay trong editor, con trỏ agent, panel Thread/Plan/Runs.

### Giai đoạn 1 — Một agent trọn vẹn
- Task sửa code qua ACP trong git worktree riêng, thẻ duyệt lệnh, review từng hunk, commit từ app; kiểm chứng với adapter Claude thật.

### Giai đoạn 0 — Nền móng
- Dò CLI, chạy headless, log, usage theo agent, lịch sử SQLite, CI macOS + Windows.
