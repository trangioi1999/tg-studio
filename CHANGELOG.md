# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/); phiên bản theo SemVer. Phiên bản nằm ở `package.json`, đồng bộ sang Rust bằng `npm run version:sync`.

## [Chưa phát hành]

### Sửa lỗi
- Kiro: thanh dưới không đọc được credit của gói khi Kiro phải chờ MCP server (lệnh `/usage` mất hơn 25 giây); giờ chờ tới 2 phút, và Kiro bản cũ từ chối cờ `--v2` thì app chạy lại không có cờ. Không đọc được thì tooltip ghi đúng lý do và những gì Kiro in ra, thay cho câu "cần đăng nhập". Claude và Kiro hiện số riêng, không chờ nhau.
- Kiro: thông báo riêng đầu tiên của mỗi loại mà Kiro gửi (`_kiro.dev/…`) được ghi vào tab Log (dòng mờ), để tìm ra cách Kiro bản đang dùng báo credit.

## [0.6.8] - 2026-11-13

### Thay đổi
- Tab Log ở khung dưới: một log cho cuộc trò chuyện đang mở, trình bày như khung chat. Mỗi lượt chạy là một khối có avatar, tên agent, giờ và trạng thái; tin bạn gửi là bong bóng bên phải; agent con và subagent lồng thụt vào ngay dưới agent đã giao. Thay hàng tab (6 lượt gần nhất của mọi cuộc trò chuyện, bấm vào là đổi cuộc trò chuyện) bằng chip lọc theo agent, nút Chỉ lỗi, ô tìm và nút Chép log.

### Thêm
- Kiro: đầu mỗi câu trả lời hiện credit của lượt (ví dụ `· 8s · 0,32 credit`), rê chuột xem tổng của cuộc trò chuyện và số USD ước tính.
- Kiro: thanh dưới hiện credit của gói như Kiro (`Kiro Pro+ 334,17 / 2.000`), rê chuột xem phần trăm và ngày reset; màn Chi phí có thêm dòng credit trong tháng và credit thưởng. App đọc từ lệnh `/usage` của `kiro-cli` (chạy trên máy, không tốn credit), tối đa 5 phút một lần hoặc khi bấm.

## [0.6.7] - 2026-11-13

### Sửa lỗi
- Bảo Claude "giao việc cho Kiro" không còn chuyển hẳn cuộc trò chuyện sang Kiro: Claude được hướng dẫn dùng giao việc (Kiro chạy như agent con, kết quả gộp về), chỉ đề xuất chuyển hẳn khi bạn muốn đổi agent. Thẻ đề xuất chuyển việc có nút chính **Để Claude giao cho Kiro**; **Chuyển hẳn sang Kiro** thành lựa chọn phụ.
- Kiro: ô `/` hiện skill của dự án (`.kiro/skills/`) và của máy (`~/.kiro/skills/`), kể cả khi Kiro không tự liệt kê; đọc thêm danh sách lệnh Kiro gửi qua thông báo riêng.
- Kiro: hiện chi phí. Kiro không báo token qua ACP, chỉ báo credit (`_kiro.dev/metadata`); app quy ra USD theo giá credit vượt gói (0,04 USD/credit).

### Thay đổi
- README, ảnh chụp giao diện và trang review (21 màn) cập nhật theo bản 0.6.6: đính kèm, terminal, thiết lập dự án, Push/Tạo PR.

### Sửa lỗi
- Thiết lập dự án: dòng "Kiểm tra hỏng thì gửi lỗi cho agent tự sửa" nằm cạnh ô đánh dấu thay vì rớt xuống dòng riêng.

## [0.6.6] - 2026-11-13

### Thêm
- Đính kèm ảnh và tệp vào tin nhắn: dán ảnh chụp màn hình (Ctrl+V), kéo thả, hoặc bấm nút kẹp giấy. Ảnh đi thẳng tới agent nhận ảnh (Claude, Codex…), tệp chữ nhỏ gửi kèm nội dung, tệp khác gửi đường dẫn. Ảnh và tệp hiện trong tin nhắn, kể cả khi mở lại cuộc trò chuyện.

## [0.6.5] - 2026-11-13

### Sửa lỗi
- Windows: Sửa code với Claude không còn báo "Lỗi RPC -32603: Internal error" khi adapter thiếu `claude.exe` riêng. App tự dùng Claude Code đã cài trên máy (`~/.local/bin/claude.exe` hoặc bản cài qua npm); nếu không thấy, lỗi ghi rõ cần cài Claude Code.

## [0.6.4] - 2026-11-13

### Thêm
- Tab Thay đổi có **Push** và **Tạo PR** (cần GitHub CLI), hiện nhánh và số commit chưa đẩy.
- Terminal cho từng cuộc trò chuyện ở khung dưới (tab Terminal), mở đúng thư mục agent đang làm.
- Thiết lập dự án (⚙ ở cột trái): script chuẩn bị chạy trong mỗi bản nháp mới trước khi agent bắt đầu, và lệnh kiểm tra chạy sau mỗi lượt agent có sửa tệp, hỏng thì gửi lỗi cho agent tự sửa.

### Bỏ
- Duyệt từng đoạn (nút giữ/bỏ đoạn trong editor). Giữ hay bỏ thay đổi theo tệp ở tab Thay đổi; editor chỉ còn vạch màu của agent.

## [0.6.3] - 2026-11-13

### Sửa lỗi
- Commit hoặc hoàn tác không còn lấy nhầm phần agent đang ghi dở: kiểm tra và thao tác chạy trong cùng một khoá thư mục; agent chỉ bắt đầu lượt mới sau khi commit đang chạy xong.
- Bản nháp đang có agent làm vẫn commit được phần đã áp vào thư mục.
- Áp bản nháp, commit tệp đã áp và áp/commit bản ghép bị chặn khi có agent đang ghi trong thư mục của bạn; hai bản nháp áp cùng lúc không còn tranh index; áp lần hai không làm mất tệp của lần đầu khỏi commit.

### Thay đổi
- Sắp xếp lại giao diện theo tính năng, service, bố cục và `shared/ui`, `shared/utils`.

## [0.6.2] - 2026-11-10

### Thay đổi
- Gợi ý ở menu "Làm ở đâu" và cảnh báo Tự động ghi đúng cách hoàn tác mới: theo tệp ở tab Thay đổi.
- README, tài liệu kiến trúc và toàn bộ ảnh chụp giao diện cập nhật theo bản hiện tại; trang review giao diện thêm màn tab Thay đổi và agent con.

## [0.6.1] - 2026-11-09

### Sửa lỗi
- Khi một agent con làm thẳng trên thư mục chạy xong, cuộc trò chuyện cha và mọi cuộc trò chuyện khác của repo mất thông tin nơi làm việc (tab Thay đổi, commit, đọc tệp hỏng). Lỗi có từ 0.6.0.
- Bấm vào một cuộc trò chuyện không còn chọn nhầm agent con (Codex) thay cho agent bạn đang chat.
- Lượt chạy lỗi, bị từ chối hoặc bị dừng không còn hiện là "Xong".
- Editor không còn ghi đè chữ bạn vừa gõ khi tải lại tệp.
- Mở tab Thay đổi không còn báo lỗi `index.lock`; giữ/bỏ đoạn sửa, hoàn tác, commit và lưu tệp bị chặn khi có agent đang ghi vào cùng thư mục.
- Bản nháp đã "Áp vào thư mục" vẫn commit được sau khi đóng rồi mở lại tab Thay đổi.
- Ngân sách dừng mọi lượt vượt mức của một phiên, không chỉ lượt đầu; lần dừng thất bại được thử lại.
- Chọn agent hay quyền trong ô chat không còn bị đặt lại khi agent đang chạy.
- CLI treo khi dò phiên bản bị dừng sau 8 giây, không còn chạy ngầm.
- Lỗi khi tải lại tệp hay thay đổi không còn hiện thành "không có thay đổi"; kết quả cũ, chậm hơn không đè lên kết quả mới.
- Nút chép trong tin nhắn không còn báo "Đã chép" khi clipboard từ chối.

### Thay đổi
- Sắp xếp lại mã nguồn theo tính năng (giao diện và lõi Rust), chia các màn lớn thành component nhỏ, bỏ mã không còn dùng. Claude và Codex cùng review trước khi làm.

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
