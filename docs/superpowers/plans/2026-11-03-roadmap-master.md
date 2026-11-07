# TG Studio — Plan tổng và phân công Claude / Codex

Chia `docs/02-roadmap.md` thành các task giao được cho từng agent. Spec chi tiết nằm ở `docs/01`–`07`; tài liệu này chỉ quyết định **thứ tự, người làm và điều kiện xong**.

Mỗi giai đoạn sẽ có plan chi tiết riêng trong thư mục này trước khi làm, vì giao diện của giai đoạn sau phụ thuộc vào những gì học được ở giai đoạn trước. GĐ0 đã có: `2026-11-03-phase-0-completion.md`.

## Quy tắc chia việc

| Giao cho | Loại việc | Lý do |
|---|---|---|
| **Codex** | Module tách biệt, giao diện đã chốt, kiểm chứng được bằng test: parser, store, transport, worktree, script | Chạy độc lập trong worktree, không cần ngữ cảnh toàn app |
| **Claude** | Nối nhiều module, UI, quyết định kiến trúc, review và merge | Cần nhìn xuyên suốt, chịu trách nhiệm tích hợp |
| **Chủ repo** | Tài khoản, tiền, phát hành: tạo remote GitHub, Apple Developer, chứng chỉ Windows, test máy Windows thật, mời beta | Agent không tự quyết được |

Quy tắc chung:
1. Hai agent không sửa cùng một file trong cùng một đợt. Xung đột thì tách task hoặc xếp nối tiếp.
2. Agent nào viết thì agent kia review. Không ai tự duyệt việc của mình.
3. Task chỉ xong khi test trong task đó chạy qua trên máy, và người review đã đọc diff.
4. Agent không được sửa test để né lỗi. Test lộ bug thì báo lại.

## Cách giao một task cho Codex

**Đang chạy bên trong TG Studio** (có tool `handoff_to` của MCP server `tg-bridge`): giao việc bằng `handoff_to` (agent `codex`, mô tả task, danh sách tệp), đừng tự chạy `codex exec`. Người dùng thấy thẻ đề xuất, bấm nhận thì Codex chạy thành một cuộc trò chuyện riêng trong app, có log, thay đổi và chi phí. `codex exec` chạy ngầm là tiến trình con của bạn, app không thấy nó.

Cách dưới đây chỉ dùng khi làm ngoài TG Studio (terminal):

```bash
# Từ thư mục gốc repo. Sandbox Codex không có mạng và không ghi được .git,
# nên phải tải dependency trước và người review sẽ commit.
T=<task-id>                     # ví dụ t2-store
WT=../tg-studio-wt/$T
git worktree add -b codex/$T "$WT" main
ln -s "$PWD/node_modules" "$WT/node_modules"
codex exec -C "$WT" -s workspace-write --json \
  "Đọc AGENTS.md, rồi làm đúng Task N trong docs/superpowers/plans/<plan>.md. Chỉ sửa file task liệt kê. Build bằng cargo --offline. Không commit. Cuối cùng báo: file đã đổi, lệnh test đã chạy và kết quả." \
  > "/tmp/$T.jsonl"
# Review
git -C "$WT" status --short && git -C "$WT" diff
```

## Giai đoạn 0 — Nền móng

| ID | Task | Owner | Phụ thuộc | Xong khi |
|---|---|---|---|---|
| 0.1 | git init, CI macOS + Windows | Claude | — | Workflow hợp lệ; chạy được ngay khi có remote |
| 0.2 | `store.rs` SQLite | Codex | 0.1 | 8 unit test qua |
| 0.3 | Nối store vào runner và UI | Claude | 0.2 | Mở lại app còn lịch sử |
| 0.4 | Contract test bằng output thật | Claude + Codex | 0.1 | Parser qua fixture thật |
| 0.5 | Nghiệm thu, review chéo | Claude + Codex | 0.2–0.4 | XK của GĐ0 |
| 0.6 | Tạo remote GitHub, chạy CI | **Chủ repo** | 0.1 | CI xanh trên 2 OS |
| 0.7 | Chạy thật trên Windows | **Chủ repo** | 0.6 | Shim `.cmd`, đường dẫn có dấu cách hoạt động |

## Giai đoạn 1 — Một agent chạy trọn vẹn

| ID | Task | Owner | Phụ thuộc | Xong khi |
|---|---|---|---|---|
| 1.1 | `acp/transport.rs`: JSON-RPC 2.0 qua stdio, timeout | Codex | GĐ0 | Test request/response/notification/timeout |
| 1.2 | ACP fake agent có kịch bản | Codex | 1.1 | Kịch bản xin quyền, ghi file, crash chạy được |
| 1.3 | `acp/client.rs`: initialize, session/*, cancel | Claude | 1.1, 1.2 | Hoàn tất một phiên với fake agent |
| 1.4 | `acp/handlers.rs`: fs/*, terminal/* chỉ trong worktree | Codex | 1.3 | Ghi ra ngoài worktree luôn bị từ chối, kể cả qua symlink và `..` |
| 1.5 | `worktree.rs`: tạo, liệt kê, dọn | Codex | GĐ0 | Test trên repo tạm, đường dẫn có dấu cách |
| 1.6 | `policy.rs` + thẻ xin duyệt | Claude | 1.3 | Deny / Allow once / Always allow theo repo + agent + mẫu lệnh |
| 1.7 | Adapter ACP Claude, usage song song | Claude | 1.3 | Task thật chạy và có usage |
| 1.8 | Monaco + diff viewer + Accept/Reject hunk | Claude | 1.5 | Theo hunk, đúng `06-design-system.md` |
| 1.9 | Commit từ app | Codex | 1.5, 1.8 | Message do agent đề xuất, người dùng sửa được |
| 1.10 | Kiro qua `kiro-cli acp` | Codex | 1.3 | Dùng `_meta.kiro.extensionMethods`, không hard-code |

**XK:** giao task sửa code cho Claude → duyệt lệnh → xem diff → accept → commit, không rời app.

## Giai đoạn 2 — Nhiều agent

| ID | Task | Owner | Phụ thuộc | Xong khi |
|---|---|---|---|---|
| 2.1 | Adapter ACP Codex, Gemini | Codex | GĐ1 | Cả hai qua kịch bản của 1.7 |
| 2.2 | Scheduler N agent, N worktree | Claude | 2.1 | Các run không ghi đè nhau |
| 2.3 | Màn So sánh | Claude | 2.2 | "Use this" merge đúng kết quả |
| 2.4 | Pipeline engine | Codex | 2.2 | Output bước trước sang bước sau; test bằng fake agent |
| 2.5 | Mission control + merge queue | Claude | 2.2 | Không giật khi 4 agent chạy |
| 2.6 | Cherry-pick hunk, test trên bản ghép | Codex | 2.3 | Bản ghép chạy lại được test |
| 2.7 | Con trỏ agent + vạch màu trong editor | Claude | 1.8 | Con trỏ cập nhật ≤ 1s |

**XK:** 3 agent chạy song song cùng 1 task, chọn/ghép kết quả, merge.

## Giai đoạn 3 — Usage và tích hợp

| ID | Task | Owner | Phụ thuộc | Xong khi |
|---|---|---|---|---|
| 3.1 | Mở rộng ledger: tasks, prices, budgets, quota; dọn dữ liệu cũ | Codex | 0.2 | Migration từ schema v1 có test |
| 3.2 | Màn Usage: KPI, biểu đồ, bảng phiên, CSV | Claude | 3.1 | Biểu đồ khớp tổng bảng phiên |
| 3.3 | Bảng giá + ngân sách + tự dừng | Codex | 3.1 | Đổi giá không sai số cũ; vượt trần dừng run |
| 3.4 | Quota gói, có nhãn nguồn | Claude | 3.1 | Không có nguồn thì không hiện số |
| 3.5 | Registry MCP + sinh config từng agent | Codex | GĐ1 | Bật 1 lần, mọi agent nhận; sao lưu và hiện diff trước khi ghi |
| 3.6 | Skills: thư viện và đồng bộ | Codex | 3.5 | Hiện rõ agent nào hỗ trợ |
| 3.7 | Màn Integrations | Claude | 3.5, 3.6 | Ma trận bật/tắt hoạt động |
| 3.8 | MCP `tg-bridge` | Claude | 3.5 | Báo tiến độ, chuyển việc, ghi chú chung, xin duyệt |

**XK:** biết chính xác mỗi agent tốn bao nhiêu; bật 1 MCP server một lần cho mọi agent.

## Giai đoạn 4 — Đóng gói và beta

| ID | Task | Owner | Phụ thuộc | Xong khi |
|---|---|---|---|---|
| 4.1 | Mua Apple Developer, chứng chỉ Windows, nạp CI secrets | **Chủ repo** | — | Secrets có trong CI |
| 4.2 | CI phát hành, `version:sync`, `CHANGELOG` | Codex | 4.1 | Tag tạo được bản ký trên 2 OS |
| 4.3 | Tự cập nhật, kênh beta/stable | Codex | 4.2 | Bản cũ tự lên bản mới |
| 4.4 | Onboarding lần đầu | Claude | GĐ3 | Người mới xong < 5 phút |
| 4.5 | Báo lỗi opt-in, log chẩn đoán | Codex | GĐ3 | Mặc định tắt; xuất được log |
| 4.6 | Tài liệu người dùng | Claude | 4.4 | Đủ cho người mới cài và chạy |
| 4.7 | Beta 20–50 người | **Chủ repo** | 4.2–4.6 | Có form góp ý và người dùng thật |

**XK:** người mới cài 1 click, onboarding < 5 phút, tự cập nhật.

## Có thể làm song song

- GĐ1: 1.1 → (1.2, 1.5) song song → 1.3 → (1.4, 1.6, 1.7) song song, không sửa chung file → 1.8 → (1.9, 1.10).
- GĐ3: 3.1 và 3.5 độc lập nên chạy cùng lúc được.
