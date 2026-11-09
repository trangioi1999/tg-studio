# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/); phiên bản theo SemVer. Phiên bản nằm ở `package.json`, đồng bộ sang Rust bằng `npm run version:sync`.

## [Chưa phát hành]

## [0.6.0] - 2026-11-09

### Thêm
- Agent giao một phần việc cho agent khác (Codex, Claude, Gemini, Kiro) để làm song song. Agent con hiện lồng ngay dưới câu đã giao; bấm vào để xem nó đang làm gì.
- Thanh dưới hiện phiên bản và mã commit của bản đang chạy (`v0.6.0 · abc1234`). App kiểm tra bản mới nhất trên GitHub lúc mở, mỗi 6 giờ và khi bấm vào, rồi báo khi có bản mới.

### Thay đổi
- Tab Thay đổi làm việc theo tệp như Git: chọn tệp để commit hoặc hoàn tác, thay cho duyệt từng đoạn.
- Agent con làm cùng chỗ với cuộc trò chuyện: đang làm thẳng trên thư mục thì agent con cũng làm thẳng ở đó, không tạo bản nháp trong `.tg/`. Chỉ khi chọn Bản nháp thì agent con mới có bản nháp riêng và được gộp về khi xong.

### Sửa lỗi
- Lỗi "The following paths are ignored by one of your .gitignore files: .tg" khi bắt đầu task, khi xem thay đổi hoặc khi giao việc cho agent thứ hai, sau khi thư mục `.tg/` đã có trong repo.

## [0.5.1] - 2026-11-07

### Thay đổi
- Cây tệp, tab và ⌘P dùng bộ icon Material Icon Theme (MIT) như VS Code: thư mục có icon riêng theo tên (`components`, `services`, `models`, `hooks`, `utils`, `docs`…, đóng/mở), tệp theo tên và đuôi (`.component.ts`, `.service.ts`, `.spec.ts`, `package.json`, `Dockerfile`…).

### Sửa lỗi
- macOS không còn hỏi quyền Documents/Desktop/Downloads mỗi lần mở app: bản đóng gói giờ được ký (ad-hoc) nên macOS nhớ lựa chọn Cho phép. Sau mỗi bản cập nhật vẫn có thể hỏi lại một lần.
- Lệnh đọc hạn mức Claude chạy trong thư mục tạm riêng thay vì thư mục home, để Claude không đọc quanh home và kéo theo các hộp hỏi quyền.

## [0.5.0] - 2026-11-07

### Thêm
- Kéo để đổi cỡ các khung: cột trái, khung chat với khung code, cây tệp, khung log. Bấm đúp đường viền để về mặc định; app nhớ cỡ cho lần sau.
- Mở nhanh tệp bằng ⌘P / Ctrl+P.
- Khung code giống editor hơn: tab xem trước (bấm một lần để xem, bấm đúp để giữ), biểu tượng loại tệp, ô lọc tệp, cây thư mục dự án mở dần và tự hiện tệp đang mở, bản đồ thu nhỏ, dòng ghim ngữ cảnh, màu cặp ngoặc, dòng trạng thái (dòng/cột, ngôn ngữ, Alt+Z xuống dòng), nút chép đường dẫn.
- Agent chạy trong TG Studio giao việc cho Codex qua `handoff_to` để Codex hiện thành cuộc trò chuyện riêng, thay vì chạy `codex exec` ngầm mà app không thấy.

### Sửa lỗi
- Khi nối lại cuộc trò chuyện, các dòng `[session/load] … phase=…` (adapter Claude ghi thời gian đọc lại phiên, không tốn token) không còn hiện như lỗi trong khung chat.

## [0.4.0] - 2026-11-07

### Thay đổi
- Làm lại màn Chi phí: thẻ tổng quan, biểu đồ theo ngày, phần "Hạn mức gói" gộp vào màn này.
- Làm lại màn Kết nối (MCP server, skill, lệnh của agent) cho gọn và dễ đọc hơn.

## [0.3.2] - 2026-11-07

### Sửa lỗi
- Sau khi bấm Dừng giữa chừng, gửi câu tiếp trong cùng cuộc trò chuyện thì agent không được duyệt sửa tệp nào (agent thấy "Tool use aborted") và câu trả lời của nó không hiện. Mỗi lượt mới giờ mở lại phiên.
- Bấm Giữ trên thay đổi mà agent đã tự `git add` hoặc commit báo "already exists in index"; giờ được ghi nhận là đã giữ.

## [0.3.1] - 2026-11-07

### Sửa lỗi
- Không thấy agent trên máy mà PATH chỉ khai báo trong `~/.bash_profile` trong khi shell mặc định là zsh (hoặc ngược lại): app hỏi PATH từ cả zsh lẫn bash rồi gộp lại.

## [0.3.0] - 2026-11-07

### Tài nguyên và dò agent
- Thanh dưới hiện RAM và CPU mà TG Studio cùng các agent đang dùng; bấm để xem từng cuộc trò chuyện và **Dừng** agent không dùng nữa để giải phóng bộ nhớ.
- Sửa lỗi không thấy agent nào khi shell khởi động chậm (thường gặp trên Mac Intel có oh-my-zsh, nvm): chờ shell lâu hơn và luôn tìm thêm ở các thư mục cài quen thuộc (Homebrew, nvm, fnm, volta, bun, `~/.local/bin`).
- Gói Chẩn đoán ghi PATH app đọc được và cách đọc, để biết vì sao một agent không hiện.

## [0.2.0] - 2026-11-07

### Chat mượt hơn (2026-11-07)
- Bấm gửi là tin nhắn hiện ngay kèm "Đang khởi động …", không còn đứng màn hình vài giây trong lúc agent mở phiên; không gửi được thì chữ trở lại ô chat.
- Xoá cuộc trò chuyện ở cột trái (xác nhận ngay tại dòng): xoá lịch sử chat và bản nháp, giữ nguyên code của bạn và số liệu Chi phí.
- Hạn mức gói Claude đọc bằng `/usage` của Claude Code (không tốn token) lúc mở app và mỗi 5 phút; Codex đọc từ nhật ký phiên của nó. Bấm vào số ở thanh dưới để cập nhật.
- Chỉ hỏi → Làm luôn: khi Claude lên kế hoạch sửa code mà đang ở Chỉ hỏi, thẻ **Làm luôn** chuyển cuộc trò chuyện sang Hỏi trước và làm theo kế hoạch đó.
- Gõ `/` ở đầu ô chat (Codex: `$`) để chọn skill của dự án, của máy, của plugin hoặc lệnh của agent; màn Kết nối có mục *Skill agent đang thấy*.
- Codex nhiều câu trong một phiên đã kiểm chứng với Codex thật.
- GitHub Actions chỉ chạy khi chủ repo bảo (CI, Release, Download site).

### Quyền và nơi làm việc
- Mọi agent có đủ 3 quyền: **Chỉ hỏi**, **Sửa code · hỏi trước**, **Tự động** (agent tự chạy, không hiện thẻ duyệt; `git push`/`merge` vẫn bị chặn). Kiro và Gemini trả lời câu hỏi trong một bản nháp tạm và bị từ chối mọi thao tác ghi.
- Sửa code mặc định làm thẳng trong **thư mục hiện tại**: panel Thay đổi chỉ hiện phần agent sửa (không lẫn phần bạn đang sửa dở), **Giữ** đưa vào commit, **Hoàn tác** trả từng đoạn về như cũ. Chọn **Bản nháp** để agent làm trong bản sao riêng, tạo từ nhánh bạn chọn.
- Đổi agent hoặc quyền giữa chừng vẫn ở cùng cuộc trò chuyện.
- Menu model hiện nguyên văn lỗi khi không đọc được danh sách model; thêm `scripts/probe-acp.mjs` để thử bằng tay.

### Giao diện mới
- Làm lại giao diện theo hướng T3 Code: thanh tiêu đề riêng (Windows/Linux có nút cửa sổ của app), màn chào và màn Trò chuyện mới với ô chat lớn ở giữa, phím `Ctrl+N`.
- Logo thật của Claude Code, Codex, Gemini CLI và Kiro thay cho chữ viết tắt. Cột trái hiện logo agent và nhãn trạng thái có màu: Đang làm, Chờ duyệt, Xong, Lỗi.
- Chat không còn hiện log thô (`hook_progress`, `init`, đường dẫn CLI, `✓ success`). Các bước của agent gom vào một dòng Nhật ký làm việc, câu trả lời hiển thị Markdown.
- Ô chat có hai nút: chọn agent + model + mức suy nghĩ, và chọn quyền (Chỉ hỏi / Sửa code) có chú thích. Giao cho nhiều agent và Theo các bước nằm trong menu agent.

### Kiro
- Nhận ra Kiro đã đăng nhập qua `kiro-cli whoami`.
- Chọn Kiro khi đang ở Chỉ hỏi thì tự chuyển sang Sửa code, thay vì gửi việc rồi báo lỗi "chưa chạy được ở chế độ Chỉ đọc".

### Chọn model
- Đọc danh sách model và mức suy nghĩ từ chính agent (`configOptions` của ACP), không tốn token. Sửa code áp dụng qua `session/set_config_option`; Chỉ hỏi truyền `--model`/`--effort` (Claude) hoặc `-m`/`model_reasoning_effort` (Codex).

### Cuộc trò chuyện
- Chia theo thư mục con: dấu + trên thư mục trong cây tệp mở cuộc trò chuyện làm việc từ thư mục đó, và cột trái nhóm theo thư mục.
- Hiện cả cuộc trò chuyện khi có nhiều agent nối tiếp. Chỉ hỏi cũng hỏi tiếp được, nối đúng phiên của CLI.

### An toàn
- Chế độ Chỉ hỏi chặn ghi bằng cờ của CLI. Trước đây, nếu Claude Code trên máy đặt `defaultMode: auto`, chế độ này ghi được vào code thật. Gemini tạm không có chế độ Chỉ hỏi vì chưa kiểm chứng được cờ chặn ghi.

### Tiếng Việt
- Đổi nhãn và thuật ngữ: Nhận/Bỏ, Cho phép lần này/Luôn cho phép/Từ chối, bản nháp, Chỉ hỏi, Thử với nhiều agent, Theo các bước, Chi phí.

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
