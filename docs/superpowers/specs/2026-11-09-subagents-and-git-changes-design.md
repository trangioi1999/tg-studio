# TG Studio — Agent con và thay đổi theo kiểu git

- **Ngày:** 2026-11-09
- **Trạng thái:** chủ repo đã duyệt (cả ba câu ở mục 8: đồng ý theo đề xuất). Phần B (mục 4.1–4.4, 4.6) và phần A (mục 3) đã làm; mục 4.5 chưa.
- **Phần A làm khác thiết kế / còn thiếu:** tool `delegate` vẫn có trong danh sách ở Chỉ hỏi nhưng bị từ chối khi gọi (quyền đổi được giữa phiên, danh sách tool thì không); chưa kiểm ngân sách trước khi giao; khối agent con nằm cuối tin nhắn của cha, không đúng vị trí lúc giao; câu tiếp theo gửi cho cha chưa tự kèm tóm tắt kết quả; kết quả của agent con chỉ lấy từ tin nhắn cuối của nó. Subagent có sẵn của Claude và đường mở agent con thật chưa chạy với adapter thật (container không có tài khoản Claude); chỉ có test với dữ liệu giả lập.
- **Phần B làm khác thiết kế ở ba chỗ:** commit dùng `git commit --only` thay vì index tạm (cùng kết quả: giữ phần người dùng tự stage); tệp "của agent" là tệp khác tree đã nhận của run, chưa theo dõi từng lần ghi (mục 4.3); "Áp vào thư mục" của bản nháp vẫn stage như `accept_all` cũ. Chưa có dòng báo "agent đã tự commit".
- **Code tham chiếu:** `main` tại `be10201` (v0.5.1)

Quy ước: **[Chủ repo]** là điều chủ repo đã nói hoặc đã chốt. **[Đề xuất]** là quyết định của người viết, chủ repo đổi được khi duyệt. **[Cần kiểm chứng]** phải chạy thử với CLI thật trước khi code dựa vào nó.

## 1. Ý định

**[Chủ repo]** nêu hai việc:

1. Khi một agent đang làm task A thấy có phần giao được cho agent khác (Codex, hoặc một Claude phụ), agent kia phải hiện rõ trong cuộc trò chuyện và phiên làm việc. Hiện tại không thấy gì, hoặc chỉ là một thẻ đề xuất.
2. Phần agent viết ra không bắt duyệt từng tệp, từng đoạn nữa. Nó phải là **thay đổi git** bình thường: xem danh sách tệp đổi, xem diff, giữ hoặc hoàn tác cả loạt, rồi commit.

Hai việc đi chung vì agent con làm tăng số tệp bị đổi. Duyệt từng đoạn đã chậm với một agent, có ba agent thì không dùng được.

### Thành công là

- Claude giao một phần việc cho Codex. Người dùng thấy ngay trong tin nhắn của Claude: Codex đang làm gì, đến đâu, tốn bao nhiêu. Khi Codex xong, Claude nhận kết quả và làm tiếp mà người dùng không phải chép qua lại.
- Subagent nội bộ của Claude (tool Task/Agent) cũng hiện thành dòng riêng, không lẫn vào nhật ký của Claude.
- Agent làm xong, người dùng mở tab **Thay đổi**, thấy "12 tệp · +340 −120", bấm **Commit** là xong. Không có bước bắt buộc nào ở mức từng đoạn.
- Không bao giờ mất phần người dùng tự sửa chưa commit.

### Không làm

- Agent con giao tiếp cho agent con khác. Chỉ một tầng.
- Tự merge, push, tạo PR.
- Thay cơ chế **So sánh** (nhiều agent cùng một việc, chọn một bản). Cơ chế đó giữ nguyên; tài liệu này chỉ đổi cách xem và nhận thay đổi của một nơi làm việc.

## 2. Hiện trạng

### 2.1 Agent con

| Trường hợp | Hiện tại | Chỗ trong code |
|---|---|---|
| Subagent của Claude | Chỉ là một tool call. Các bước bên trong (nếu có) trộn vào Nhật ký làm việc của Claude. Token tính chung. | `acp_runner.rs:220` đổi mọi `tool_call` thành dòng `tool` |
| Chuyển cho Codex | Claude gọi `handoff_to` qua tg-bridge, app hiện thẻ "Claude đề xuất chuyển cho Codex". Bấm nhận thì Codex chạy thành run kế tiếp cùng `thread`. Nối tiếp, Claude không nhận lại kết quả. | `bridge.rs:85`, `runs.service.ts:363`, `agent-panel.ts:430` |

**Đã đọc mã adapter `@agentclientprotocol/claude-agent-acp` 0.100.0** (`dist/acp-subagents.d.ts`, `native-subagents.js`): adapter có sẵn **phiên con cho subagent** theo RFD subagents của ACP. Client khai báo `clientCapabilities.subagents` thì nhận `subagent_update` (mỗi subagent có `sessionId` riêng, `title`, `description`, trạng thái) và `session_message` (tin nhắn, tool call của phiên con). Không khai báo thì subagent chỉ là tool call như hiện nay, có `_meta.claudeCode.parentToolUseId`.

### 2.2 Duyệt thay đổi

- `diff::pending` (`diff.rs:140`) dựng danh sách đoạn chờ duyệt từ một tree "đã nhận" lưu ở tệp `tg-accepted`.
- Tab thay đổi (`diff-viewer.ts`) liệt kê **từng đoạn**, mỗi đoạn có nút Giữ/Nhận và Hoàn tác/Bỏ. Ô Commit chỉ hiện sau khi đã nhận ít nhất một đoạn.
- "Nhận tất cả" (`diff::accept_all`) chỉ có trong màn So sánh.
- Ở chế độ `direct` (mặc định), tệp **đã đổi trên đĩa** ngay khi agent ghi. "Giữ" thực chất chỉ là `git add` vào index thật; "Hoàn tác" là đảo đoạn đó trên đĩa. Tức là bước duyệt từng đoạn không bảo vệ gì thêm, chỉ là một bước phải bấm.

## 3. Phần A — Agent con

### 3.1 Hai nguồn agent con

| | Subagent của Claude | Giao việc qua tg-bridge |
|---|---|---|
| Ai mở | Claude Code tự mở (tool Task/Agent) | Agent cha gọi tool `delegate` mới |
| Agent con | Claude, cùng tiến trình adapter | Bất kỳ agent đã cài: Codex, Claude, Gemini, Kiro |
| Nơi làm | Cùng thư mục với cha (adapter quyết, app không đổi được) | Bản nháp riêng, gộp lại khi xong (mục 3.4) |
| App điều khiển được | Xem; dừng nếu adapter cho (`capabilities.cancel`) | Toàn bộ: duyệt mở, dừng, quyền, model |
| Chi phí | Theo những gì adapter báo **[Cần kiểm chứng]** | Run riêng, usage riêng |

### 3.2 Hiển thị trong cuộc trò chuyện **[Đề xuất]**

Agent con là **một khối lồng trong tin nhắn của agent cha**, đặt đúng chỗ cha giao việc trong dòng chat:

```
Bạn: Thêm export CSV cho màn Usage
✦ Claude
  Tôi làm phần service, giao Codex viết test, một Claude phụ cập nhật docs.
  ┌───────────────────────────────────────────────────────────────┐
  │ ◎ Codex · Viết test cho export CSV       ● Đang chạy · 1:12 · $0.03 │
  │   Đang sửa src/app/core/usage-report.spec.ts                  │
  ├───────────────────────────────────────────────────────────────┤
  │ ✦ Claude phụ · Cập nhật docs/user-guide.md   ✓ Xong · 1 tệp · $0.01 │
  └───────────────────────────────────────────────────────────────┘
  Nhật ký làm việc (8 bước)
  Xong: service + 6 test (Codex) + docs. Tổng cuộc trò chuyện $0.14
```

- Mỗi agent con một dòng: avatar, tên, việc được giao, trạng thái bằng chữ (theo `.pill[data-status]`), thời gian, chi phí, và một dòng "đang làm gì" lấy từ bước gần nhất.
- Bấm vào dòng thì **mở rộng tại chỗ**: tin nhắn và Nhật ký làm việc của agent con, cùng cách render với agent cha (`segmentsOf`), thụt vào một bậc. Không mở rộng sâu hơn một tầng.
- Nút trên dòng: **Dừng** (khi đang chạy), **Xem thay đổi** (mở tab Thay đổi lọc theo agent con).
- Thẻ duyệt lệnh của agent con vẫn ghim trên ô chat như hiện tại, có nhãn "Codex (việc con của Claude)".
- Thanh trái: cuộc trò chuyện vẫn là một dòng, thêm số agent đang chạy ("3 đang chạy"). Không tạo cuộc trò chuyện mới cho agent con.
- Giám sát (`mission-control.ts`): agent con hiện như run thường, kèm nhãn cha.
- Chi phí ở đầu cuộc trò chuyện là tổng mọi run, di chuột thấy chia theo agent.

### 3.3 Tool `delegate` trong tg-bridge **[Đề xuất]**

`handoff_to` giữ nguyên (đề xuất cho người dùng, nối tiếp). Thêm hai tool:

```
delegate(agent, task, files?: string[]) -> { id, status: "running" | "waiting_approval" | "refused" }
wait_delegated(ids?: string[], timeout_s?: number ≤ 50)
  -> [{ id, agent, status: "running"|"done"|"failed"|"stopped", summary?, files_changed?, conflicts? }]
resolve_delegated(id)   // cha đã tự gộp phần xung đột, xoá worktree con (mục 3.4)
```

- `delegate` trả về ngay, không chờ agent con làm xong. Lý do: Codex mặc định cắt tool MCP sau khoảng 60 giây **[Cần kiểm chứng: `tool_timeout_sec` của Codex, `MCP_TOOL_TIMEOUT` của Claude Code]**. Agent cha gọi `wait_delegated` lặp lại, mỗi lần tối đa 50 giây.
- `summary` là tin nhắn cuối của agent con, cắt ở 4.000 ký tự; `files_changed` là danh sách tệp; `conflicts` là tệp không gộp được (mục 3.4).
- Mô tả tool nói rõ cho agent: chỉ giao phần **độc lập**, ghi rõ tệp liên quan trong `files`, tối đa 3 việc con chạy cùng lúc.

**Quyền của việc giao** theo quyền của phiên cha:

| Quyền phiên cha | `delegate` |
|---|---|
| Chỉ hỏi (`deny`) | Không có tool này trong danh sách |
| Hỏi trước (`ask`) | Thẻ duyệt: "Claude muốn giao cho Codex: Viết test cho export CSV · [Từ chối] [Cho phép]". `status` là `waiting_approval` cho đến khi người dùng chọn |
| Tự động (`auto`) | **[Chủ repo]** Agent tự chia việc, tự gọi agent con, tự gộp kết quả, không hỏi gì. Người dùng chỉ xem khối lồng chạy |

**[Chủ repo]** Ở chế độ Tự động, người dùng đã giao hết, nên agent cha được xử lý trọn: quyết chia hay không, giao cho ai, đợi, xử lý xung đột khi gộp (mục 3.4), rồi báo kết quả cuối. Mô tả tool ở chế độ này khuyến khích chia việc khi task có phần độc lập; ở Hỏi trước thì chỉ nói là có thể giao.

Agent con **kế thừa quyền** của cha, dùng model mặc định của agent đó (`AgentsService.prefs`).

**Giới hạn**, áp dụng cả ở Tự động vì đó là rào an toàn chứ không phải câu hỏi: tối đa 3 agent con đang chạy mỗi phiên cha; agent con không có `delegate`/`handoff_to`; agent chưa cài trả `refused` kèm lý do để cha tự làm phần đó. Ngân sách: nếu người dùng đã đặt ngân sách (`BudgetService`) và việc giao sẽ vượt, `delegate` trả `refused: "budget"` và cha tự làm tiếp không có agent con; app chỉ hiện một dòng thông báo, không chặn bằng thẻ hỏi.

**Vòng đời:**

- Dừng cha thì dừng mọi agent con của nó.
- Agent con lỗi thì `wait_delegated` trả `failed` cùng dòng lỗi cuối, cha tự quyết làm tiếp.
- Cha kết thúc lượt khi con còn chạy: con vẫn chạy. Khi con xong, kết quả hiện trong khối lồng; câu tiếp theo người dùng gửi cho cha sẽ kèm tóm tắt kết quả (giống `recapOf` khi đổi agent).

### 3.4 Agent con làm ở đâu **[Đề xuất]**

Hai agent cùng ghi một tệp trong cùng một thư mục thì bản ghi sau đè bản trước. Codex ghi đĩa bằng `apply_patch` của chính nó, app không chặn giữa chừng được. Vì vậy:

1. Lúc `delegate`, lõi chụp trạng thái nơi làm việc của cha thành một tree (cách `worktree::direct` đang làm), tạo commit tạm bằng `git commit-tree` (không đổi nhánh nào), rồi mở worktree cho agent con từ commit đó.
2. Agent con làm trong worktree riêng, hoàn toàn như một task `draft` hiện nay.
3. Agent con xong: lõi lấy diff của nó so với commit tạm và áp vào nơi làm của cha bằng `git apply --3way`.
   - Áp được hết: thay đổi vào nơi làm của cha, ghi nhận là của agent con (mục 4.3), worktree con bị xoá.
   - Có tệp xung đột: không áp tệp đó, giữ worktree con, `wait_delegated` trả `conflicts` kèm đường dẫn worktree con. Agent cha tự đọc bản của con và sửa tệp trong nơi làm của mình; xong thì gọi `resolve_delegated(id)` để xoá worktree con. Ở Tự động việc này không hỏi người dùng. Khối lồng chỉ hiện "2 tệp xung đột, Claude đang gộp"; nếu cha kết thúc lượt mà chưa gộp, khối lồng hiện thêm [Xem] [Lấy bản của Codex] [Bỏ] cho người dùng.

Subagent của Claude không theo được cách này vì adapter quyết thư mục. Bù lại nó chạy trong cùng phiên Claude, và Claude Code tự lo thứ tự ghi của các subagent.

### 3.5 Subagent của Claude **[Cần kiểm chứng]**

- `AcpClient` khai báo `clientCapabilities.subagents` khi `initialize`.
- `subagent_update` mở một run con trong UI (`parent` là run của Claude, `agent: claude`, `title` lấy từ adapter). `session_message` của phiên con đi vào run con thay vì run cha.
- Run con này **chỉ để hiển thị**: không có tiến trình riêng, `stop_agent` gửi `session/cancel` cho phiên con nếu adapter cho phép, không thì ẩn nút Dừng.
- Cần chạy thật (`TG_LIVE_ACP=1`) để biết: thứ tự event, adapter có báo token riêng cho phiên con không, và quyền của subagent có đi qua `session/request_permission` không. Nếu adapter chỉ báo tổng ở phiên cha, run con hiện "chi phí tính trong Claude" và không đếm hai lần.

### 3.6 Dữ liệu

- `Run` thêm `parent: string | null` (`protocol.ts`, struct Rust tương ứng, cột `parent_run_id` trong SQLite) và `delegation: { by: AgentId; task: string; state } | null`.
- Run con có cùng `thread` với cha, nên `ThreadsService` không phải đổi cách gom. Dòng chat (`timeline.ts`) chèn khối lồng vào vị trí event `delegate` của cha, theo `id` của việc giao.
- Lịch sử nạp lại (`restored: true`) dựng lại khối lồng từ `parent_run_id`.
- Event mới trong `agent-event`: `delegate` (ở run cha: id, agent, task, runId con) và `delegate_done` (kết quả, conflicts).

## 4. Phần B — Thay đổi theo kiểu git

### 4.1 Mô hình mới **[Chủ repo] hướng, [Đề xuất] chi tiết**

Bỏ khái niệm "hàng chờ duyệt". Thay đổi của agent là **thay đổi chưa commit trong git**, xem và xử lý như tab Source Control của VS Code.

| | Hiện tại | Mới |
|---|---|---|
| Đơn vị thao tác | Từng đoạn | Cả loạt, hoặc từng tệp. Đoạn chỉ còn là tuỳ chọn trong editor diff |
| Nguồn sự thật | Tree "đã nhận" trong `tg-accepted` | `git status` của nơi làm việc, so với ảnh chụp lúc agent bắt đầu |
| Commit | Chỉ hiện sau khi đã nhận một đoạn | Luôn có ở đầu tab khi có thay đổi |
| Hoàn tác | Từng đoạn | Từng tệp, hoặc tất cả, về **trạng thái trước khi agent sửa** (không phải về HEAD) |

### 4.2 Tab **Thay đổi**

```
Thay đổi · 12 tệp · +340 −120                       [Hoàn tác tất cả]
┌ Nội dung commit ────────────────────────────────────────────┐
│ feat(usage): export CSV                                      │
└──────────────────────────────────────────────────────────────┘
                                         [Commit 12 tệp]
Của agent (10)
 ☑ M  src/app/core/usage-report.ts        ✦ +80 −12     ↶
 ☑ A  src/app/core/usage-report.spec.ts   ◎ +140        ↶
 ☑ M  docs/user-guide.md                  ✦ +6 −1       ↶
 …
Bạn tự sửa (2)
 ☐ M  src/styles.scss                         +3 −3
```

- **Hai nhóm:** "Của agent" (tệp có run trong cuộc trò chuyện này sửa, có avatar agent) và "Bạn tự sửa" (tệp đã đổi trước khi agent bắt đầu, hoặc agent không đụng tới). Nhóm "Bạn tự sửa" mặc định không chọn để commit.
- **Ô chọn** quyết định tệp nào vào commit. Mặc định chọn hết nhóm của agent.
- **Commit:** stage đúng các tệp đã chọn rồi `git commit`. Phần người dùng đã tự stage trước đó vẫn được giữ: app dùng index tạm để commit, không xoá index thật **[Đề xuất]**, sửa luôn mục #8 trong review của Codex.
- **Nội dung commit** gợi ý sẵn từ yêu cầu đầu tiên của cuộc trò chuyện, sửa được.
- **Bấm một tệp** mở editor diff Monaco hai cột (đã có `code-editor.ts`). Thanh từng đoạn trong editor (content widget hiện có) vẫn còn để ai muốn bỏ một đoạn lẻ thì bỏ, nhưng không bắt buộc.
- **↶ Hoàn tác tệp** đưa tệp về đúng nội dung trước khi agent sửa (lấy từ ảnh chụp `base`), không về HEAD. Tệp agent tạo mới thì bị xoá. Cần xác nhận một lần cho "Hoàn tác tất cả".
- Agent còn đang chạy: tab vẫn xem được, cập nhật trực tiếp; nút Commit và Hoàn tác bị khoá kèm lời nhắc "Claude đang sửa, dừng hoặc đợi xong".

### 4.3 Ghi nhận tệp nào của agent nào

- Mỗi run giữ `base` (đã có cho `direct`). Tệp "của agent" là tệp khác giữa `base` và hiện tại **và** có trong danh sách tệp run đó đã ghi.
- Danh sách tệp đã ghi lấy từ: `fs/write_text_file` (ACP), tool call loại `edit` có `locations`, và diff của agent con khi gộp (mục 3.4). Codex ghi trực tiếp nên thêm một bước dự phòng: so `base` với cuối lượt **[Cần kiểm chứng]** độ đủ của `locations` ở Codex.
- Người dùng và agent cùng sửa một tệp: tệp vào nhóm của agent. Bản đầu không tách phần của người dùng trong editor diff.

### 4.4 Bản nháp (`draft`) và nhiều agent

- Bản nháp vẫn là worktree trên nhánh riêng. Tab Thay đổi của bản nháp có nút chính **Áp vào thư mục** (đưa toàn bộ thay đổi vào thư mục thật, chưa commit, rồi xử lý như trên) và **Commit trên nhánh nháp** cho ai muốn giữ nhánh.
- So sánh và "Dùng bản này" giữ nguyên `diff::accept_all`, chỉ đổi kết quả: thay đổi vào thư mục thật dưới dạng chưa commit thay vì staged.

### 4.5 Mốc lượt (làm ở giai đoạn sau) **[Đề xuất]**

Cuối mỗi lượt của agent, lõi chụp tree của nơi làm việc và lưu ở ref riêng `refs/tg/<thread>/<lượt>` (không đổi nhánh, không hiện trong `git log`). Mỗi tin nhắn của agent có nút **Quay lại trước lượt này**: hoàn tác các tệp lượt đó đã sửa. Đây là cách thay cho duyệt từng đoạn khi agent làm sai: quay cả lượt, không nhặt từng đoạn.

### 4.6 Lời hứa cốt lõi phải sửa

Tài liệu chat-first ghi "code thật chỉ đổi khi người dùng duyệt". Với `direct` điều đó đã không đúng từ trước, vì agent ghi thẳng vào đĩa. Đề xuất sửa thành: **"Không có gì vào git khi bạn chưa commit; mọi thay đổi của agent hoàn tác được tới đúng trạng thái trước khi nó sửa."** Ai cần chặn hẳn thì chọn bản nháp hoặc quyền Hỏi trước.

### 4.7 Lõi

| Bỏ | Thêm |
|---|---|
| Tệp `tg-accepted`, `save_accepted`, phần khôi phục index trong `diff::pending` | `changes(wt) -> { files: [{ path, status, added, removed, by: [runId] , mine }] }` từ `git status --porcelain=v2` + diff numstat so với `base` |
| `accept_hunk` như đường chính | `revert_files(wt, paths)` về `base`; `commit_files(repo, paths, message)` qua index tạm |
| | `apply_draft(repo, wt)` (đổi từ `accept_all`, áp chưa stage) |

`reject_hunk` giữ cho thanh đoạn trong editor. `pending` đổi tên thành `file_diff(wt, path)` chỉ dùng khi mở một tệp.

## 5. Lỗi và trường hợp biên

| Tình huống | Xử lý |
|---|---|
| Agent con gộp lại bị xung đột | Mục 3.4: giữ worktree con, báo cha và người dùng |
| Người dùng sửa tệp agent đang sửa | Không chặn. Hoàn tác tệp đó sẽ mất cả phần người dùng, nên nút ↶ hỏi xác nhận khi phát hiện tệp có sửa sau `base` mà không do agent ghi |
| Agent tự `git commit` | `changes` so với `base`, không so với HEAD, nên commit của agent vẫn hiện là thay đổi của nó; tab báo "Claude đã tự commit 1 lần" |
| Repo chưa có commit nào | Giữ cách xử lý hiện tại của `project.rs` (`nocommit`) |
| Tệp nhị phân | Hiện trong danh sách, commit và hoàn tác được, không xem diff |
| Đóng app khi agent con đang chạy | Như run thường: tiến trình bị dừng, run ghi `stopped`; worktree con còn trên đĩa, lần mở sau hiện trong khối lồng với nút Bỏ |

## 6. Kiểm thử

- **Rust unit:** `changes` phân nhóm đúng khi người dùng sửa trước, agent sửa sau; `revert_files` về `base` chứ không về HEAD; `commit_files` không đụng phần người dùng đã stage; gộp agent con có và không có xung đột (repo tạm, như test `diff.rs` hiện có).
- **tg-bridge:** `delegate`/`wait_delegated`/`resolve_delegated` qua `ToolEnv` giả: quyền `deny` không có tool, `ask` trả `waiting_approval`, `auto` chạy ngay không phát thẻ duyệt, quá 3 việc hoặc vượt ngân sách thì `refused`, agent con không có `delegate`.
- **Agent giả `acp/fake.rs`:** phát `subagent_update` + `session_message`, kiểm tra event đi vào run con.
- **Live (tốn token):** `live_claude_subagents` cho mục 3.5; `live_claude_delegates_codex` một việc nhỏ (Claude giao Codex viết một test), kiểm tra Claude nhận `summary` và thay đổi gộp về thư mục.
- **Angular:** `timeline.spec.ts` chèn khối lồng đúng vị trí; spec cho tab Thay đổi (chọn, commit, hoàn tác, khoá khi agent đang chạy); MockBackend mô phỏng một việc giao.

## 7. Thứ tự làm **[Đề xuất]**

1. **Thay đổi theo kiểu git** (mục 4.1–4.4, 4.6): giải quyết ngay chuyện duyệt từng đoạn, không phụ thuộc phần A.
2. **Subagent của Claude** (mục 3.5): bắt đầu bằng live test để chốt các điểm cần kiểm chứng, rồi mới làm khối lồng.
3. **`delegate` qua tg-bridge** (mục 3.3, 3.4, 3.6), dùng chung khối lồng của bước 2.
4. **Mốc lượt** (mục 4.5).

## 8. Câu hỏi cho chủ repo

1. Đồng ý sửa lời hứa cốt lõi như mục 4.6?
2. Commit mặc định chỉ gồm tệp của agent (đề xuất), hay mọi thay đổi trong thư mục?
3. Ở Tự động, agent có được tự commit khi xong việc không (mặc định đề xuất: không, để người dùng bấm Commit), hay "giao hết" bao gồm cả commit?
