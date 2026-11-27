# Mockup đợt 3 (2026-11-27)

Nguồn của canvas "TG Studio Mockups" mà chủ repo đã duyệt. Mỗi tệp `.dc.html` là một khung; HTML với style inline, đọc trực tiếp để lấy bố cục, khoảng cách, màu, chữ. `{{ … }}`, `<sc-for>` là cú pháp của công cụ vẽ: dữ liệu nằm trong `renderVals()` cuối tệp.

| Tệp | Khung | Mục trong spec |
|---|---|---|
| `Main.dc.html` | 1 · Cuộc trò chuyện đang chạy (ô chat đã là phương án A) | 5.1, 5.2 |
| `Popup.dc.html` | 2 · Cửa sổ lớn xem agent con | 5.4 |
| `Context.dc.html` | 3 · Bảng context | 5.3 |
| `Agents.dc.html` | 4 · Bảng agent | 5.5 |
| `Composer.dc.html` | 5 · Ô chat: ba phương án; **chủ repo chọn A** (cột trái, ba trạng thái) | 5.2 |
| `Inline.dc.html` | 6 · Agent con chạy ngay trong chat (chủ repo đã chọn) | 5.4 |

Ảnh mèo và logo agent trỏ về `public/mascot/` và `public/agents/`. Màu trong mockup là giá trị của biến CSS trong `src/styles.scss` (`#0b0b0d` = `--bg`, `#a3c0ff` = `--run`, `#e8b672` = `--wait`, `#7fddb4` = `--done`, `#f6a999` = `--fail`); cam của mèo `#ff8a3d` là biến mới.
