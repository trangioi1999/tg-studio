# Đề xuất UI/UX của Codex (2026-11-28)

Codex đọc repo rồi đề xuất; bản mẫu index.html đã lấy: trục thời gian chung cho các làn, bấm làn mở nhật ký, stream theo cụm từ, mức chuyển động, Theo hệ thống.

**1. Ý tưởng chủ đạo**

**“Một studio yên tĩnh, nơi bạn trò chuyện với agent chính và luôn nhìn thấy đội agent phía sau đang làm gì.”**

Thị giác: nền trung tính hơi ấm, chữ dễ đọc, đường phân cách nhẹ, bo góc vừa phải; mèo cam tạo sự gần gũi. Giữ logo để nhận diện Claude/Codex/Gemini/Kiro, màu để biểu đạt trạng thái như code hiện tại. Chat dùng chữ 15–16px; monospace chỉ dành cho lệnh, log và số liệu.

**2. Bố cục**

- **Cột trái — 220px:** tạo cuộc trò chuyện, tìm kiếm, “Cần bạn”, dự án → cuộc trò chuyện. Nhóm “Đang chạy” chỉ hiện tóm tắt, tránh lặp toàn bộ cây agent.
- **Chat — vùng chính:** yêu cầu, trao đổi, quyết định và kết quả. Tool có bản tóm tắt mở rộng được. Composer cố định; quyền, model và context nằm trong một hàng.
- **Khu quan sát — dưới chat, kéo đổi chiều cao:** cây agent và timeline dùng **chung từng hàng**, mỗi phiên agent một làn; không gom mọi Claude vào một làn. Tự mở khi có agent con đầu tiên.
- **Panel phải — mở theo lựa chọn:** xem agent, log, tệp hoặc diff. Chọn một làn mở chi tiết agent đó; có nút ghim để panel không tự đổi khi event mới đến.

```text
┌───────────────────────────────────────────────────────────────────────┐
│ TG Studio / tg-studio / Sửa đăng nhập       3 chạy · 1 cần bạn    EN/VI │
├──────────────┬───────────────────────────────────┬────────────────────┤
│ + Chat mới   │ CUỘC TRÒ CHUYỆN                   │ CHI TIẾT           │
│ Tìm kiếm     │ Bạn: Sửa luồng đăng nhập…         │ Claude · Kiểm thử  │
│ Cần bạn (1)  │ Claude: Tôi chia thành 2 việc…    │ Cha: Điều phối    │
│              │                                   │                    │
│ tg-studio    │ Đã sửa 3 tệp · Xem thay đổi       │ Log | Diff | Việc  │
│  • Đăng nhập │                                   │ $ npm test         │
│  • Settings  ├───────────────────────────────────┤ Đang chạy…         │
│              │ QUAN SÁT     Trực tiếp · Phóng to │                    │
│ Dự án khác   │ Cây agent       0s    20s    40s   │ Tệp đã chạm        │
│              │ Claude · Cha    [đọc][đợi con──]  │ auth.spec.ts       │
│              │ ├─ Khảo sát     [đọc──][xong]     │                    │
│              │ └─ Kiểm thử        [lệnh][duyệt?] │ Lệnh cần duyệt     │
│              ├───────────────────────────────────┤ [Từ chối] [Duyệt] │
│ Chi phí      │ 🐈  Nhập yêu cầu tiếp theo…       │                    │
│ Cài đặt      │ + Claude ▾ Hỏi trước ▾ 42%   [↑] │                    │
└──────────────┴───────────────────────────────────┴────────────────────┘
```

Mỗi hàng hiện **vai trò, việc hiện tại, trạng thái, thời gian và thời điểm nhận event gần nhất**. Timeline chung trục thời gian, phân biệt đọc/sửa/chạy lệnh/chờ duyệt bằng nhãn và ký hiệu. Bấm một đoạn để xem đúng log tương ứng.

Giữ thứ tự cây ổn định; agent xong vẫn ở đó để đối chiếu. Bộ lọc “Cần bạn” đưa đến điểm nghẽn. Phân biệt subagent nội bộ với agent được giao qua TG bằng nhãn nguồn; chỉ hiện thao tác nhắn/dừng khi backend hỗ trợ. Không có event thì ghi “Chưa có cập nhật”, không suy diễn đang làm gì.

Ở cửa sổ hẹp, panel phải chuyển thành chế độ xem chi tiết có nút quay lại; chat và khu quan sát vẫn là hai vùng ưu tiên.

**3. Học từ các app tham khảo**

| App | Áp dụng vào TG Studio |
|---|---|
| **Claude Desktop** | Giữ hội thoại dễ đọc; tách sản phẩm đầu ra sang vùng riêng. Áp dụng cho kế hoạch và diff để chat không thành một chuỗi bảng lớn. [Tham khảo](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them) |
| **Google Antigravity** | Học cách điều phối theo nhiệm vụ và workspace. “Bảng agent” toàn cục giúp chuyển giữa các việc; cây trong chat cho biết cấu trúc bên trong từng việc. [Tham khảo](https://antigravity.google/docs/overview) |
| **Codex app** | Học luồng chạy song song → xem thay đổi → tiếp tục chỉ đạo; đặt nhánh/worktree và diff gần nhiệm vụ tương ứng. [Tham khảo](https://openai.com/index/introducing-the-codex-app/) |
| **Laravel Herd** | Học danh sách gọn, nhóm yêu thích và inspector bên phải: chọn đối tượng rồi xem chi tiết tại chỗ. [Tham khảo](https://herd.laravel.com/docs/macos/sites/managing-sites) |
| **T3 Code** | Học một bề mặt điều khiển thống nhất cho nhiều CLI; thao tác chat nhất quán nhưng vẫn chỉ rõ agent nào đang nhận việc. [Tham khảo](https://t3.codes/) |

**4. Hệ thống theme**

Giữ CSS variables trong `styles.scss`, mở rộng thành token theo ý nghĩa. Bảng màu khởi điểm:

| Token | Sáng | Tối |
|---|---|---|
| `--bg` | `#F7F6F2` | `#141516` |
| `--panel` | `#FFFFFF` | `#1C1D1F` |
| `--raised` | `#EEEDE8` | `#26282B` |
| `--text` | `#232522` | `#EEEDE8` |
| `--muted` | `#62665F` | `#A4A8A1` |
| `--line` | `#D9DCD4` | `#383C36` |
| `--accent` | `#A94B20` | `#F2A16C` |
| `--run` | `#285CC4` | `#9DBBFF` |
| `--wait` | `#875800` | `#E8BB70` |
| `--done` | `#216947` | `#85D4AA` |
| `--fail` | `#B33438` | `#F3A0A3` |

Mỗi trạng thái có thêm token nền nhạt/viền; luôn kèm chữ hoặc icon. Màu lông mèo tách khỏi accent.

Cài đặt gồm **Theo hệ thống / Sáng / Tối**. Sau này cho chọn accent, độ ấm nền, mật độ và font; xem trước trực tiếp, khôi phục mặc định, nhập/xuất theme JSON. Kiểm tra tương phản trước khi lưu, đồng bộ cả editor và terminal.

**5. Animation và mèo**

| Khoảnh khắc | Chuyển động UI và mèo |
|---|---|
| Gửi prompt | Tin nhắn xuất hiện nhẹ trong 180ms; mèo ngẩng đầu, chạm nút gửi. |
| Đang chờ token đầu | Dòng “Đang chờ phản hồi”; mèo nhìn về vùng chat, đuôi chuyển động chậm. |
| Token đầu | Trạng thái chuyển mềm sang “Đang trả lời”; chữ stream tự nhiên, không hiệu ứng từng ký tự. |
| Tool chạy | Đọc tệp: mèo xem giấy; ghi code: gõ bàn phím; chạy lệnh: chạy tại chỗ. |
| Chờ duyệt | Mèo dừng, giơ chân một lần; thẻ duyệt hiện rõ tên agent và thao tác. |
| Agent con sinh ra | Nhánh và làn mới mở trong 200ms; mèo đẩy một tờ giao việc. |
| Agent con kết thúc | Đoạn timeline đóng, hiện dấu ✓ và kết quả; mèo gật đầu. Không tự thu nội dung đang đọc. |
| Xong lượt | Mèo vươn vai hoặc đập tay một lần, rồi ngồi yên; còn con chạy thì vẫn ghi rõ. |
| Lỗi | Mèo nghiêng đầu, tai cụp nhẹ; hiện lỗi và hành động khắc phục, không rung toàn màn hình. |

Chỉ **một mèo chính chuyển động**; các làn dùng logo và trạng thái tĩnh. Animation phải theo event thật, không giả phần trăm tiến độ. Không tự kéo người dùng về cuối khi họ đang đọc log cũ. Có mức **Đầy đủ / Nhẹ / Tắt**, tôn trọng `prefers-reduced-motion`.

**6. Song ngữ**

Chọn **Tiếng Việt / English / Theo hệ thống**, đổi ngay trong phiên. Mỗi lần hiển thị một ngôn ngữ nhất quán.

Tách toàn bộ nhãn, tooltip, thông báo và trợ năng thành khóa dịch; lỗi backend dùng mã lỗi + tham số để UI dịch. Giữ nguyên tên tool, lệnh, đường dẫn và log gốc. Ngôn ngữ phản hồi của agent là lựa chọn riêng. Chuẩn hóa thuật ngữ như “Agent con / Subagent”, “Chờ duyệt / Awaiting approval”; định dạng số và ngày theo locale.

**7. Năm thay đổi mạnh nhất so với hiện tại**

1. **Thay kiểu chỉ mở một terminal con trong tin nhắn bằng cây + các làn luôn quan sát được**, cho phép ghim nhiều agent để so sánh.
2. **Bỏ cửa sổ phủ làm đường xem agent mặc định**; dùng inspector bên phải để vẫn thấy cha, các con và hội thoại.
3. **Đổi bảng thẻ agent có mèo trên từng thẻ thành danh sách phân cấp theo nhiệm vụ**, ưu tiên việc cần quyết định; lưới thẻ là lựa chọn phụ.
4. **Giảm thông tin chen trong composer và chat**: bước chi tiết vào khu quan sát; token, chi phí, context có tóm tắt và mở rộng đúng chỗ.
5. **Thay nền tối cố định và chuỗi Việt hardcode bằng hệ theme/i18n thống nhất**; nâng mèo từ tư thế chung “coding/thinking” thành phản hồi theo hành động thật.
