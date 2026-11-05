# TG Studio — Làm lại giao diện theo hướng T3 Code

- **Ngày:** 2026-11-05
- **Trạng thái:** chủ repo đã duyệt mockup (canvas "TG Studio — UI mới": luồng 7 bước + ô chat chi tiết) và yêu cầu làm hết.
- **Tham chiếu:** [T3 Code](https://github.com/pingdotgg/t3code) (README và tài liệu người dùng; trang t3.codes không truy cập được từ môi trường làm việc).

## Vấn đề (từ ảnh chụp bản Windows của chủ repo)
1. Thanh tiêu đề của Windows chồng lên header của app.
2. Cột trái: trạng thái chỉ là chữ nhỏ, không biết cuộc trò chuyện của agent nào.
3. Chat hiện log thô (`hook_progress`, `init`, `thinking_tokens`, đường dẫn `claude.cmd`, `✓ success`), Markdown không được render.
4. Thanh màn hình dưới cùng bên trái chỉ có chữ.
5. Ô chat là hai `select`; "Chỉ hỏi / Sửa code / Nhiều agent" trộn quyền với số agent; chưa chọn được model.

## Quyết định
| Chủ đề | Quyết định |
|---|---|
| Nhận diện agent | Logo thật (LobeHub Icons, MIT) trên ô nền trung tính, `public/agents/*.svg` |
| Trạng thái | Nhãn tròn có màu, dùng chung ở cột trái, đầu lượt chat và danh sách agent: Đang làm (xanh dương, vòng xoay), Chờ duyệt (vàng đậm), Xong (xanh lá), Lỗi (đỏ), Đã dừng (xám) |
| Quy tắc màu | Đổi từ "màu chỉ cho agent" thành "logo cho agent, màu cho trạng thái" |
| Thanh tiêu đề | Của app: dự án / nhánh / tên cuộc trò chuyện, chi phí, nút panel phải, nút cửa sổ (Windows/Linux) |
| Chat | Tin người dùng là bong bóng bên phải; câu trả lời là Markdown; công cụ giữa hai tin nhắn gom thành Nhật ký làm việc (mở khi đang làm, thu gọn khi xong); thẻ thay đổi liệt kê tệp; thẻ duyệt ghim trên ô chat |
| Ô chat | Chip agent (agent trái, model + mức suy nghĩ phải, cuối menu: Giao cho nhiều agent, Theo các bước) và chip quyền (Chỉ hỏi / Sửa code, có chú thích). Nút gửi/dừng tròn |
| Màn trống | Chưa có dự án: màn chào + Mở thư mục + danh sách agent. Có dự án: "Hôm nay làm gì với …?", ô chat lớn, gợi ý |
| Chọn model | Đọc `configOptions` của ACP (category `model`, `thought_level`), không viết cứng; nhớ theo agent |

## Không làm trong đợt này
Bảng lệnh Ctrl+K, terminal thật, đính kèm tệp, theme sáng, chạy cùng một agent hai lần với hai model.

## Kiểm chứng
- Adapter Claude thật (`claude-agent-acp` 0.100.0): `session/new` trả `configOptions` có `model` (default, Opus 4.6, Sonnet 4.6, …) và `effort` (default, low … max). Đọc không tốn token (`live_claude_config_options`).
- `claude -p --model claude-sonnet-4-6 --effort low` chạy đúng model.
- Codex chưa kiểm chứng trên máy dev (chưa cài `codex`); cách đọc model dùng chung chuẩn ACP, cờ headless là `-m` và `-c model_reasoning_effort=…`.
