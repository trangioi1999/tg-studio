# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/); phiên bản theo SemVer. Phiên bản nằm ở `package.json`, đồng bộ sang Rust bằng `npm run version:sync`.

## [Chưa phát hành]

### Mở dự án
- Nút Khởi tạo Git và Tạo commit đầu tiên, xem trước số tệp và các dòng thêm vào `.gitignore`; bí mật và `node_modules` không bao giờ vào commit đầu.
- Cảnh báo một lần khi có tệp chưa commit mà agent sẽ không thấy.

### Bố cục mới
- Chat ở giữa; cột trái là cây dự án và cuộc trò chuyện, mở nhiều dự án cùng lúc, có dự án gần đây; tệp và thay đổi nằm ở panel phải, tự mở một lần khi có thay đổi đầu tiên.
- Thẻ duyệt luôn hiện đủ, kể cả ở cửa sổ nhỏ nhất. Có thẻ tóm tắt "Đã đổi N tệp". Bỏ activity bar và tab Runs.

### Sửa lỗi từ review
- "Luôn cho phép" trên Windows không còn hiểu sai `node.exe`, `git.exe push`.
- Sửa tay chưa lưu không còn mất khi chuyển sang tab Thay đổi hoặc So sánh.
- Ngân sách ngày tự sang ngày mới, không còn chặn sau nửa đêm khi app mở qua đêm.
- Skill ở bảng mã khác được sao lưu trước khi ghi đè. Không còn đọc lại usage theo từng dòng log.

### Khởi động
- Mở app hiện ngay kết quả dò agent lần trước rồi dò lại ở nền, các agent được dò song song. Đọc PATH có giới hạn 5 giây.
- Kiểm tra đăng nhập thật của Claude và Codex, không tốn token; agent khác ghi "chưa rõ".

### Windows
- Nút Dừng và hết giờ diệt cả cây tiến trình, không còn để `node` chạy ngầm sau `.cmd`.
- Prompt nhiều dòng qua shim `.cmd` đi bằng stdin thay vì bị từ chối.
- Lệnh kiểm tra chỉ giữ 64 KB output cuối trong bộ nhớ.
- Báo khi agent im lặng 30 giây, kèm nút Dừng.

### Chat trong một phiên
- Gửi thêm câu là chat tiếp với cùng một agent, không tạo agent mới. Enter để gửi, Shift+Enter để xuống dòng, không gửi nhầm khi đang gõ dấu tiếng Việt.
- Nút Dừng cạnh ô chat chỉ dừng câu đang chạy; có nút Trò chuyện mới. `@agent` hoặc đổi agent giao tiếp trên cùng bản nháp, kèm tóm tắt.
- Quay lại agent cũ sau khi phiên đóng sẽ nối lại đúng phiên nếu agent hỗ trợ.
- Chi phí và token cộng đúng qua nhiều câu; không còn mất tin nhắn cuối lượt.

### Hạn mức tài khoản
- Thanh dưới cùng luôn hiện hạn mức 5 giờ và 7 ngày của từng agent, kèm giờ reset và thời điểm cập nhật. Codex đọc từ log phiên của nó; Claude có số sau lượt chạy đầu.

### Duyệt lệnh
- Phiên do app mở luôn ở chế độ xin duyệt, kể cả khi thiết lập của Claude Code trên máy là tự duyệt.

### Xem source
- Explorer hiện cây thư mục của dự án ngay khi mở, không cần giao việc; bấm tệp để xem ở chế độ chỉ đọc. Khi có task thì chuyển được giữa Dự án và Bản nháp.
- Ẩn mục Worktrees khi trống, khung log thu gọn sẵn.

### Tự dùng app (M-D)
- Chọn thư mục bằng hộp thoại của hệ điều hành; đường dẫn được chuẩn hoá và kiểm tra trước khi lưu, hiện đúng lỗi.
- Windows: không còn bật cửa sổ cmd cho mỗi tiến trình con.
- Codex dùng gói ACP mới `@agentclientprotocol/codex-acp`, đã chạy thật cùng Claude.
- Pipeline: mỗi bước có lịch sử và chi phí riêng. Lượt dừng vì `max_tokens`, `refusal` được báo là lỗi.
- Review: thay đổi agent đã `git add` hay commit không còn biến mất; ô Commit luôn hiện và liệt kê mọi tệp staged.
- Chống gửi trùng khi bấm hai lần; đồng hồ chạy đúng; lỗi khởi động Pipeline không còn bị nuốt.

### tg-bridge
- MCP server `tg-bridge` cho mọi task Sửa code: báo tiến độ, ghi chú chung giữa các agent, đề xuất chuyển việc (người dùng quyết định), xin duyệt, ngữ cảnh task. Bật/tắt ở Integrations.

### Giai đoạn 4 — Đóng gói
- Workflow phát hành: tag `vX.Y.Z` tạo bản nháp release với installer macOS (universal) và Windows; chạy tay thì installer nằm ở Artifacts.
- `npm run version:sync` / `version:check`; CI kiểm tra phiên bản khớp.
- Onboarding lần đầu; nút Chẩn đoán lưu báo cáo JSON (không chứa khóa); `docs/user-guide.md`.

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
