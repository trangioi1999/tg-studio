# M-D "Tự dùng app" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trên macOS, mở repo `tg-studio` bằng hộp thoại, giao một việc cho Claude và Codex, theo dõi, duyệt, so sánh, nhận một bản và commit mà không rời app.

**Architecture:** Giữ nguyên giao diện hiện tại. Sửa các lỗi lõi trong module sẵn có, thêm `project.rs` cho việc mở thư mục, rồi nối vào UI qua `AgentBackend`.

**Tech Stack:** Tauri 2, Rust, Angular 22 signals, Vitest, `tauri-plugin-dialog` 2.

**Spec:** `docs/superpowers/specs/2026-11-04-chat-first-design.md` (mốc M-D, mục 2, 3, 8.1, 11, 12). Review tham chiếu: `docs/superpowers/specs/2026-11-04-codex-review.md`.

**Thực thi:** Task 1–3 giao Codex, chạy song song trong worktree riêng, không commit; Claude review rồi commit. Task 4–6 do Claude làm. Chủ repo đã giao cách làm này.

## Global Constraints

- Mọi tiến trình con qua `env::command` / `env::std_command`; test `child_processes_start_through_the_helpers` phải xanh.
- Chuỗi hiển thị cho người dùng, kể cả lỗi từ Rust, viết tiếng Việt.
- Thêm phương thức vào `AgentBackend` thì cài ở cả `TauriBackend` và `MockBackend`. Thêm lệnh Tauri thì đăng ký trong `generate_handler!`.
- Kiểu trong `protocol.ts` khớp struct Rust (`#[serde(rename_all = "camelCase")]`).
- Component trong `src/app/shell/` không có style riêng; CSS ở `src/styles.scss`, dùng biến CSS.
- Không đổi bố cục trong M-D. Không làm chat nhiều lượt (M3).
- Trước khi xong: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`.

## Review Focus

1. Thư mục đã lưu bị xoá trước khi mở app → app vào trạng thái chưa chọn thư mục, xoá khoá đã lưu, lần sau không báo lỗi lại. Test ở Task 4.
2. Bấm Hủy trong hộp thoại chọn thư mục → giữ nguyên dự án đang mở, không có lỗi. Test ở Task 4.
3. Agent `git add` hoặc `git commit` sau khi người dùng đã nhận một phần → phần đã nhận không hiện lại, phần chưa nhận vẫn hiện. Test ở Task 2.
4. Mở lại app sau khi chạy Pipeline → mỗi bước vẫn có lịch sử, chi phí, trạng thái riêng. Test ở Task 1.
5. Không có adapter, `npx` hoặc chưa đăng nhập → run hiện lỗi đọc được trong Thread, không treo im lặng. Test ở Task 1 (crash, hết giờ) và kịch bản thật ở Task 6.

---

### Task 1: Sửa lõi phiên ACP (Codex)

**Files:**
- Modify: `src-tauri/src/acp_tasks.rs`, `src-tauri/src/adapters.rs`, `src-tauri/src/acp/client.rs`

**Interfaces:**
- Produces: `prepare(...) -> Result<(String, Worktree, Child), String>`, phần tử đầu là id run mới. `fn turn_outcome(result: &Value) -> (&'static str, Option<String>)`. Hành vi `start_task` với UI không đổi.

- [ ] **Step 1: Viết test đỏ cho id của Pipeline**

Test `reused_worktree_run_keeps_its_own_id`, sửa từ `reused_worktree_survives_a_failed_spawn_and_is_shared`: gọi `prepare` với `reuse = Some(wt)` của run gốc; id trả về khác `wt.run_id`; `store.run_worktree(id)` trả về worktree có `run_id` là run gốc; hàng của run gốc không đổi `status`, `prompt`.

- [ ] **Step 2: Viết test đỏ cho `stopReason`**

Test `turn_outcome_maps_stop_reasons`, assert đúng từng dòng:

| `stopReason` | status | có thông báo |
|---|---|---|
| `end_turn`, thiếu trường, giá trị lạ | `done` | không |
| `cancelled` | `stopped` | không |
| `max_tokens` | `failed` | "Agent dừng vì đã hết giới hạn độ dài trả lời." |
| `max_turn_requests` | `failed` | "Agent dừng vì đã đạt giới hạn số bước trong một lượt." |
| `refusal` | `failed` | "Agent từ chối thực hiện yêu cầu này." |

Thêm test `refusal_turn_is_failed_in_drive` qua agent giả `Step::End("refusal")`: `drive` trả `failed` kèm thông báo.

- [ ] **Step 3: Viết test đỏ cho gói Codex và hẹn giờ**

Trong `adapters.rs`, đổi kỳ vọng của `acp_fallback_uses_pinned_packages` thành `@agentclientprotocol/codex-acp@2.5.0`. Test `setup_timeout_is_longer_through_npx`: `setup_timeout(&PathBuf::from("/bin/npx"))` là 300 s, `setup_timeout(&PathBuf::from("C:\\n\\npx.cmd"))` là 300 s, `setup_timeout(&PathBuf::from("/bin/codex-acp"))` là 60 s.

- [ ] **Step 4: Chạy để xác nhận đỏ**

Run: `(cd src-tauri && cargo test --offline acp_tasks adapters)`. Expected: các test mới FAIL.

- [ ] **Step 5: Cài đặt**

- `prepare` trả về `id` mới; `start_task` dùng id đó làm id run. `wt.run_id` chỉ còn nghĩa chủ worktree; `scope` của tg-bridge giữ `group` hoặc `wt.run_id`.
- `drive` gọi `turn_outcome` trong nhánh `Ok(result)`, vẫn gọi `session.turn_finished`.
- `fn setup_timeout(program: &Path) -> Duration` đặt trong `adapters.rs`, nhận biết `npx` qua `file_stem`. `AcpClient` nhận timeout lúc tạo thay cho hằng `SETUP_TIMEOUT`; test cũ gọi `AcpClient::start` có thể dùng hàm dựng mặc định 60 s.
- Khi chạy qua `npx`: `session.note("Đang chuẩn bị adapter. Lần đầu có thể mất vài phút để tải.")` trước khi khởi tạo.
- Đổi gói Codex thành `@agentclientprotocol/codex-acp@2.5.0`; `binary` giữ `codex-acp`.

- [ ] **Step 6: Chạy toàn bộ**

Run: `(cd src-tauri && cargo test --offline)`. Expected: tất cả PASS, không test nào bị sửa để né lỗi.

---

### Task 2: Hàng chờ duyệt đáng tin cậy (Codex)

**Files:**
- Modify: `src-tauri/src/diff.rs`, `src-tauri/src/acp_tasks.rs` (chỉ thêm lệnh `staged_files`), `src-tauri/src/lib.rs` (đăng ký lệnh)

**Interfaces:**
- Produces: `#[tauri::command] pub fn staged_files(store, run_id: String) -> Result<Vec<String>, String>` trong `acp_tasks.rs`; `diff::staged(repo: &Path) -> Result<Vec<String>, String>`.

**Nguyên nhân:** index của worktree đang vừa giữ phần người dùng đã nhận (`apply --cached`), vừa nhận `git add` của agent, nên `pending` không phân biệt được. `reset --mixed` khi agent commit còn xoá luôn phần đã nhận.

- [ ] **Step 1: Viết test đỏ**

- `agent_staged_changes_stay_pending`: sửa tệp trong worktree, `git add`, `pending` vẫn có đủ hunk.
- `agent_commit_keeps_accepted_hunks_accepted`: có 2 hunk, `accept_hunk` hunk đầu, sửa thêm, `git add -A && git commit` trong worktree; `pending` không có hunk đã nhận, có hunk còn lại; `HEAD` của worktree quay về `base`.
- `agent_stage_after_accept_does_not_reopen_accepted`: như trên nhưng chỉ `git add -A`.
- `accept_all_includes_agent_staged_changes`: agent đã `git add`; `accept_all` áp đủ vào repo.
- `staged_lists_every_staged_file_of_repo`: repo có tệp người dùng tự stage và tệp đã nhận từ run; `staged` trả về cả hai, đã sắp xếp.

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `(cd src-tauri && cargo test --offline diff::)`. Expected: 4 test đầu FAIL hoặc chưa biên dịch được.

- [ ] **Step 3: Cài đặt**

Ghi tree đã nhận vào tệp `tg-accepted` trong git dir của worktree (lấy bằng `git rev-parse --git-path tg-accepted`, để `worktree remove` tự dọn). Sau mỗi `accept_hunk`, `accept_all` thành công: ghi `git write-tree`. Đầu `pending`, theo thứ tự:
1. Nếu `HEAD` khác `base`: `git reset --soft <base>`.
2. Lấy tree đích: nội dung `tg-accepted`, hoặc `<base>^{tree}` nếu chưa có.
3. Nếu `git write-tree` khác tree đích: `git read-tree <tree đích>`. Không dùng `-u`, tệp đang sửa phải giữ nguyên.
4. Rồi `add -N --ignore-removal .` và `git diff` như cũ.

`accept_all` đọc patch sau khi đã gọi `pending`, để phần agent stage cũng vào patch.

- [ ] **Step 4: Chạy toàn bộ**

Run: `(cd src-tauri && cargo test --offline)`. Expected: tất cả PASS.

---

### Task 3: Mở dự án (Codex)

**Files:**
- Create: `src-tauri/src/project.rs`
- Modify: `src-tauri/src/lib.rs` (`mod project`, đăng ký `project::open_project`), `src-tauri/src/worktree.rs` (đổi `root` thành `pub(crate)` nếu cần)

**Interfaces:**
- Produces, serde camelCase:
```rust
pub struct Project { root: String, name: String, branch: Option<String>,
  git: &'static str /* "ready" | "no_commits" | "none" */,
  adjusted: Option<&'static str> /* "subfolder" | "file" */ }
pub fn normalize_path(input: &str, home: Option<&Path>) -> PathBuf;
pub fn open(input: &str) -> Result<Project, String>;
#[tauri::command] pub async fn open_project(path: String) -> Result<Project, String>; // spawn_blocking
```

- [ ] **Step 1: Viết test đỏ `normalize_path_table`**

Với `home = /Users/an`:

| Đầu vào | Kết quả |
|---|---|
| `  /a/b  ` | `/a/b` |
| `"/a b/c"` | `/a b/c` |
| `'/a b/c'` | `/a b/c` |
| `/a/b/` | `/a/b` |
| `/` | `/` |
| `~` | `/Users/an` |
| `~/dự án` | `/Users/an/dự án` |
| `~khac/x` | `~khac/x` |
| `file:///a%20b/d%E1%BB%B1` | `/a b/dự` |

Thêm `#[cfg(windows)]`: `C:/a/b` thành `C:\a\b`; `\\?\C:\a` thành `C:\a`; `\\sv\share\a\` thành `\\sv\share\a`; `file:///C:/a%20b` thành `C:\a b`.

- [ ] **Step 2: Viết test đỏ `open` trên thư mục tạm**

- `open_reports_each_git_state`: repo có commit → `ready`, có `branch`; `git init` chưa commit → `no_commits`; thư mục thường → `none`, `root` là chính nó.
- `open_subfolder_uses_repo_root`: thư mục con → `root` là repo gốc, `adjusted` là `subfolder`.
- `open_file_uses_its_folder`: tệp → thư mục chứa nó, `adjusted` là `file`.
- `open_rejects_missing_with_vietnamese_error`: lỗi chứa "không tồn tại" và đường dẫn, không chứa "Git".
- `open_handles_spaces_and_vietnamese`: `thư mục có dấu cách` có repo → `ready`.
- `#[cfg(unix)] open_rejects_unreadable_folder`: thư mục `chmod 000` → lỗi chứa "quyền"; bỏ qua nếu tiến trình là root.

- [ ] **Step 3: Chạy để xác nhận đỏ**

Run: `(cd src-tauri && cargo test --offline project::)`. Expected: FAIL.

- [ ] **Step 4: Cài đặt**

Kiểm tra `metadata` và `read_dir` trước khi gọi Git, để không ra thông báo sai. Lỗi Git khi dò repo được coi là `none`. `home` lấy từ `detect::home_dir()`. Giải mã `%XX` theo byte rồi UTF-8, không thêm dependency.

- [ ] **Step 5: Chạy toàn bộ**

Run: `(cd src-tauri && cargo test --offline)`. Expected: tất cả PASS.

---

### Task 4: Nối mở dự án vào UI (Claude)

**Files:**
- Modify: `src-tauri/Cargo.toml`, `package.json`, `package-lock.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/lib.rs` (dialog, làm trước khi giao Task 1–3 để Codex có dependency offline)
- Modify: `src/app/core/protocol.ts`, `backend.ts`, `mock-backend.ts`, `workspace.service.ts`, `src/app/shell/title-bar.ts`, `onboarding.ts`, `agent-panel.ts`, `src/styles.scss`
- Test: `src/app/core/workspace.service.spec.ts`, `src/app/core/backend.spec.ts`

**Interfaces:**
- Consumes: `open_project` của Task 3.
- Produces: `AgentBackend.pickFolder(): Promise<string | null>`, `AgentBackend.openProject(path: string): Promise<Project>`. `WorkspaceService.project: Signal<Project | null>`, `WorkspaceService.folderError: Signal<string | null>`, `WorkspaceService.pickFolder(): Promise<void>`, `setFolder(path): Promise<boolean>`.

- [ ] **Step 1: Viết test đỏ `workspace.service.spec.ts`**

Backend giả:
- `setFolder('/missing')` lỗi → `false`, `folderError` có nội dung, `folder` và `localStorage` giữ giá trị cũ.
- Mở lần đầu, `tg.repo` trỏ tới thư mục đã mất → `folder` rỗng, `folderError` null, khoá đã xoá.
- Không có `tg.repo` → `folder` rỗng, không gọi `homeDir`.
- `pickFolder` với `null` → không đổi gì, không lỗi.
- `setFolder('/x')` với `git: 'none'` → `folder` là `/x`, `repo()` null. Với `no_commits` → `repo()` có giá trị, `project().git` đúng.
- Lưu `project.root`, không lưu chuỗi người dùng gõ.
- Hai lần `setFolder` chồng nhau → kết quả của lần sau thắng.

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `npm test -- --watch=false --include src/app/core/workspace.service.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Cài đặt backend và service**

`MockBackend.openProject`: đường dẫn chứa `missing` thì lỗi; chứa `nogit` thì `none`; chứa `nocommit` thì `no_commits`; còn lại `ready`. `pickFolder` mock trả `/Users/you/projects/demo`.

- [ ] **Step 4: Cài đặt UI**

- Thanh tiêu đề: nút **Mở thư mục** gọi hộp thoại, luôn thấy; nút tên dự án vẫn mở ô gõ. Lỗi: ô gõ giữ mở, hiện `folderError` với `role="alert"`. Nhãn: chỉ `none` mới ghi "không phải repo Git"; `no_commits` ghi "chưa có commit"; chưa chọn thì không có nhãn.
- Onboarding bước 3: thêm nút Chọn thư mục, hiện đúng trạng thái theo `project().git`.
- `AgentPanel.blocked`: `no_commits` ở chế độ Sửa code → "Sửa code cần ít nhất một commit: hãy commit trong dự án, hoặc dùng Chỉ đọc."
- Trên Explorer khi chưa có dự án: nút **Mở thư mục** thay cho đoạn hướng dẫn.

- [ ] **Step 5: Chạy toàn bộ và commit**

Run: `npm run build && npm test -- --watch=false`. Expected: PASS.

---

### Task 5: Sửa UI còn lại (Claude)

**Files:**
- Modify: `src/app/core/runs.service.ts`, `backend.ts`, `mock-backend.ts`, `protocol.ts`, `src/app/shell/agent-panel.ts`, `diff-viewer.ts`, `src/styles.scss`
- Test: `src/app/core/runs.service.spec.ts`, Create: `src/app/shell/agent-panel.spec.ts`

**Interfaces:**
- Consumes: `staged_files` của Task 2.
- Produces: `RunsService.now: Signal<number>`, `AgentBackend.stagedFiles(runId: string): Promise<string[]>`.

- [ ] **Step 1: Viết test đỏ**

- `agent-panel.spec.ts`, `does not start twice while sending`: `startTask` là promise treo, gọi `send()` 2 lần → `startTask` được gọi 1 lần; sau khi xong, prompt đã xoá. Trong lúc gửi, `canRun()` là false.
- `agent-panel.spec.ts`, `shows the pipeline start error`: `PipelineService.start` trả pipeline `failed` chưa có run → `error()` chứa lý do, prompt còn nguyên (review #11).
- `runs.service.spec.ts`, `now ticks only while a run is running` với fake timers: không có run đang chạy thì `now` đứng yên; có thì tăng sau 1 s; xong thì lại đứng yên.

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `npm test -- --watch=false --include src/app/shell/agent-panel.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Cài đặt**

- `AgentPanel`: signal `sending`, `canRun` tính cả nó, chặn sớm trong `send()`.
- `duration(r)` dùng `runs.now()`.
- `DiffViewer`: bỏ bộ đếm `accepted`; mỗi lần `load` gọi `stagedFiles`, ô Commit hiện khi danh sách khác rỗng, liệt kê tệp, kèm câu: "Commit sẽ gồm mọi tệp đang staged trong dự án, kể cả tệp bạn tự stage." `MockBackend.stagedFiles` trả tệp đã nhận, xoá sau commit.

- [ ] **Step 4: Chạy toàn bộ và commit**

Run: `npm run build && npm test -- --watch=false`. Expected: PASS.

---

### Task 6: Nghiệm thu thật và dọn tài liệu (Claude + chủ repo)

**Files:**
- Modify: `docs/02-roadmap.md`, `docs/07-release.md`, `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1:** Bắt tay ACP với `@agentclientprotocol/codex-acp@2.5.0`, không gửi prompt. Expected: có `protocolVersion`.
- [ ] **Step 2:** Playwright mock: `Mở thư mục`, đường dẫn chứa `missing`, `nogit`, `nocommit`, bấm Chạy nhanh hai lần, đồng hồ tăng.
- [ ] **Step 3:** Chạy kịch bản M-D ở mục 12 của spec bằng `npm run dev`, với việc nhỏ trong một nhánh thử. Tốn token. Ghi lại lỗi gặp phải, sửa theo systematic-debugging.
- [ ] **Step 4:** Cập nhật tài liệu: thêm mốc vào roadmap; sửa `version:sync` trong `07-release.md`; ghi `project.rs`, `tg-accepted` vào `CLAUDE.md`; `CHANGELOG`.
- [ ] **Step 5:** Chạy đủ `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`. Tạo PR.
