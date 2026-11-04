# 01 · Product spec — TG Studio

## 1. Tầm nhìn

TG Studio là IDE desktop (macOS, Windows) để **một người điều phối nhiều coding agent cùng lúc** — Claude Code, Codex, Gemini CLI, Kiro CLI — trên cùng một repo, nhìn rõ agent nào đang làm gì, tốn bao nhiêu, và **không có thay đổi nào vào code nếu người dùng chưa duyệt**.

Một câu: *"Bày trận cho các agent, mình làm chỉ huy."*

## 2. Người dùng

| Nhóm | Nhu cầu chính |
|---|---|
| Dev cá nhân dùng nhiều gói AI (Claude Max, ChatGPT plan, Gemini, Kiro) | Dùng hết giá trị các gói, so sánh agent nào làm tốt việc nào |
| Tech lead / team nhỏ | Giao việc song song cho nhiều agent, review tập trung, kiểm soát chi phí |
| Người "vibe code" | Một chỗ duy nhất để giao việc, xem tiến độ, duyệt và merge |

## 3. Nguyên tắc sản phẩm

1. **Cuộc trò chuyện là trung tâm, code nằm trong tầm tay.** Chat ở giữa; khi cần xem thì agent vẫn hiện *trong* editor (con trỏ, vạch màu, đoạn thay đổi). Xem `docs/superpowers/specs/2026-11-04-chat-first-design.md`.
2. **Người dùng là cổng cuối.** Mọi thay đổi đi qua merge queue; mỗi agent làm trong git worktree riêng.
3. **Số liệu trung thực.** Mọi con số usage có nhãn nguồn: *reported* (CLI tự báo), *estimated* (token × bảng giá), *parsed* (đọc từ output lệnh), *chưa có giá*.
4. **Không khóa vào một hãng.** Nói chuyện với agent qua chuẩn mở (ACP, MCP); agent mới chỉ là một adapter.
5. **Màu dành cho danh tính agent.** Khung giao diện trung tính; Claude cam đất, Codex xanh lá, Gemini xanh dương, Kiro tím.

## 4. Phạm vi bản 1.0

**Có:** chạy 1..n agent trên 1 repo · pipeline Plan → Build → Review · chạy song song + so sánh · duyệt quyền · diff/merge từng hunk · usage & ngân sách · registry MCP/skills · bản cài macOS/Windows có tự cập nhật.

**Không (để sau):** cộng tác nhiều người thời gian thực · chạy agent trên cloud · tự host model ngoài Ollama · marketplace plugin riêng · Linux (có thể build nhưng không hỗ trợ chính thức).

## 5. Màn hình & tính năng

Mockup: canvas "Multi-Agent Coding App" (xem `06-design-system.md`).

### 5.1 Editor + Agent panel (màn chính)

> Bố cục đã đổi theo thiết kế chat-first: chat ở giữa, dự án và cuộc trò chuyện bên trái, các chức năng dưới đây nằm ở panel phải.

| Tính năng | Xong khi |
|---|---|
| Cây thư mục có chấm màu agent đã sửa file | File bị agent sửa hiện chấm màu đúng agent + trạng thái M/A/D |
| Editor (Monaco) với vạch màu theo agent ở dòng được thêm/sửa | Mở file đang bị sửa thấy vạch màu và số dòng thay đổi |
| Con trỏ có tên agent tại dòng đang sửa | Khi agent ghi file, con trỏ cập nhật trong ≤ 1s |
| Thanh hunk Accept ⌘↵ / Reject ⌘⌫ ngay trong editor | Accept đưa hunk vào nhánh làm việc; Reject bỏ hunk khỏi worktree |
| Terminal tách tab theo agent | Mỗi lượt chạy có 1 tab log, cuộn mượt với 10.000 dòng |
| Panel agent: Thread / Plan / Runs | Xem hội thoại, checklist plan có gán agent, lịch sử lượt chạy |
| Khung "Usage · this task" | Mỗi agent 1 dòng: in/cache/out, ctx %, chi phí, nhãn nguồn |
| Thẻ xin duyệt (Deny / Always allow / Allow once) | Agent dừng chờ; quyết định áp dụng ngay; "Always" lưu vào policy |
| Composer: chọn agent, chế độ Single/Parallel/Pipeline, đính kèm file/đoạn code | ⌘↵ gửi; @mention đổi agent nhận |
| Status bar | Số agent chạy, số đang chờ duyệt, chi phí hôm nay / ngân sách |

### 5.2 Mission control

| Tính năng | Xong khi |
|---|---|
| Timeline (Gantt) theo agent | Thấy khoảng thời gian từng bước, đoạn chờ duyệt tô riêng |
| Cột theo từng agent: context, token, cost, việc đang làm, log trực tiếp, file đã chạm | Cập nhật realtime, không giật khi 4 agent chạy cùng lúc |
| Hành động: Message, Pause, Approve, Assign | Mỗi nút có tác dụng thật với tiến trình agent |
| Merge queue | Liệt kê nhóm thay đổi theo agent, trạng thái test; "Review all" mở diff tổng |

### 5.3 So sánh kết quả (chạy song song)

| Tính năng | Xong khi |
|---|---|
| Cùng prompt → N agent, N worktree | Các worktree độc lập, không ghi đè nhau |
| Thẻ so sánh: test pass, số dòng, thời gian, chi phí, diff chính, nhận xét reviewer | Bấm "Use this" merge kết quả đó |
| Cherry-pick từng hunk từ nhiều kết quả | Tạo được bản ghép, chạy lại test |
| Re-run with feedback | Gửi nhận xét vào lượt chạy mới, giữ lịch sử |

### 5.4 Usage & chi phí

| Tính năng | Xong khi |
|---|---|
| KPI: chi phí, token, % cache, số phiên, % ngân sách | Lọc Hôm nay / 7 ngày / 30 ngày |
| Biểu đồ chi phí theo agent theo ngày | Số khớp với tổng bảng phiên |
| Quota gói subscription có nhãn nguồn và thời điểm cập nhật | Không hiện số nếu không có nguồn tin cậy |
| Bảng phiên: task, agent, in/cache/out, cost | Export CSV |
| Ngân sách + cảnh báo + tự dừng | Vượt ngưỡng: cảnh báo; vượt trần: dừng lượt chạy |

### 5.5 Integrations

| Tính năng | Xong khi |
|---|---|
| Thẻ agent: phiên bản, giao thức (ACP/headless), cách đăng nhập, nguồn usage, trạng thái | Dò lại được; hướng dẫn cài nếu thiếu |
| Ma trận MCP server × agent (bật/tắt) | Bật 1 lần, mọi agent được chọn nhận server |
| Skills (SKILL.md) đồng bộ sang agent hỗ trợ | Hiện rõ agent nào hỗ trợ, agent nào không |
| Pipeline editor + quyền theo bước | Lưu pipeline mặc định cho task mới |

### 5.6 Onboarding lần đầu

Dò CLI → cài cái thiếu → đăng nhập từng agent (mở luồng login của chính CLI) → chọn repo → chạy task mẫu chỉ-đọc.

## 6. Yêu cầu phi chức năng

| Mục | Mục tiêu |
|---|---|
| Khởi động | < 2s tới màn chính (đã cài) |
| Bộ nhớ | < 400 MB khi 4 agent chạy (không tính tiến trình agent) |
| An toàn | Key trong Keychain/Credential Manager; agent chỉ ghi trong worktree; không gửi dữ liệu ra ngoài ngoài các CLI người dùng đã cài |
| Telemetry | Mặc định tắt; opt-in |
| Ngôn ngữ UI | Tiếng Anh cho nhãn kỹ thuật, tiếng Việt cho hướng dẫn (i18n sẵn sàng) |
| Trợ năng | Điều hướng bàn phím đầy đủ, tương phản ≥ 4.5:1 |

## 7. Thuật ngữ

| Từ | Nghĩa |
|---|---|
| Task | Một yêu cầu của người dùng, có thể gồm nhiều lượt chạy |
| Run (lượt chạy) | Một tiến trình agent xử lý một phần việc |
| Pipeline | Chuỗi bước (Plan → Build → Review), mỗi bước gán agent và quyền |
| Worktree | Bản checkout git riêng cho mỗi run |
| Merge queue | Danh sách thay đổi chờ người dùng duyệt |
| ACP | Agent Client Protocol — chuẩn để app điều khiển agent |
| MCP | Model Context Protocol — chuẩn để agent dùng tool bên ngoài |
