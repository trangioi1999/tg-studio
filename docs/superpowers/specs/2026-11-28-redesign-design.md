# Thiết kế lại giao diện TG Studio (2026-11-28)

Bản mẫu đã chốt: `docs/mockups/2026-11-28-redesign/index.html`. Chạy bằng `python3 -m http.server 4320` ở gốc repo, mở `/docs/mockups/2026-11-28-redesign/index.html`. Mèo động: `docs/mockups/2026-11-28-redesign/pet/`. Đề xuất của Codex: `codex-proposal.md` cùng thư mục.

## 1. Vì sao

Chủ repo dùng Claude CLI hằng ngày nhưng không quan sát được subagent và agent con đang làm gì. TG Studio là client riêng của họ: lõi vẫn là các CLI (Claude Code, Codex, Gemini, Kiro), giao diện là của TG Studio. Bản thiết kế này làm ba việc:

1. Cho thấy mọi agent của một cuộc trò chuyện cùng lúc, mỗi agent một làn trên một trục thời gian chung.
2. Làm giao diện gọn: các nút điều khiển gom về Cài đặt, không rải ở bốn góc.
3. Thêm thứ để dùng lâu dài: theme sáng và tối, theme tuỳ chỉnh về sau, tiếng Anh và tiếng Việt, mèo động theo trạng thái thật của agent.

## 2. Mục tiêu, không làm, không được thành

**Mục tiêu**
- Làn agent: cha, agent con qua tg-bridge, subagent `<cha>~n`, tất cả trong một panel, cùng một trục thời gian.
- Bố cục theo bản mẫu: sidebar, thanh trên, panel phải có tab, ngăn Terminal/Log, Cài đặt gom mọi tuỳ chọn.
- Theme Kiln (tối) và Bisque (sáng), 4 màu nhấn, chế độ Theo hệ thống. Mọi màu đi qua token để sau này nạp theme riêng.
- Mèo động 8 trạng thái, 3 mức chuyển động.
- Song ngữ Anh/Việt cho toàn bộ chữ trên UI, kể cả lỗi từ lõi.

**Không làm trong đợt này**
- Trình sửa theme đầy đủ (nhập/xuất JSON, chỉnh từng token). Chỉ có bảng token chỉ đọc, chọn chế độ và màu nhấn.
- Dịch nội dung agent trả lời. Ngôn ngữ trả lời của agent là chuyện riêng của agent.
- Mèo dựng bằng khung xương (Rive/Lottie). Dùng sprite sheet của Codex.
- Đổi lõi Rust ngoài phần mã lỗi cho song ngữ và dữ liệu hạn mức đã có.

**Không được thành** (dù chạy đúng vẫn coi là hỏng)
- Một trạng thái hiện ở nhiều chỗ cùng lúc (lỗi đã sửa ở đợt unslop 2026-11-28).
- Animation không theo event thật: phần trăm giả, mèo "đang gõ" khi agent không gõ.
- Mất tính năng hiện có. Thay đổi kiểu git, cây tệp và editor, terminal, Bảng agent, cửa sổ lớn, bảng context, hạn mức, chi phí đều phải còn.

## 3. Ràng buộc

- Giữ ràng buộc của `CLAUDE.md` và `AGENTS.md`: Angular signals, CSS chỉ trong `src/styles.scss`, mọi lệnh gọi lõi đi qua `AgentBackend`, có `MockBackend`, CSP chặt (không tải gì từ mạng).
- Font giữ Inter và JetBrains Mono, đã đóng gói trong app.
- Ảnh mèo nằm trong `public/`, dạng WebP. Bộ hiện có (`docs/mockups/.../pet/*.webp`) cao 256 px, tổng 864 KB.
- Tôn trọng `prefers-reduced-motion`.

## 4. Các hướng đã cân nhắc

| Hướng | Được | Mất | Chọn |
|---|---|---|---|
| A. Làn agent ở cột phải, có tab Agent/Thay đổi/Tệp, ngăn Terminal/Log | Chat luôn rộng; giống Claude Desktop và Codex app; Codex cũng đề xuất | Panel phải dày đặc | **Chọn** (chủ repo duyệt bản mẫu) |
| B. Khu quan sát nằm dưới chat (sơ đồ đầu tiên của Codex) | Chat và làn cùng một trục dọc | Chat bị thấp đi, composer bị đẩy | Không |
| C. Giữ bố cục hiện tại, chỉ thêm làn vào cửa sổ lớn | Ít việc | Không giải quyết chuyện "không thấy subagent"; vẫn rải nút ở bốn góc | Không |

## 5. Thiết kế theo vùng (theo bản mẫu)

### 5.1 Khung
- Lưới: thanh trên 44 px; dưới là ba cột: sidebar (248 px), giữa, panel phải (340 px).
- **Bỏ `StatusBar`.** Mỗi thứ của nó chuyển chỗ:
  - phiên bản và cập nhật → Cài đặt › Giới thiệu
  - tài nguyên (`ResourceMeter`) → Cài đặt › Giới thiệu
  - hạn mức và chi phí → bảng context, và Cài đặt › Sử dụng
- **Thanh trên:** đường dẫn dự án, nhánh, tên cuộc trò chuyện; bên phải chỉ có nút `…` (thao tác cuộc trò chuyện) và nút ẩn/hiện panel. Theme và ngôn ngữ không nằm ở đây. macOS giữ traffic lights; Windows/Linux giữ nút cửa sổ như hiện tại.
- Ở màn Bảng agent và Cài đặt, panel phải ẩn và nút ẩn/hiện panel cũng ẩn.

### 5.2 Sidebar
- Từ trên xuống:
  - Trò chuyện mới (⌘N).
  - Tìm kiếm (⌘K, mở ô tìm cuộc trò chuyện và tệp).
  - Bảng agent, kèm số việc "Cần bạn" khi lớn hơn 0.
  - Dự án → cuộc trò chuyện, mỗi dòng có logo agent và chữ trạng thái.
- Dưới đáy chỉ có **Cài đặt**.
- Bỏ nhóm "Đang chạy" ở sidebar: Bảng agent và làn agent đã cho thấy agent đang chạy.
- Bỏ dải 3 icon Chat/Bảng agent/Giao diện.

### 5.3 Chat và composer
- Chat giữ dòng thao tác kiểu CLI, terminal nhỏ của agent con, dòng giao việc.
- Composer chỉ dùng icon, mỗi icon có tooltip:
  - `+` (tệp, lệnh, skill)
  - logo agent (tooltip ghi tên và model; bấm để chọn agent và model)
  - khiên (chế độ quyền; bấm để chọn Chỉ hỏi / Hỏi trước / Tự làm)
  - vòng phần trăm context
  - nút gửi; khi agent đang chạy, nút này thành nút dừng
- Dải trạng thái phía trên composer: bước hiện tại, thời gian, token, phím `esc`.
- Mèo đứng trên composer.
- Gửi prompt: chữ bay từ ô chat lên thành bong bóng tin nhắn (~480 ms, có spring). Chữ của agent hiện theo cụm từ, như stream thật.

### 5.4 Bảng context
- Mở khi bấm vòng phần trăm. Nội dung:
  - tổng token / sức chứa
  - thanh phân bổ: prompt hệ thống, công cụ, MCP, tệp ghi nhớ, tin nhắn, còn trống
  - ngưỡng tự thu gọn
  - **hạn mức 5 giờ và hạn mức 1 tuần**: phần trăm, thanh mảnh, thời điểm đặt lại
  - nút "Thu gọn ngay"
- Dữ liệu lấy từ `Run.context` và hạn mức sẵn có (`limits`, `usage/claude.rs`, `latest_codex_limits`, Kiro). Thiếu số nào thì không hiện dòng đó.

### 5.5 Panel phải
- Ba tab: **Agent (n) | Thay đổi (n) | Tệp**.
- Bên dưới ba tab là ngăn **Terminal | Log**, thu gọn được, độc lập với tab.
- Panel không tự đổi tab khi có event mới.
- **Agent (chữ ký của thiết kế):**
  - Mỗi run của cuộc trò chuyện là một làn: cha, rồi các con thụt vào kèm đường nối cây.
  - Mỗi làn có: mèo, logo agent, việc được giao (subagent ghi "subagent"), chữ trạng thái, thời gian, bước đang làm, thanh dòng thời gian.
  - Mọi làn chung một trục thời gian (thang 0 s … N s ở đầu panel). Mỗi đoạn trên thanh nằm đúng lúc nó xảy ra, màu theo loại: đọc, sửa (màu nhấn), chạy lệnh, chờ bạn.
  - Bấm làn: mở nhật ký riêng của agent đó ngay trong làn.
  - Chưa có agent: mèo ngủ và một câu nhắc.
  - Cửa sổ lớn (`tg-agent-window`) vẫn mở được từ làn và từ terminal nhỏ.
- **Thay đổi:** thay cho tab Thay đổi trong `Workbench` hiện nay.
  - Danh sách tệp: tên tệp đậm, thư mục mờ, `+a −d`, ô chọn để commit.
  - Diff của tệp đang chọn.
  - Ô nội dung commit, nút Hoàn tác, nút Commit n.
  - Push/PR (`sc-sync`) giữ nguyên.
  - Logic giữ nguyên (`diff::pending`, `commit_files`, `revert_files`).
- **Tệp:** cây tệp và editor (Monaco, xem trước/ghim, ⌘P), đánh dấu đoạn agent sửa.
- **Terminal | Log:** chính là `terminal.ts`, `TerminalsService` và `log-sections.ts` hiện có, đặt vào ngăn dưới.

### 5.6 Bảng agent
- Lưới thẻ gọn:
  - mèo 44 px
  - tiêu đề việc
  - trạng thái và thời gian ở góc phải
  - logo agent, tên agent, dự án
  - một dòng bước cuối
- Bộ lọc Tất cả / Cần bạn / Đang chạy / Xong.
- Logic `boardCards` giữ nguyên. Bấm thẻ mở cửa sổ lớn như hiện tại.

### 5.7 Cài đặt
Cột trái là các mục, cột phải là nội dung:

| Mục | Nội dung |
|---|---|
| Chung | Ngôn ngữ: Theo hệ thống / Tiếng Việt / English |
| Giao diện | Chế độ: Theo hệ thống / Tối (Kiln) / Sáng (Bisque); màu nhấn Ember, Moss, Tide, Plum; xem trước hai mặt; bảng token chỉ đọc; chuyển động Đầy đủ / Nhẹ / Tắt |
| Agent | Nội dung màn Agent hiện có |
| Kết nối | MCP, skills, tg-bridge (màn Kết nối hiện có) |
| Sử dụng | Hạn mức từng agent; ngân sách và giá (màn Chi phí hiện có) |
| Giới thiệu | Phiên bản và kiểm tra cập nhật; tài nguyên; Chẩn đoán |

Lựa chọn lưu ở localStorage như `tg.sidebar` hiện nay (`tg.theme`, `tg.accent`, `tg.motion`, `tg.lang`).

### 5.8 Theme
- **Token:**
  - Màu: `--bg`, `--bg-2`, `--bg-3`, `--bg-4`, `--ink`, `--ink-2`, `--muted`, `--rule`, `--rule-2`, `--term`, `--run`, `--wait`, `--done`, `--fail`, `--accent`, `--accent-ink`.
  - Bo góc: `--r-*`. Thời lượng và easing: `--dur-*`, `--ease*`.
  - Giá trị lấy từ bản mẫu: Kiln (tối, nền gần đen hơi ấm), Bisque (sáng, nền màu xương).
- Ở root: `[data-theme]` và `[data-accent]`.
- Tên biến hiện có trong `styles.scss` (`--text`, `--bg`, …) phải đổi theo hoặc ánh xạ một lần. Không để hai bộ tên sống song song.
- Monaco và xterm phải đổi theme theo (chủ repo dặn, Codex cũng nhắc).

### 5.9 Mèo
- `tg-mascot` dùng sprite sheet: 8 trạng thái × 8 khung, fps trong `manifest.json` (gõ 10, chạy 12, nghĩ 6, chờ 8, xong 10, lỗi 6, ngủ 4, đứng 5).
- **Trạng thái mèo lấy từ event thật của run:**

  | Mèo | Khi nào |
  |---|---|
  | nghĩ | chưa có token đầu |
  | gõ | đang nhận chữ hoặc đang sửa tệp |
  | chạy | tool `execute` đang chạy |
  | chờ | có `permissions` |
  | xong | `turn_end` thành công, chạy ~1,4 s rồi về đứng |
  | lỗi | lượt lỗi |
  | ngủ | rảnh quá `NAP_MS` hoặc `restored` |

- **Mức chuyển động:**
  - Đầy đủ: mọi mèo chuyển động.
  - Nhẹ: chỉ mèo ở composer chuyển động.
  - Tắt: mọi thứ đứng yên.
  - `prefers-reduced-motion` coi như Tắt.

### 5.10 Song ngữ
- Mọi chuỗi UI chuyển sang khoá dịch, theo hai tệp `vi` và `en`. Dịch cả tooltip và `aria-label`.
- Tên tool, lệnh, đường dẫn và log gốc không dịch.
- Lỗi từ Rust: chuyển sang mã lỗi kèm tham số để UI dịch. Hiện có khoảng 277 chuỗi lỗi tiếng Việt trong `src-tauri/src`, và 86 tệp `.ts` có chữ tiếng Việt.
- Số và ngày định dạng theo ngôn ngữ đang chọn.

## 6. Chia đợt (đề xuất, mỗi đợt tự đứng được)

1. **Token và theme:** biến mới, Kiln/Bisque, màu nhấn, Monaco/xterm theo theme, Cài đặt › Giao diện.
2. **Khung mới:** sidebar, thanh trên, bỏ `StatusBar`, Cài đặt gom các mục, panel phải có tab và ngăn Terminal/Log, ⌘K.
3. **Làn agent:** tab Agent với trục thời gian chung (cần lưu thời điểm bắt đầu và kết thúc của từng tool trên `ConsoleLine`), nhật ký từng làn.
4. **Composer chỉ dùng icon, bảng context có hạn mức, animation gửi prompt, chữ stream theo cụm.**
5. **Mèo sprite:** 8 trạng thái theo event thật, 3 mức chuyển động.
6. **Song ngữ UI:** khoá dịch, chuyển ngôn ngữ, định dạng số và ngày.
7. **Song ngữ lỗi lõi:** mã lỗi Rust → UI dịch.

## 7. Phần để người làm quyết

- Cấu trúc tệp dịch và thư viện song ngữ: tự viết dịch vụ nhỏ bằng signals, hay dùng Angular i18n. Không được làm vỡ CSP và không được cần build hai bản.
- Cách lưu thời điểm bắt đầu và kết thúc của từng tool cho trục thời gian.
- Tên biến CSS cuối cùng, và cách ánh xạ từ tên cũ.
- Các cảnh báo về khoảng cách lệch lưới 4 px mà Hallmark nêu trong bản mẫu: sửa trong lúc làm.
