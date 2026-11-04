# Hướng dẫn sử dụng TG Studio

TG Studio điều phối các agent lập trình (Claude Code, Codex, Gemini CLI, Kiro CLI) đã cài trên máy bạn: giao việc, duyệt lệnh, xem và chấp nhận từng thay đổi, so sánh nhiều agent, theo dõi chi phí. App không tự gọi API của hãng nào; mỗi agent chạy bằng tài khoản mà CLI của nó đang đăng nhập.

## 1. Cài đặt

**Windows:** chạy `TG-Studio_x.y.z_x64-setup.exe`. Bản chưa ký số sẽ hiện cảnh báo SmartScreen: bấm *More info* → *Run anyway*. Windows 10 cần WebView2; nếu máy chưa có, bộ cài tự tải.

**macOS:** mở tệp `.dmg`, kéo TG Studio vào Applications. Bản chưa ký số: lần đầu chuột phải vào app → *Open*.

**Cần thêm:**
- Ít nhất một agent CLI, ví dụ `npm i -g @anthropic-ai/claude-code`.
- Git, nếu muốn dùng chế độ Sửa code.
- Node.js (có `npx`), để lần đầu chạy Sửa code app tải adapter ACP của Claude/Codex.

## 2. Lần đầu mở app

Hướng dẫn 4 bước hiện ra: dò agent → đăng nhập (chạy lệnh đăng nhập của từng CLI trong terminal, ví dụ `claude`) → chọn thư mục dự án → chạy thử một câu hỏi chỉ đọc. Mở lại bất cứ lúc nào bằng nút **Hướng dẫn** ở cột Agents.

## 3. Màn chính

| Vùng | Nội dung |
|---|---|
| Thanh trên | Tên dự án và nhánh (bấm để gõ đường dẫn), nút **Mở thư mục**, nút **Tệp & thay đổi**, trạng thái từng agent đang chạy |
| Cột trái | Các dự án và cuộc trò chuyện của chúng, mở nhiều dự án cùng lúc. Bên dưới là Giám sát, Chi phí, Agent, Kết nối |
| Giữa | Cuộc trò chuyện và ô chat. Thẻ duyệt luôn ghim ngay trên ô chat |
| Bên phải | **Tệp & thay đổi**: cây tệp của dự án hoặc bản nháp, editor, review, So sánh. Tự mở một lần khi có thay đổi đầu tiên |
| Thanh dưới | Số agent đang chạy, **hạn mức 5 giờ và 7 ngày** của từng agent, chi phí hôm nay |

Số hạn mức do CLI báo: Codex đọc từ log phiên của nó, Claude có số sau lượt chạy đầu. Rê chuột để xem giờ reset và số cập nhật lúc nào.

Tệp mở từ **Dự án** chỉ đọc; muốn sửa thì giao cho agent. Tệp trong **Bản nháp** sửa được.

Phím tắt hiện cạnh nút: trên Windows là Ctrl, trên macOS là ⌘.

## 4. Chat với agent

Gõ yêu cầu rồi Enter; Shift+Enter để xuống dòng. **Gõ tiếp là chat tiếp với cùng agent**, không tạo agent mới. **Dừng** chỉ dừng câu đang chạy. **Trò chuyện mới** để bắt đầu việc khác.

Gõ `@codex ...` hoặc đổi agent để giao tiếp: agent mới làm trên cùng bản nháp và nhận tóm tắt.

| Chế độ | Khi nào dùng |
|---|---|
| **Sửa code** | Agent làm trong một bản nháp riêng. Code thật chỉ đổi khi bạn Nhận |
| **Chỉ hỏi** | Hỏi đáp, giải thích code. Agent không ghi được tệp nào |
| **Thử với nhiều agent** | Cùng một yêu cầu cho nhiều agent, mỗi agent một bản nháp, rồi so sánh |
| **Theo các bước** | Các bước nối tiếp trong cùng một bản nháp, mặc định Plan → Build → Review; chọn agent cho từng bước, sửa mẫu prompt bằng **Sửa mẫu** |

Sửa code cần thư mục là repo Git có ít nhất một commit; nếu chưa có, app có nút **Khởi tạo Git** hoặc **Tạo commit đầu tiên**, xem trước rồi mới làm. Tệp chưa commit không có trong bản nháp, app sẽ cảnh báo trước.

## 5. Duyệt lệnh

Khi agent muốn chạy lệnh hoặc sửa tệp, thẻ **Cần bạn duyệt** hiện ra:
- **Cho phép lần này**.
- **Luôn cho phép `npm test *`**: lưu quy tắc cho repo + agent này; lệnh ghép (`;`, `&&`, `|`…) không bao giờ được tự cho phép.
- **Từ chối**.

Phiên do app mở luôn xin duyệt, kể cả khi Claude Code trên máy đặt chế độ tự duyệt.

`git push`, merge và `gh pr merge` luôn bị từ chối. Mục **Giám sát** ở cột trái có số thẻ đang chờ.

## 6. Review và commit

- Trong editor, dưới mỗi thay đổi có thanh **Nhận / Bỏ** (Ctrl+Enter / Ctrl+Backspace khi con trỏ ở trong thay đổi).
- Tab **Thay đổi** liệt kê mọi đoạn thay đổi; Nhận áp vào code thật, Bỏ xoá nó khỏi bản nháp.
- Sửa tay trong editor rồi **Lưu** (Ctrl+S): chỉ ghi vào worktree, nên chính sửa đổi của bạn cũng vào hàng chờ duyệt. Không lưu được khi agent đang chạy.
- Khi đã Nhận, ô **Commit** hiện ra và liệt kê mọi tệp đang staged với nội dung do agent đề xuất; sửa rồi Commit.
- **Bỏ worktree** khi không cần nữa.

## 7. Song song: so sánh và ghép

- Tab **So sánh**: mỗi agent một thẻ (tệp, dòng, token, chi phí, thời gian). **Dùng bản này** áp nguyên một bản (tất cả hoặc không gì), rồi Commit và **Dọn worktree của nhóm**.
- **Ghép thủ công**: chọn từng thay đổi từ các bản khác nhau → **Tạo bản ghép** → nhập lệnh kiểm tra (ví dụ `npm test`) → **Chạy kiểm tra** → **Dùng bản ghép**. Hai thay đổi trùng chỗ sửa không ghép được.

## 8. Giám sát

KPI, **hàng chờ của bạn** (duyệt lệnh → review → commit), timeline các lượt chạy (đoạn sọc vàng là thời gian chờ bạn duyệt) và một cột cho mỗi agent.

## 9. Usage, chi phí, ngân sách

- Màn **Usage**: chi phí và token theo ngày theo agent, bảng mọi lượt chạy, **Xuất CSV** (lưu vào Downloads).
- **reported**: chi phí do CLI tự báo (Claude Code). **estimated**: token × bảng giá bạn nhập. **chưa có giá**: chỉ có token.
- **Bảng giá** (USD / 1 triệu token): giá mới áp dụng từ lúc bấm, lượt cũ giữ giá cũ. Đánh dấu *Áp dụng cho cả các lượt trước* để định giá dữ liệu cũ chưa có giá.
- **Ngân sách**: mỗi task và mỗi ngày. Vượt mức task thì run đó dừng; chạm mức ngày thì mọi run dừng và không giao việc mới được. Nhiều agent chỉ báo chi phí khi xong, nên việc dừng chỉ xảy ra khi đã có số.
- **Hạn mức gói** Claude Pro/Max (5 giờ, 7 ngày): cập nhật sau mỗi lượt Claude ở chế độ Chỉ đọc. Với gói Pro/Max, "chi phí" chỉ là giá API quy đổi; phần bị trừ thật là hạn mức gói.

## 10. Integrations: MCP và Skills

- **MCP servers**: thêm server (stdio: lệnh + tham số + biến môi trường; http: URL + header), tick agent nào được dùng. App đưa server vào từng phiên của agent, không sửa tệp cấu hình của agent. Server http chỉ gửi cho agent báo hỗ trợ. Biến môi trường và header lưu trong máy, không mã hóa.
- **Skills**: thư viện `SKILL.md`. Cài vào Claude Code ở mức repo (`.claude/skills`) hoặc mức máy (`~/.claude/skills`); bản khác sẵn có được sao lưu trước khi ghi.

## 11. tg-bridge: các agent phối hợp

Mỗi task Sửa code nhận thêm một MCP server `tg-bridge` do TG Studio cung cấp. Agent dùng nó để:
- **báo tiến độ**: hiện thành thanh tiến độ ở cuộc trò chuyện và cột agent trong Giám sát;
- **ghi chú chung**: agent cùng task (nhóm song song, các bước pipeline) đọc được; xem ở tab **Plan**;
- **đề xuất chuyển việc** cho agent khác: hiện thẻ ở cuộc trò chuyện và dòng *Chuyển việc* trong hàng chờ. Bấm **Giao cho …** thì agent kia mới chạy (làm tiếp trong cùng worktree nếu task trước đã xong);
- **xin duyệt** việc ngoài phạm vi: hiện thẻ duyệt như lệnh thường.

tg-bridge chỉ nghe trên máy bạn (127.0.0.1), mỗi task một token. Tắt ở màn **Integrations** nếu không cần.

## 12. Dữ liệu và quyền riêng tư

- Lịch sử, giá, ngân sách, MCP nằm trong `tg-studio.db` ở thư mục dữ liệu của app. Thư viện skill ở `skills/` cạnh đó.
- Worktree của task nằm trong `<repo>/.tg/worktrees/` (đã thêm vào `.git/info/exclude`).
- App không gửi dữ liệu đi đâu ngoài chính các CLI bạn đã cài.

## 13. Báo lỗi

Bấm **Chẩn đoán** ở thanh trạng thái: app lưu một tệp JSON vào Downloads (phiên bản, hệ điều hành, agent đã dò, các lượt chạy gần đây, lỗi gần đây; không có khóa hay mật khẩu). Xem lại nội dung rồi gửi kèm khi báo lỗi.

## 14. Sự cố thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| Nút Chạy xám | Đọc dòng gợi ý dưới ô giao việc: thiếu yêu cầu, thiếu agent, thư mục không phải repo Git, hoặc đã chạm ngân sách ngày |
| Agent "chưa cài" dù đã cài | Mở lại app sau khi cài; bấm **Dò lại**. App lấy PATH từ login shell, nên CLI cài qua nvm/Homebrew vẫn thấy được |
| Sửa code báo không tìm thấy adapter | Cần `npx` (Node.js) để tải `claude-agent-acp` / `codex-acp` lần đầu |
| Kiro không chạy | Đăng nhập Kiro trong terminal trước (`kiro-cli login`) |
| Chi phí hiện "—" | Agent không tự báo chi phí: nhập bảng giá ở màn Usage |
