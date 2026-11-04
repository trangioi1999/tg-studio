# 02 · Lộ trình

Tổng: ~14 tuần tới beta. Mỗi giai đoạn kết thúc bằng bản chạy được trên **cả macOS và Windows**.
Ký hiệu: `[x]` xong · `[ ]` chưa · **XK** = tiêu chí "xong khi".

## Giai đoạn 0 — Nền móng (tuần 1–2)

- [x] Angular 22 + Tauri 2, dark IDE shell
- [x] Dò CLI trên login PATH (`detect.rs`, `env.rs`)
- [x] Chạy agent headless, stream log (`runner.rs`)
- [x] Chuẩn hóa usage Claude/Codex/Gemini + unit test (`usage.rs`)
- [x] Usage theo agent ở cột phải, mock mode cho UI
- [x] `git init`, CI chạy `npm test` + `cargo test` trên macOS & Windows (GitHub Actions)
- [ ] Chạy thử thật trên Windows (kiểm tra shim `.cmd`, đường dẫn có dấu cách)
- [x] Lưu runs vào SQLite để mở lại app không mất lịch sử
- [x] Contract test parser bằng output thật của Claude Code và Codex (`src-tauri/tests/fixtures`)

**XK:** mở app, thấy agent đã cài, chạy 1 yêu cầu chỉ-đọc với Claude/Codex/Gemini, thấy token & chi phí.

## Giai đoạn 1 — Một agent chạy trọn vẹn (tuần 3–5) · *gần xong: còn Kiro*

Phụ thuộc: GĐ0. Chi tiết kỹ thuật: `03-agent-integration.md`.

- [x] ACP client trong Rust (JSON-RPC 2.0 qua stdio): initialize, session mới, prompt, cancel, nhận update (kiểm chứng bằng agent giả)
- [x] Adapter ACP cho Claude Code; usage lấy token từ kết quả `session/prompt`, chi phí từ `usage_update` — kiểm chứng với `claude-agent-acp@0.100.0` thật (test `live_claude_*`, fixture `tests/fixtures/claude-agent-acp/0.100.0/`)
- [x] Thẻ xin duyệt ↔ `request_permission`; policy "Always allow" theo repo
- [x] Git worktree manager: tạo / liệt kê / dọn worktree theo run
- [x] Diff viewer; Accept/Reject theo hunk
- [x] Editor Monaco: mở file trong worktree, vạch màu agent ở dòng thay đổi, sửa tay rồi lưu vào worktree (đi vào hàng chờ duyệt)
- [x] Commit từ app (message do agent đề xuất, người dùng sửa)
- [ ] Kiro CLI qua `kiro-cli acp` — đã viết, chưa thử: cần máy có Kiro và tài khoản đăng nhập (AWS Builder ID)

**XK:** giao 1 task sửa code cho Claude → duyệt lệnh → xem diff → accept → commit, không rời app.

Đã kiểm chứng: lõi Rust với Claude thật (sửa file, thẻ duyệt Edit + lệnh shell, diff, accept, commit) và UI ở mock mode bằng Playwright. Còn lại: bấm thử trọn luồng trong app desktop với Claude thật trên macOS và Windows.

## Giai đoạn 2 — Nhiều agent (tuần 6–8) · *xong, trừ kiểm chứng Codex/Gemini thật*

Plan: `docs/superpowers/plans/2026-11-04-phase-2-parallel.md`.

- [ ] Adapter ACP cho Codex, Gemini CLI — đã có lệnh khởi chạy; cần máy có tài khoản OpenAI/Google để chạy kịch bản `live_claude_*` tương ứng
- [x] Chạy song song N agent, N worktree; màn So sánh với "Dùng bản này" (áp nguyên một run, tất cả hoặc không gì) — kiểm chứng với 2 phiên Claude thật (`live_claude_parallel_group_use_one`)
- [x] Pipeline engine: bước, gán agent, truyền output bước trước (tin nhắn cuối, diff) sang bước sau; các bước chạy nối tiếp trong cùng một worktree; mẫu prompt sửa được và được nhớ
- [x] Mission control: KPI, timeline có đoạn chờ duyệt, cột theo agent, hàng chờ (duyệt lệnh → review → commit; nhóm song song tính một lần)
- [x] Cherry-pick hunk từ nhiều worktree; chạy test trên bản ghép ("Ghép thủ công" trong màn So sánh: worktree ghép từ base chung, lệnh kiểm tra do người dùng nhập, áp + commit bản ghép)
- [x] Con trỏ agent + vạch màu trong editor: editor tự mở tệp agent đang làm, con trỏ có tên agent, vạch màu cập nhật ngay khi tool sửa file xong (đo ở mock mode: ~0,2 s)

**XK:** 3 agent chạy song song cùng 1 task, chọn/ghép kết quả, merge.

## Giai đoạn 3 — Usage & tích hợp (tuần 9–11) · *đang làm*

Chi tiết: `04-usage-and-cost.md`, `05-mcp-skills-plugins.md`.

- [x] Usage Ledger SQLite + màn Usage (KPI, biểu đồ theo ngày theo agent, bảng lượt chạy, xuất CSV vào Downloads)
- [x] Bảng giá chỉnh trong app (có lịch sử: đổi giá không đổi số cũ); ngân sách theo task/ngày; cảnh báo 80 %; tự dừng khi đã có số chi phí. Chưa có ngân sách tuần
- [ ] Quota gói subscription (nguồn nào có thì hiện, gắn nhãn) — **đã có cho Claude**: cửa sổ 5 giờ / 7 ngày từ `rate_limit_event` của lượt Chỉ đọc, lưu lại qua các lần mở app. Còn thiếu: lượt Sửa code (adapter ACP bỏ event này nếu nó đến trước phản hồi đầu tiên), Codex/Gemini/Kiro chưa có nguồn
- [ ] Registry MCP: thêm server, ma trận bật/tắt, sinh config từng agent
- [ ] Skills: thư viện SKILL.md, đồng bộ sang agent hỗ trợ
- [ ] MCP `tg-bridge`: báo tiến độ, chuyển việc, ghi chú chung, xin duyệt

**XK:** biết chính xác mỗi agent tốn bao nhiêu; bật 1 MCP server một lần cho mọi agent.

## Giai đoạn 4 — Đóng gói & beta (tuần 12–14)

Chi tiết: `07-release.md`.

- [ ] Ký số + notarize macOS; installer Windows có ký
- [ ] Tự cập nhật (`tauri-plugin-updater`), kênh beta/stable
- [ ] Onboarding lần đầu; trang tài liệu người dùng
- [ ] Báo lỗi opt-in; log chẩn đoán xuất được
- [ ] Beta 20–50 người, form góp ý

**XK:** người mới cài 1 click, onboarding < 5 phút, tự cập nhật.

## Rủi ro chính

| Rủi ro | Ảnh hưởng | Cách giảm |
|---|---|---|
| CLI đổi định dạng output/flag | Adapter vỡ | Ghim phiên bản đã test, contract test với fixture JSONL, ưu tiên ACP |
| Quota gói không có API | Số liệu thiếu | Gắn nhãn nguồn, cho nhập tay, không đoán |
| Khác biệt Windows/macOS | Lỗi chỉ ở 1 OS | CI cả 2 OS từ GĐ0, test thủ công mỗi giai đoạn |
| Agent phá repo | Mất code | Worktree riêng, quyền theo bước, merge queue bắt buộc |
| Chi phí vượt kiểm soát | Mất tiền | Ngân sách + tự dừng; Claude có `--max-budget-usd` |
| Phạm vi phình to | Trễ | Mỗi giai đoạn chỉ nhận việc trong danh sách; ý tưởng mới vào backlog |

## Backlog (chưa xếp lịch)

Cộng tác nhiều người · chạy agent trên máy chủ từ xa · Ollama/model local làm reviewer giá rẻ · chế độ "tự động hoàn toàn" có giới hạn ngân sách · plugin hệ thống cho adapter bên thứ ba · bản Linux.
