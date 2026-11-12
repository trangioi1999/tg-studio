# TG Studio — Source Control, terminal và hook theo dự án (đợt 2)

- **Ngày:** 2026-11-12
- **Trạng thái:** chủ repo đã đồng ý ba việc và cho giao phần làm được cho Codex; chủ repo đã duyệt (2026-11-12: "bạn tự giao codex các thứ với bạn làm đi"); mọi mục **[Đề xuất]** coi như đã chốt.
- **Code tham chiếu:** nhánh `claude/ui-polish` tại `c830340`

Quy ước: **[Chủ repo]** là điều chủ repo đã nói hoặc đã chốt. **[Đề xuất]** là quyết định của người viết, chủ repo đổi được khi duyệt. **[Cần kiểm chứng]** phải chạy thử thật trước khi code dựa vào nó.

## 1. Ý định

Sau khi rà soát dự án và so với T3 Code, Claude Code desktop, Conductor, **[Chủ repo]** chốt ba việc trước beta:

1. **Thay đổi kiểu Source Control.** Quản lý thay đổi như Source Control của VS Code: danh sách tệp, commit, hoàn tác cả tệp. Không duyệt từng đoạn nữa ("không cần nữa thì revert cả file đó chứ không cần theo từng phần"). Thêm đường đưa code lên remote: push, tạo PR.
2. **Terminal cho từng cuộc trò chuyện.** Một terminal thật (pwsh trên Windows, shell của máy trên macOS) trong app, ở đúng thư mục agent đang làm.
3. **Hook trước và sau mỗi lượt:** script chuẩn bị bản nháp (vì bản nháp là git worktree, thiếu `.env`, `CLAUDE.local.md` và mọi tệp bị `.gitignore`) và vòng kiểm tra (agent báo xong thì app chạy test/lint, hỏng thì gửi lỗi lại cho agent).

**[Chủ repo]** loại: nút "Mở trong VS Code/Cursor".

Vai trò của app không đổi: **[Chủ repo]** "cái của tôi chỉ control agents thôi". App không viết harness riêng, không sửa file cấu hình hay file luật của agent; mỗi CLI tự đọc cấu hình của nó trong repo.

### Thành công là

- Agent sửa xong, người dùng mở tab **Thay đổi**, bỏ chọn tệp không muốn, hoàn tác tệp không cần, commit, rồi bấm **Push** (hoặc **Tạo PR**) mà không rời app. Không có nút nào ở mức từng đoạn ở bất kỳ đâu trong app.
- Trong một cuộc trò chuyện, người dùng mở tab Terminal và gõ `npm test`, `git log`… ngay trong thư mục của agent (repo khi làm thẳng, bản nháp khi làm trong bản nháp).
- Bản nháp mới có sẵn `.env` và `node_modules` nhờ script chuẩn bị của dự án, agent không còn hỏng vì thiếu chúng.
- Dự án khai báo `npm test`: mỗi lần agent sửa code xong một lượt, app chạy lệnh đó; hỏng thì agent nhận lỗi và tự sửa, tối đa N vòng; người dùng thấy kết quả kiểm tra ngay trong chat.

### Không làm

- Pull, fetch, đổi nhánh, merge, rebase trong app. Chỉ hiện số commit lệch so với remote.
- Duyệt từng đoạn ở bất cứ đâu, kể cả trong editor.
- Mở trong editor ngoài.
- Terminal cho agent dùng (agent đã có tool shell riêng). Terminal là của người dùng.
- Hook chạy theo từng tool call, hook do agent khai báo, hook kiểu Claude Code (`.claude/settings.json`): những thứ đó thuộc CLI.
- Ghi tệp cấu hình vào repo của người dùng.

### Thất bại dù chạy được

- Push treo vì git hỏi mật khẩu trong một tiến trình không có terminal.
- Terminal trên app mở từ Finder không thấy `node`, `gh` (thiếu PATH đăng nhập), hoặc trên Windows bật cửa sổ cmd trống.
- Vòng kiểm tra chạy mãi, gửi lỗi liên tục, đốt token khi người dùng không để ý.
- Script chuẩn bị hỏng mà agent vẫn chạy như không có chuyện gì, người dùng không biết vì sao agent làm sai.
- Bỏ duyệt từng đoạn làm hỏng màn Ghép thủ công (vẫn ghép theo đoạn từ nhiều run).

## 2. Hiện trạng (đọc từ code)

- Tab Thay đổi (`features/changes/diff-viewer.ts`) đã làm theo tệp: chọn tệp, `commit_files`, `revert_files`, "Hoàn tác tất cả"; bản nháp có "Áp vào thư mục" / "Bỏ bản nháp". Không có push hay PR.
- Editor (`features/editor/code-editor.ts`) còn thanh Nhận/Bỏ trên từng đoạn (content widget + view zone, `runs.acceptHunk`/`rejectHunk`), vừa đổi sang nút icon ở `c830340`.
- `accept_hunk`/`reject_hunk` có ở `AgentBackend`, `TauriBackend`, `MockBackend`, `RunsService`, lệnh Tauri trong `tasks/changes.rs`, hàm lõi trong `workspace/diff.rs`. Màn Ghép thủ công (`workspace/compose.rs`) không gọi hai lệnh này.
- Khung dưới của panel phải (`features/workbench/terminal.ts`, tên `Terminal`) thật ra là **log** của agent, không phải terminal. Chưa có PTY.
- `workspace/compose.rs::run_check` đã chạy một lệnh của người dùng qua `sh -c` / `cmd /C`, giữ phần cuối output. Chỉ dùng trong Ghép thủ công.
- Bản nháp tạo ở `worktree::create_at`, đặt tại `<repo>/.tg/worktrees/<run>`.
- Có bảng `settings` (key/value) trong SQLite (`store/settings.rs`). Chưa có thiết lập theo dự án.
- Run chuyển về `idle` bằng event `turn_end` (`services/runs/run-events.ts`).

## 3. Việc 1 — Thay đổi kiểu Source Control

### 3.1 Bỏ duyệt từng đoạn

- **[Chủ repo]** Bỏ thanh Nhận/Bỏ trong editor. Giữ vạch màu agent và dấu thay đổi ở lề (cho biết dòng nào agent sửa), giữ con trỏ agent.
- **[Đề xuất]** Gỡ hẳn đường duyệt từng đoạn: `acceptHunk`/`rejectHunk` ở `AgentBackend` (cả hai backend), `RunsService`, lệnh Tauri `accept_hunk`/`reject_hunk` (bỏ khỏi `generate_handler!`), `diff::accept_hunk`/`diff::reject_hunk` và test của chúng, nếu sau khi gỡ không còn chỗ gọi. Hunk id trong `FileDiff` giữ lại nếu Ghép thủ công hoặc editor còn dùng để vẽ dấu.
- Cập nhật tài liệu còn nhắc duyệt từng đoạn (`docs/01-product-spec.md` mục 5.1 dòng "Thanh hunk Accept/Reject", `docs/user-guide.md`, `CLAUDE.md` mục "Thanh hunk trong editor").

### 3.2 Push và Tạo PR

Đặt trong tab Thay đổi, dưới hộp commit, thành một dòng "đồng bộ":

```
nhánh feature/login · ↑2 ↓0 so với origin/feature/login     [Push]  [Tạo PR]
```

- **Thư mục:** luôn là thư mục dự án của người dùng (gốc repo), cả khi run làm trong bản nháp, vì bản nháp phải "Áp vào thư mục" rồi mới commit ở thư mục người dùng.
- **Trạng thái** (lệnh mới, ví dụ `git_sync_status(root)`): nhánh hiện tại, upstream nếu có, số commit lệch (`rev-list --left-right --count @{u}...HEAD`), remote mặc định có hay không, `gh` có cài và có đăng nhập không, remote có phải GitHub không, nhánh mặc định của remote (`origin/HEAD`). Tải lại sau mỗi commit, push, khi mở tab và khi bấm "Tải lại".
- **Push** (lệnh mới `git_push(root)`): có upstream thì `git push`; chưa có thì `git push -u <remote> <nhánh>` (remote là `origin` nếu có, không thì remote duy nhất; nhiều remote mà không có `origin` thì báo lỗi bằng tiếng Việt). Nút ẩn khi HEAD tách rời hoặc repo không có remote; nút tắt khi không có gì để đẩy (↑0 và đã có upstream).
- **Không bao giờ treo:** đặt `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` và có thời hạn **[Đề xuất: 120 s]**. Lỗi xác thực trả về câu tiếng Việt hướng dẫn đăng nhập git/gh trong terminal của app (việc 2) rồi thử lại. Không bao giờ `--force`.
- **Tạo PR** **[Đề xuất]**: chỉ hiện khi `gh` dùng được, remote là GitHub và nhánh hiện tại khác nhánh mặc định. Bấm thì mở một ô nhỏ có tiêu đề (mặc định là dòng đầu của commit cuối) và nội dung (mặc định là phần còn lại của commit cuối, hoặc yêu cầu của cuộc trò chuyện), rồi chạy push nếu còn commit chưa đẩy, sau đó `gh pr create --title … --body … --head <nhánh>`. Thành công thì hiện link và mở bằng trình duyệt (`shell.open` của Tauri qua `AgentBackend`). PR đã có cho nhánh này thì hiện link PR đó thay vì nút (`gh pr view --json url`).
- Nút Push/PR tắt khi agent của run đang chạy, như Commit hiện nay.
- Lệnh dùng `env::command` và `env::login_path`, như mọi tiến trình con.
- Lệnh `git push`, `gh pr` gọi từ app không đi qua `integrations/policy.rs` (policy chặn lệnh của agent, không chặn nút của người dùng).

## 4. Việc 2 — Terminal theo cuộc trò chuyện

### 4.1 Chỗ đặt

- Khung dưới của panel phải đổi thành hai tab: **Log** (khung log hiện có) và **Terminal**. **[Đề xuất]** Tab Terminal chọn mặc định khi người dùng mở khung lần đầu; nhớ tab cuối trong `LayoutService`.
- Mỗi cuộc trò chuyện (`Run.thread`) có một phiên terminal. Đổi cuộc trò chuyện thì khung hiện terminal của cuộc trò chuyện đó; terminal cũ vẫn chạy ngầm, không mất nội dung. Có nút "Mở lại" khi shell đã thoát.
- Terminal chỉ mở khi người dùng mở tab Terminal (lazy), không tạo cho mọi cuộc trò chuyện.

### 4.2 Thư mục và shell

- **Thư mục:** thư mục agent đang làm của run mới nhất trong cuộc trò chuyện: bản nháp nếu làm trong bản nháp, thư mục dự án (đã áp `scope` qua `env::scoped_dir`) nếu làm thẳng. Cuộc trò chuyện chưa có run thì là thư mục dự án đang mở. Terminal không tự đổi thư mục khi run mới có thư mục khác; **[Đề xuất]** hiện một dòng nhắc "Agent đang làm ở <thư mục>. Mở lại terminal ở đó?".
- **Shell:** Windows: `pwsh.exe` nếu `env::which` thấy, không thì `powershell.exe`. macOS/Linux: `$SHELL`, không có thì `/bin/zsh`, chạy dạng login (`-l`) để nạp profile.
- Môi trường: `PATH = env::login_path()`, `TERM=xterm-256color`, thêm `TG_ROOT_PATH` (thư mục dự án gốc) giống script chuẩn bị.

### 4.3 Lõi

- Thư viện **[Đề xuất]** `portable-pty` (ConPTY trên Windows). Module mới `system/pty.rs` (hoặc `workspace/terminal.rs`) với state `Terminals` (id → pty, writer, child).
- Lệnh: `terminal_open(threadId, cwd?, cols, rows) -> id` (đã có thì trả id cũ), `terminal_write(id, data)`, `terminal_resize(id, cols, rows)`, `terminal_close(id)`. Output phát qua event Tauri `terminal-output` `{ id, data }` (chuỗi UTF-8, cắt đúng ranh giới ký tự), thoát thì `terminal-exit` `{ id, code }`.
- Đăng ký PID vào sổ tài nguyên (`system/resources.rs`) dưới cuộc trò chuyện để `ResourceMeter` thấy. Xoá cuộc trò chuyện (`delete_runs`) và tắt app thì kill terminal của nó.
- `env::command` không dùng được với `portable-pty` (nó có `CommandBuilder` riêng); quy tắc "không `Command::new`" vẫn giữ. Trên Windows ConPTY không bật cửa sổ cmd **[Cần kiểm chứng]** trên máy Windows thật; nếu có thì phải xử lý trước khi phát hành.
- Thêm phương thức tương ứng vào `AgentBackend`, cài ở `TauriBackend` và `MockBackend` (mock: shell giả echo lại dòng gõ, đủ cho test và `npm start`).

### 4.4 UI

- `@xterm/xterm` + `@xterm/addon-fit`, tải lazy như Monaco (không vào bundle chính). Màu lấy từ biến CSS trong `styles.scss`, font mono của app. CSS của xterm cần được nạp: kiểm trên bản build, không chỉ `ng serve` (bài học CSS của Monaco).
- Phím ⌘C/⌘V (Ctrl+Shift+C/V trên Windows) chép/dán; không để phím tắt của app (⌘P…) nuốt phím khi terminal đang focus, trừ ⌘P.
- Tên tab: tên shell (`pwsh`, `zsh`) và thư mục ngắn.

## 5. Việc 3 — Hook theo dự án

### 5.1 Thiết lập dự án

- **[Đề xuất]** Lưu trong SQLite của app (bảng `settings`, key `project:<đường dẫn gốc repo đã chuẩn hoá>`, value JSON), không ghi vào repo. Lý do: app không ghi tệp vào repo của người dùng; nhược điểm là không chia sẻ được cho đồng đội (ghi vào danh sách việc sau).
- Nội dung:
  ```json
  { "setup": "cp \"$TG_ROOT_PATH/.env\" . && npm install",
    "check": "npm test",
    "autoFix": true,
    "maxFixRounds": 2 }
  ```
- Chỗ sửa **[Đề xuất]**: mục "Thiết lập dự án" mở từ menu của dự án ở `ThreadList`, một form nhỏ: ô Script chuẩn bị (nhiều dòng), ô Lệnh kiểm tra, công tắc "Gửi lỗi cho agent tự sửa", số vòng tối đa (1–5, mặc định 2). Có ví dụ đặt sẵn làm placeholder, cả macOS (`cp`) và Windows (`Copy-Item` / `copy`).
- Lệnh lõi: `project_settings(root)`, `set_project_settings(root, settings)`; `protocol.ts` khớp struct Rust.

### 5.2 Script chuẩn bị (trước)

- Chạy **một lần** sau khi lõi tạo bản nháp mới (`place = draft`, kể cả mỗi run trong chạy song song) và **trước khi spawn adapter**, không chỉ trước prompt đầu tiên, vì CLI đọc `CLAUDE.local.md`, `.env`… lúc khởi động. Hiện nay `start_task` → `prepare` tạo worktree và spawn adapter liền một mạch rồi mới trả `runId`. **[Đề xuất]** Đổi thành: tạo worktree, ghi run và trả `runId` ngay; script chuẩn bị chạy trong pha nền (`drive_session` hoặc tương đương), xong mới spawn adapter và gửi prompt. Run giữ trạng thái `running` trong lúc chuẩn bị (không thêm trạng thái mới), chat hiện "Đang chuẩn bị bản nháp…". Dừng run trong lúc này thì kill script và dọn như run bị dừng. Bản nháp hỏng ở đường `warm_task` không bị ảnh hưởng vì phiên mở sẵn chỉ dùng cho `direct`. Không chạy khi làm thẳng, khi bước Pipeline dùng lại worktree (`reuse`), khi agent con chạy trong `Place::Snapshot` **[Đề xuất: để sau]**, khi bản nháp tạm của Chỉ hỏi (Gemini/Kiro).
- Cách chạy: như `run_check` (`sh -c` trên macOS, `cmd /C` trên Windows **[Đề xuất: Windows dùng pwsh nếu có, cho khớp terminal; builder cân nhắc]**), `cwd` = bản nháp, env thêm `TG_ROOT_PATH` = thư mục dự án gốc, `TG_WORKTREE_PATH` = bản nháp, `PATH = login_path`. Có thời hạn **[Đề xuất: 10 phút]**, dừng run thì kill script.
- Hiện cho người dùng: output vào log của run (tone riêng, ví dụ `setup`), và một dòng trong chat "Đang chuẩn bị bản nháp…" → "Đã chuẩn bị (12 s)" hoặc "Script chuẩn bị hỏng (mã 1)". Phát qua event mới hoặc event `log` có tone riêng; builder chọn, nhưng phải lưu vào SQLite để lịch sử nạp lại vẫn thấy.
- **[Đề xuất]** Script hỏng thì **dừng** trước khi agent bắt đầu: không spawn adapter, run về `failed` (kết thúc như mọi run lỗi, không hồi sinh) với lỗi rõ ràng kèm phần cuối output và gợi ý "Sửa script ở Thiết lập dự án rồi gửi lại". Không có nút chạy tiếp; người dùng sửa script rồi gửi lại thành run mới. Không âm thầm cho agent chạy tiếp.
- Ghi chú: `node_modules` trong bản nháp làm `diff::pending` chậm nếu không bị bỏ qua; `.gitignore` của repo thường đã loại, builder kiểm lại `diff`/`own_changes` không quét tệp bị ignore.

### 5.3 Vòng kiểm tra (sau)

- **Bước Pipeline** **[Đề xuất]**: có chạy kiểm tra khi bước kết thúc (`exit` của `singleTurn`) và hiện kết quả, nhưng **không tự sửa** (tiến trình đã thoát, không còn phiên để gửi câu). Pipeline vẫn đi tiếp như hiện nay.
- **Khi nào chạy:** khi một run Sửa code (qua ACP, không phải Chỉ hỏi) kết thúc một lượt (`turn_end`, hoặc `exit` của bước Pipeline `singleTurn`) **và** lượt đó có thay đổi tệp (so danh sách tệp thay đổi trước và sau lượt; không có thay đổi thì không chạy) **và** dự án có `check`. Không chạy cho run bị dừng, run lỗi, agent con (cha tự kiểm), run đã bị xoá.
- **Chạy ở đâu:** thư mục của run (bản nháp hoặc thư mục dự án). Dùng lại `compose::run_check` (tách ra chỗ dùng chung), lệnh mới ví dụ `run_project_check(runId)`, lõi tự đọc `check` của dự án để UI không truyền lệnh tuỳ ý. Thời hạn **[Đề xuất: 10 phút]**.
- **Hiện:** một dòng trong chat ngay sau tin nhắn cuối của lượt: "Kiểm tra `npm test`: đang chạy…" → "đạt (8 s)" hoặc "hỏng (mã 1)", bấm vào thì xem phần cuối output. Lưu vào lịch sử như mọi dòng log. Trạng thái thread hiện "Đang kiểm tra" trong lúc chạy.
- **Tự sửa:** hỏng, `autoFix` bật, quyền của run không phải `deny`, và chưa quá `maxFixRounds` vòng liên tiếp: app gửi câu tiếp cho agent qua `send_message`:
  > Lệnh kiểm tra `npm test` của dự án báo lỗi (mã 1). Hãy sửa cho đạt, đừng sửa hay bỏ qua test chỉ để qua. Phần cuối output:
  > ```
  > <tail>
  > ```
  Câu này hiện trong chat như tin nhắn của app (không phải của người dùng), ví dụ nhãn "TG Studio · kiểm tra".
- **Dừng vòng:** đạt; hết số vòng (hiện "Đã thử N lần, vẫn hỏng. Bạn xem giúp."); người dùng gửi tin nhắn hay bấm dừng (đếm vòng về 0); ngân sách đã hết (`budget`). Đếm vòng theo run, đặt lại khi người dùng tự gửi câu.
- **Điều phối:** **[Đề xuất]** phía UI (một service mới cạnh `PipelineService`, ví dụ `CheckService`), vì nó cần biết ai gửi câu cuối và trạng thái stopping; lõi chỉ chạy lệnh. Builder có thể chuyển vào `drive_session` nếu thấy gọn hơn, miễn là lịch sử và mock đều chạy được.
- Chạy song song: mỗi run tự kiểm và tự sửa độc lập; màn So sánh hiện kết quả kiểm tra cuối của từng run **[Đề xuất: để sau nếu tốn]**.

## 6. Ràng buộc chung

- Mọi chuỗi cho người dùng, kể cả lỗi từ Rust, bằng tiếng Việt. CSS chỉ trong `src/styles.scss`, class đặt tên riêng.
- Mọi lệnh mới có ở `AgentBackend`, `TauriBackend`, `MockBackend`, đăng ký trong `generate_handler!`; kiểu ở `protocol.ts` khớp struct Rust.
- Tiến trình con dùng `env::command` + `env::login_path` (trừ PTY, xem 4.3).
- Trước khi xong mỗi việc: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`. Cập nhật `CLAUDE.md` (mục kiến trúc), `docs/user-guide.md`, `docs/02-roadmap.md`, CHANGELOG.
- Thứ tự: việc 1 → việc 2 → việc 3. Mỗi việc một nhánh, merge vào `main` riêng.
- **[Đề xuất]** Nhánh gốc: `c830340` chỉ có trên `claude/ui-polish`, chưa vào `main`, và việc 1 gỡ đúng phần nó thêm. Merge `claude/ui-polish` vào `main` trước (sau khi build và test đạt), rồi các nhánh việc tách từ `main`.

## 7. Phân công Claude / Codex

**[Chủ repo]** "cái nào giao được thì cứ giao cho Codex làm". Codex chạy `codex exec` trong worktree riêng (cách chạy ở `docs/superpowers/plans/2026-11-03-roadmap-master.md`): sandbox không có mạng, không ghi `.git`, không mở cổng localhost; Claude review, chạy lại test ngoài sandbox, commit.

| Phần | Ai | Lý do |
|---|---|---|
| Lõi push/trạng thái/`gh` (3.2) + test trên repo tạm có remote bare | Codex | Module tách biệt, test được bằng repo tạm |
| Lõi PTY (4.3) + test mở shell, ghi, đọc, resize, đóng | Codex | Module tách biệt; cần `cargo` crate mới → Claude tải dependency trước (sandbox không mạng) |
| Lõi thiết lập dự án + chạy script/kiểm tra (5.1, 5.2 phần chạy, `run_project_check`) | Codex | Module tách biệt, test bằng repo tạm |
| Gỡ duyệt từng đoạn (3.1) | Claude | Chạm nhiều lớp và tài liệu |
| UI Source Control, Terminal (xterm), form thiết lập, vòng kiểm tra (`CheckService`), nối setup vào `start_task` | Claude | Cần ngữ cảnh toàn app và kiểm bằng mắt |

## 8. Để builder tự quyết

Tên lệnh, tên module, bố cục chi tiết của dòng đồng bộ và form thiết lập, cách cắt output, tone log mới, cách mock giả lập PTY, có tách `run_check` ra module chung hay không.

## 9. Việc sau

Chia sẻ thiết lập dự án qua tệp trong repo; pull/fetch; script chuẩn bị cho agent con ở `Snapshot`; kết quả kiểm tra trong màn So sánh; terminal cho agent con.
