# Source Control, terminal và hook theo dự án — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tab Thay đổi kiểu Source Control (không duyệt từng đoạn, có Push/Tạo PR), terminal thật theo cuộc trò chuyện, và hook theo dự án (script chuẩn bị bản nháp, vòng kiểm tra sau mỗi lượt).

**Architecture:** Ba module lõi Rust mới, tách biệt, có test riêng (`workspace/sync.rs`, `system/terminal.rs`, `workspace/hooks.rs`), giao cho Codex làm song song. Claude gỡ đường duyệt từng đoạn, nối các module vào luồng chạy (`tasks/mod.rs`) và làm toàn bộ UI.

**Tech Stack:** Tauri 2, Rust (tokio, rusqlite, `portable-pty` mới), Angular 22 signals, `@xterm/xterm` + `@xterm/addon-fit` mới, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-source-control-terminal-hooks-design.md`

## Global Constraints

- Mọi chuỗi cho người dùng, kể cả lỗi Rust trả về, bằng tiếng Việt.
- CSS chỉ trong `src/styles.scss`, class đặt tên riêng (tiền tố `sc-`, `tty-`, `hk-`).
- Lệnh Tauri mới: cài ở `AgentBackend`, `TauriBackend`, `MockBackend`; đăng ký trong `generate_handler!` ở `lib.rs` theo đường dẫn module thật; kiểu ở `protocol.ts` khớp struct Rust `#[serde(rename_all = "camelCase")]`.
- Tiến trình con: `env::command`/`env::std_command` + `.env("PATH", env::login_path())`, không `Command::new` (riêng PTY dùng `CommandBuilder` của `portable-pty`, vẫn đặt PATH).
- Lệnh nhận `root` phải kiểm qua `OpenedProjects` (như `list_project_files`).
- Push: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, thời hạn 120 s, không bao giờ `--force`.
- Script chuẩn bị và lệnh kiểm tra: thời hạn 10 phút; env `TG_ROOT_PATH`, `TG_WORKTREE_PATH`; Windows chạy qua `pwsh -NoProfile -Command` (không có thì `powershell -NoProfile -Command`), macOS/Linux `sh -c`.
- Thiết lập dự án lưu ở bảng `settings`, key `project:<gốc repo đã canonicalize>`; mặc định `autoFix: true`, `maxFixRounds: 2`, giới hạn 1–5.
- Codex chạy trong sandbox không mạng, không ghi `.git`, không mở cổng localhost: dependency phải tải trước, Codex không commit, Claude chạy lại test ngoài sandbox rồi commit.
- Trước khi merge mỗi việc: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)` đều đạt.

## Review Focus

1. Push tới remote cần đăng nhập mà chưa đăng nhập: phải trả lỗi tiếng Việt trong vài giây, không treo. → Task 2, test `push_never_waits_for_credentials`.
2. Terminal nhận output có ký tự nhiều byte (tiếng Việt, emoji) bị cắt giữa hai lần đọc: không được ra ký tự hỏng. → Task 4, test `utf8_chunks_split_on_char_boundary`.
3. Người dùng bấm Dừng khi script chuẩn bị đang chạy: script bị kill, adapter không bao giờ được spawn. → Task 7, test `stop_during_setup_never_spawns_agent`.
4. Vòng kiểm tra khi người dùng gửi tin nhắn giữa lúc kiểm tra đang chạy: kết quả cũ không được gửi cho agent. → Task 8, test `user_message_cancels_pending_fix`.
5. Lượt agent không sửa tệp nào (chỉ trả lời): không chạy kiểm tra. → Task 8, test `no_check_when_turn_changed_nothing`.

---

### Task 0: Đưa `claude/ui-polish` vào `main` (Claude)

- [ ] **Step 1:** Trên `claude/batch-2-design` (đã gồm `ui-polish` + spec + plan): `npm run build && npm test -- --watch=false && (cd src-tauri && cargo test)`. Expected: tất cả đạt.
- [ ] **Step 2:** `git switch main && git merge --no-ff claude/batch-2-design -m "Merge ui-polish and batch 2 design"`. Không push.

### Task 1: Gỡ duyệt từng đoạn (Claude, nhánh `claude/source-control`)

**Files:**
- Modify: `src/app/features/editor/code-editor.ts` (bỏ content widget + view zone của thanh hunk và lời gọi `acceptHunk`/`rejectHunk`; giữ decoration vạch màu, dấu lề, con trỏ agent)
- Modify: `src/app/core/backend.ts`, `src/app/core/mock/mock-backend.ts`, `src/app/services/runs/runs.service.ts` (bỏ `acceptHunk`, `rejectHunk`)
- Modify: `src-tauri/src/tasks/changes.rs`, `src-tauri/src/lib.rs` (bỏ lệnh `accept_hunk`, `reject_hunk`)
- Modify: `src-tauri/src/workspace/diff.rs` (bỏ `accept_hunk`, `reject_hunk` và test của chúng nếu không còn chỗ gọi; giữ hunk id nếu editor/compose còn dùng)
- Modify: `src/styles.scss` (bỏ class của thanh hunk)
- Modify: các spec liên quan (`code-editor.spec.ts`, `runs.service.spec.ts`, `src-tauri/src/tasks/tests.rs`)
- Modify docs: `docs/01-product-spec.md` §5.1, `docs/user-guide.md`, `CLAUDE.md` (mục "Thanh hunk trong editor")

- [ ] **Step 1:** Sửa test editor: thay test bấm nút hunk bằng `it('shows agent marks without hunk buttons')`, khẳng định không có phần tử `.hunk-bar` (hoặc tên class hiện tại) và vẫn có decoration dòng thay đổi.
- [ ] **Step 2:** `npm test -- --watch=false --include src/app/features/editor/code-editor.spec.ts`. Expected: FAIL (nút còn đó).
- [ ] **Step 3:** Gỡ code như danh sách Files. `grep -rn "acceptHunk\|rejectHunk\|accept_hunk\|reject_hunk" src src-tauri/src` không còn kết quả.
- [ ] **Step 4:** `npm run build && npm test -- --watch=false && (cd src-tauri && cargo test)`. Expected: đạt.
- [ ] **Step 5:** Commit `refactor(changes): drop per-hunk approval, keep agent marks`.

### Task 2: Lõi đồng bộ git — push, trạng thái, PR (Codex)

**Files:**
- Create: `src-tauri/src/workspace/sync.rs` (test trong cùng tệp, `#[cfg(test)]`)
- Modify: `src-tauri/src/workspace/mod.rs`, `src-tauri/src/lib.rs` (`generate_handler!`)

**Interfaces — Produces:**
```rust
#[derive(Serialize, Debug, Clone, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub branch: Option<String>,      // None: HEAD tách rời
    pub upstream: Option<String>,    // "origin/feature-x"
    pub ahead: u32, pub behind: u32,
    pub remote: Option<String>,      // remote sẽ push tới: upstream's remote, else "origin", else remote duy nhất
    pub github: bool,                // remote URL là github.com (https hoặc ssh)
    pub gh: bool,                    // `gh auth status` thành công
    pub default_branch: Option<String>, // từ refs/remotes/<remote>/HEAD, bỏ tiền tố
    pub pr_url: Option<String>,      // `gh pr view --json url` cho nhánh hiện tại, khi gh && github
}
pub fn status(root: &Path) -> Result<SyncStatus, String>;
pub async fn push(root: &Path) -> Result<SyncStatus, String>;           // trả trạng thái sau khi push
pub async fn create_pr(root: &Path, title: &str, body: &str) -> Result<String, String>; // URL
pub fn is_github_url(url: &str) -> bool;
#[tauri::command(async)] pub fn git_sync_status(projects: State<OpenedProjects>, root: String) -> Result<SyncStatus, String>;
#[tauri::command(async)] pub async fn git_push(projects: State<'_, OpenedProjects>, root: String) -> Result<SyncStatus, String>;
#[tauri::command(async)] pub async fn create_pr(projects: State<'_, OpenedProjects>, root: String, title: String, body: String) -> Result<String, String>;
#[tauri::command] pub fn open_url(url: String) -> Result<(), String>; // chỉ http(s); macOS `open`, Windows `cmd /C start "" <url>`, Linux `xdg-open`
```
`OpenedProjects::root` hiện là private trong `workspace/project.rs`: đổi thành `pub(crate)`.

Hành vi `push`: chưa có upstream thì `git push -u <remote> <branch>`; có thì `git push`; `remote` None thì `Err("Repo chưa có remote để push.")`; nhiều remote mà không có `origin` và chưa có upstream thì `Err("Repo có nhiều remote nhưng không có origin. Hãy đặt upstream cho nhánh trong terminal.")`; HEAD tách rời thì `Err`. Lỗi xác thực (stderr chứa `Authentication failed`, `could not read Username`, `Permission denied`) → `"Git chưa đăng nhập được remote. Hãy đăng nhập git hoặc gh trong Terminal rồi thử lại."`; quá 120 s → `"Push quá 2 phút, đã dừng."`. `create_pr`: push trước nếu `ahead > 0` hoặc chưa có upstream, rồi `gh pr create --title <t> --body <b> --head <branch>`, trả dòng URL cuối của stdout; `gh` thiếu → `Err("Cần cài và đăng nhập GitHub CLI (gh) để tạo PR.")`.

- [ ] **Step 1: Test** (repo tạm + remote bare `git init --bare` cùng thư mục tạm, như test trong `worktree.rs`):
  - `status_without_remote`: `remote == None`, `upstream == None`, `branch == Some("main")`.
  - `status_counts_ahead_after_local_commit`: clone từ bare, commit 2 lần → `ahead == 2, behind == 0`.
  - `push_sets_upstream_on_first_push`: nhánh mới chưa upstream → sau `push`, `upstream == Some("origin/<nhánh>")`, `ahead == 0`, bare có ref nhánh.
  - `push_without_remote_errors`: `Err` chứa "chưa có remote".
  - `push_with_many_remotes_and_no_origin_errors`: hai remote `a`, `b`, không upstream → `Err` chứa "không có origin".
  - `push_never_waits_for_credentials`: remote `https://127.0.0.1:9/x.git` → `Err` trong < 30 s (đo `Instant`).
  - `github_urls`: `is_github_url` đúng với `https://github.com/a/b.git`, `git@github.com:a/b.git`, `ssh://git@github.com/a/b`; sai với `https://gitlab.com/a/b.git`.
  - `open_url_rejects_non_http`: `open_url("file:///etc/passwd")` là `Err`.
- [ ] **Step 2:** `(cd src-tauri && cargo test --offline sync::)`. Expected: FAIL (module chưa có).
- [ ] **Step 3:** Cài như Interfaces. Gọi git qua `worktree::git` hoặc `env::command("git")` có env đã nêu.
- [ ] **Step 4:** `(cd src-tauri && cargo test --offline sync::)`. Expected: PASS. Rồi `cargo test --offline` toàn bộ (bỏ qua hai test tg-bridge TCP vốn hỏng trong sandbox).
- [ ] **Step 5:** Không commit; báo tệp đã đổi và kết quả test. Claude review, chạy lại ngoài sandbox, commit `feat(sync): git push, status and gh pr commands`.

### Task 3: UI Source Control (Claude, nhánh `claude/source-control`)

**Files:**
- Modify: `src/app/core/protocol.ts` (`SyncStatus`), `src/app/core/backend.ts` (`syncStatus(root)`, `push(root)`, `createPr(root, title, body)`, `openUrl(url)`), `src/app/core/mock/mock-backend.ts` (mock: một remote `origin`, `ahead` tăng sau mỗi commit, push đặt về 0; đường dẫn chứa `noremote` thì không có remote)
- Modify: `src/app/features/changes/diff-viewer.ts`, `diff-viewer.spec.ts`, `src/styles.scss`

**Interfaces — Consumes:** Task 2 lệnh và `SyncStatus`.

- [ ] **Step 1: Test** trong `diff-viewer.spec.ts`:
  - `it('shows branch and ahead count under the commit box')`: mock `ahead: 2` → text chứa `↑2`.
  - `it('pushes and refreshes status')`: bấm Push → `backend.push` được gọi với root của dự án; sau đó text chứa `↑0`.
  - `it('hides push without a remote')`.
  - `it('offers PR only off the default branch with gh')`: `gh: true, github: true, branch: 'feat', defaultBranch: 'main'` → có nút "Tạo PR"; `branch: 'main'` → không có.
  - `it('shows the existing PR link instead of the button')`: `prUrl` có → có link, bấm gọi `openUrl`.
  - `it('disables push while the agent runs')`.
- [ ] **Step 2:** Chạy spec. Expected: FAIL.
- [ ] **Step 3:** Thêm dòng `sc-sync` dưới hộp commit theo spec §3.2; ô PR (tiêu đề = dòng đầu commit cuối, nội dung = phần còn lại hoặc prompt của run) mở tại chỗ. Tải trạng thái khi mở tab, sau commit/push và khi "Tải lại". Root = thư mục dự án (`WorkspaceService`).
- [ ] **Step 4:** Spec đạt; `npm run build`.
- [ ] **Step 5:** Commit `feat(changes): push and create PR from the changes tab`. Merge `claude/source-control` vào `main` sau khi cả ba lệnh kiểm tra đạt.

### Task 4: Lõi terminal PTY (Codex)

Claude làm trước khi giao: thêm `portable-pty = "0.9"` vào `src-tauri/Cargo.toml`, chạy `cargo fetch`, commit vào nhánh `codex/terminal`.

**Files:**
- Create: `src-tauri/src/system/terminal.rs` (test trong tệp)
- Modify: `src-tauri/src/system/mod.rs`, `src-tauri/src/lib.rs` (`.manage(system::terminal::Terminals::default())`, 4 lệnh)
- Modify: `src-tauri/src/system/resources.rs` (`Owner::Terminal(String)`)

**Interfaces — Produces:**
```rust
#[derive(Default)] pub struct Terminals(/* Mutex<HashMap<String, Session>> */);
#[derive(Serialize, Clone)] #[serde(rename_all = "camelCase")] pub struct TerminalInfo { pub id: String, pub shell: String, pub cwd: String, pub fresh: bool }
pub fn shell_for(os_is_windows: bool, shell_env: Option<String>, has_pwsh: bool) -> (String, Vec<String>); // Windows: ("pwsh.exe"|"powershell.exe", ["-NoLogo"]); khác: ($SHELL|"/bin/zsh", ["-l"])
impl Terminals {
    pub fn open(&self, key: &str, cwd: &Path, cols: u16, rows: u16, on_output: impl Fn(String)+Send+'static, on_exit: impl Fn(Option<i32>)+Send+'static) -> Result<TerminalInfo, String>; // key đã sống → trả id cũ, fresh=false
    pub fn write(&self, id: &str, data: &str) -> Result<(), String>;
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String>;
    pub fn close(&self, id: &str) -> Result<(), String>; // kill + bỏ khỏi map; id không có → Ok
}
// Drop của Terminals kill mọi phiên.
#[tauri::command] pub fn terminal_open(app: AppHandle, state: State<Terminals>, key: String, cwd: String, cols: u16, rows: u16) -> Result<TerminalInfo, String>;
// phát "terminal-output" { id, data } và "terminal-exit" { id, code }
#[tauri::command] pub fn terminal_write(state: State<Terminals>, id: String, data: String) -> Result<(), String>;
#[tauri::command] pub fn terminal_resize(state: State<Terminals>, id: String, cols: u16, rows: u16) -> Result<(), String>;
#[tauri::command] pub fn terminal_close(state: State<Terminals>, id: String) -> Result<(), String>;
fn utf8_chunks(pending: &mut Vec<u8>, read: &[u8]) -> String; // trả phần UTF-8 hoàn chỉnh, giữ byte dở lại trong pending
```
Env của shell: `PATH = env::login_path()`, `TERM=xterm-256color`, `TG_ROOT_PATH` không đặt ở lõi (UI truyền cwd). `cwd` không tồn tại → `Err("Thư mục không còn: <cwd>")`. Đăng ký PID vào `resources` với `Owner::Terminal(key)`, gỡ khi thoát.

- [ ] **Step 1: Test:**
  - `shell_for_windows_prefers_pwsh`, `shell_for_windows_falls_back`, `shell_for_unix_uses_env_shell_login`, `shell_for_unix_default_zsh`.
  - `utf8_chunks_split_on_char_boundary`: đưa `"xin chào"` cắt giữa hai byte của `à` qua hai lần gọi → ghép lại đúng `"xin chào"`, không có `\u{FFFD}`.
  - `#[cfg(unix)] open_runs_shell_in_cwd`: `open` với một shell thử (cho phép ghi đè chương trình bằng hàm nội bộ `open_with(program, args, …)` để test dùng `/bin/sh`), ghi `"pwd\n"`, chờ ≤ 5 s tới khi output chứa đường dẫn thư mục tạm.
  - `#[cfg(unix)] open_same_key_returns_same_id`: `fresh == false` lần hai.
  - `#[cfg(unix)] close_ends_the_process`: sau `close`, `on_exit` được gọi trong ≤ 5 s.
  - `open_missing_dir_errors`.
- [ ] **Step 2:** `(cd src-tauri && cargo test --offline terminal::)`. Expected: FAIL.
- [ ] **Step 3:** Cài bằng `portable-pty::native_pty_system()`; luồng đọc là thread chuẩn (đọc blocking), gọi `on_output`.
- [ ] **Step 4:** Test đạt; `cargo test --offline` toàn bộ.
- [ ] **Step 5:** Không commit; báo. Claude review, chạy lại, commit `feat(terminal): pty sessions in the core`.

### Task 5: UI terminal (Claude, nhánh `claude/terminal`)

**Files:**
- Create: `src/app/features/workbench/shell-term.ts` (component xterm), `src/app/features/workbench/xterm.ts` (tải lazy `@xterm/xterm`, `@xterm/addon-fit`, gắn CSS)
- Modify: `src/app/features/workbench/terminal.ts` (khung dưới: tab "Log" | "Terminal"; khung log giữ nguyên trong tab Log), `src/app/services/app/layout.ts` (nhớ tab cuối), `protocol.ts` (`TerminalInfo`), `backend.ts` (`terminalOpen/Write/Resize/Close`, `onTerminalOutput(cb)`, `onTerminalExit(cb)`), `mock-backend.ts` (shell giả: echo dòng gõ, prompt `$ `), `angular.json` (asset CSS xterm nếu esbuild tách CSS như Monaco), `package.json`, `src/styles.scss`
- Modify: nơi xoá cuộc trò chuyện (`ThreadsService`/`RunsService.delete…`) gọi `terminalClose` cho id của thread đó
- Test: `src/app/features/workbench/terminal.spec.ts`

**Interfaces — Consumes:** Task 4. Key = `Run.thread` của run đang chọn; cwd = `AgentBackend` cần đường dẫn làm việc của run: dùng thư mục bản nháp nếu run có worktree (`WorkspaceService` đã biết qua `list_worktree_files`/run detail; nếu chưa có, thêm lệnh nhỏ `run_dir(runId) -> String` trong `tasks/changes.rs` trả `stored_worktree(...).path` hoặc `scoped_dir`), không có run thì thư mục dự án.

- [ ] **Step 1: Test:** `it('opens the terminal of the selected thread lazily')` (mở tab Terminal mới gọi `terminalOpen` một lần với key = thread), `it('keeps one session per thread when switching')` (đổi thread rồi đổi lại: `terminalOpen` trả `fresh: false`, không mở mới), `it('offers reopen after the shell exits')`, `it('closes the thread terminal on delete')`.
- [ ] **Step 2:** Chạy spec. Expected: FAIL.
- [ ] **Step 3:** Cài. Phím: khi xterm focus, chỉ ⌘P (Ctrl+P) đi ra app. Màu theo biến CSS.
- [ ] **Step 4:** `npm test -- --watch=false`; `npm run build` rồi mở bản build (`npm run dev`) kiểm xterm có CSS, gõ `echo $PATH` thấy thư mục nvm/Homebrew.
- [ ] **Step 5:** Commit `feat(terminal): a shell per conversation`. Merge vào `main` khi ba lệnh kiểm tra đạt.

### Task 6: Lõi hook theo dự án (Codex)

**Files:**
- Create: `src-tauri/src/workspace/hooks.rs` (test trong tệp)
- Modify: `src-tauri/src/workspace/compose.rs` (`run_check` gọi `hooks::run_script` với thời hạn hiện có; giữ `CheckResult` ở compose hoặc chuyển sang hooks và re-export), `src-tauri/src/workspace/mod.rs`, `src-tauri/src/lib.rs`

**Interfaces — Produces:**
```rust
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)] #[serde(rename_all = "camelCase", default)]
pub struct ProjectSettings { pub setup: String, pub check: String, pub auto_fix: bool, pub max_fix_rounds: u8 }
impl Default for ProjectSettings { /* "", "", true, 2 */ }
pub fn load(store: &Store, root: &Path) -> ProjectSettings;            // JSON hỏng hoặc chưa có → Default; max_fix_rounds kẹp 1..=5
pub fn save(store: &Store, root: &Path, s: &ProjectSettings) -> Result<(), String>;
pub const HOOK_TIMEOUT: Duration = Duration::from_secs(600);
pub async fn run_script(cwd: &Path, command: &str, env: &[(&str, &Path)], timeout: Duration) -> Result<CheckResult, String>;
pub async fn run_setup(root: &Path, worktree: &Path, command: &str) -> Result<CheckResult, String>; // env TG_ROOT_PATH=root, TG_WORKTREE_PATH=worktree
#[tauri::command(async)] pub fn project_settings(projects: State<OpenedProjects>, store: State<Store>, root: String) -> Result<ProjectSettings, String>;
#[tauri::command(async)] pub fn set_project_settings(projects: State<OpenedProjects>, store: State<Store>, root: String, settings: ProjectSettings) -> Result<(), String>;
#[tauri::command(async)] pub async fn run_project_check(store: State<'_, Store>, run_id: String) -> Result<Option<CheckResult>, String>; // check rỗng → None; cwd = thư mục của run (tasks::changes::stored_worktree → path, đã áp scope cho direct), env TG_ROOT_PATH = repo gốc
```
`run_script` giữ đúng hành vi của `run_check` hiện tại (đọc phần cuối output, kill cây tiến trình khi quá hạn, `kill_on_drop` để huỷ future là kill script), đổi shell: Windows `pwsh -NoProfile -Command` → `powershell -NoProfile -Command`, khác `sh -c`. Key settings: `format!("project:{}", dunce::canonicalize(root)?.display())`.

- [ ] **Step 1: Test:**
  - `settings_default_when_missing`, `settings_roundtrip`, `settings_clamp_rounds` (lưu 9 → load 5; lưu 0 → 1), `settings_bad_json_is_default`.
  - `#[tokio::test] setup_sees_root_and_worktree_env`: `run_setup(root, wt, "echo $TG_ROOT_PATH:$TG_WORKTREE_PATH")` (unix) → output chứa cả hai đường dẫn.
  - `#[tokio::test] setup_can_copy_ignored_file`: root có `.env`, script `cp "$TG_ROOT_PATH/.env" .` → wt có `.env`.
  - `#[tokio::test] script_timeout_kills`: `run_script(dir, "sleep 30", &[], 1s)` → `code == None`, xong trong < 5 s.
  - `#[tokio::test] dropping_script_future_kills_child`: tạo future `sleep 30 && touch done`, huỷ sau 200 ms, đợi 1 s → không có tệp `done`… (dùng `sh -c "sleep 2; touch done"`, huỷ, đợi 3 s, khẳng định không có).
  - Test cũ của `compose` vẫn đạt.
- [ ] **Step 2:** `(cd src-tauri && cargo test --offline hooks::)`. Expected: FAIL.
- [ ] **Step 3:** Cài.
- [ ] **Step 4:** Test đạt; `cargo test --offline` toàn bộ.
- [ ] **Step 5:** Không commit; báo. Claude review, chạy lại, commit `feat(hooks): project settings, setup script and check runner`.

### Task 7: Script chuẩn bị trong luồng chạy + form thiết lập (Claude, nhánh `claude/project-hooks`)

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs` (`prepare`/`start_task_with`/`drive_session`): với `Place::Draft` mới (không `reuse`, không `Snapshot`) và `setup` khác rỗng: tạo worktree, ghi run, trả `runId`; pha nền phát dòng log tone `setup` "Đang chuẩn bị bản nháp…", chạy `hooks::run_setup` trong `tokio::select!` với tín hiệu dừng; đạt → log "Đã chuẩn bị (N s)" rồi spawn adapter như cũ; hỏng → log phần cuối output + `"Script chuẩn bị hỏng (mã X). Sửa script ở Thiết lập dự án rồi gửi lại."`, phát `exit` lỗi, không spawn; dừng → kill script, `exit` như run bị dừng. Dòng log ghi SQLite như mọi dòng.
- Modify: `src-tauri/src/tasks/tests.rs` (test bằng `acp/fake.rs`)
- Modify UI: `protocol.ts` (`ProjectSettings`), `backend.ts` + mock (`projectSettings(root)`, `setProjectSettings(root, s)`), `src/app/layout/thread-list.ts` (mục "Thiết lập dự án" trong menu dự án), create `src/app/features/connections/project-settings.ts` hoặc đặt cạnh thread-list (form theo spec §5.1, placeholder macOS + Windows), `describe-line.ts`/`timeline.ts` (tone `setup` hiện trong chat như dòng trạng thái), `styles.scss`

- [ ] **Step 1: Test Rust:** `setup_runs_before_agent_spawn` (fake agent ghi lại thời điểm spawn; script tạo tệp `ready`; agent thấy `ready` trong cwd), `failed_setup_never_spawns_agent` (script `exit 3` → event `exit` lỗi, fake agent không được spawn, log chứa "mã 3"), `stop_during_setup_never_spawns_agent` (script `sleep 30`, gọi dừng sau 200 ms → `exit` với code null, không spawn, xong < 5 s), `direct_and_reuse_skip_setup`.
- [ ] **Step 2: Test UI:** `project-settings.spec.ts`: lưu form gọi `setProjectSettings` với `maxFixRounds` đã kẹp; `timeline.spec.ts`: dòng tone `setup` không bị gom vào Nhật ký làm việc.
- [ ] **Step 3:** Chạy; Expected: FAIL. Cài. Chạy lại; Expected: PASS.
- [ ] **Step 4:** Ba lệnh kiểm tra đạt.
- [ ] **Step 5:** Commit `feat(hooks): prepare drafts with the project's setup script`.

### Task 8: Vòng kiểm tra sau mỗi lượt (Claude, nhánh `claude/project-hooks`)

**Files:**
- Create: `src/app/services/runs/check.service.ts` + `check.service.spec.ts`
- Modify: `backend.ts` + mock (`runProjectCheck(runId): Promise<CheckResult | null>`; mock: prompt chứa `failcheck` thì hỏng lần đầu, đạt lần hai), `runs.service.ts` (gọi `CheckService` khi run Sửa code chuyển `idle` qua `turn_end` hoặc bước Pipeline `exit`; trạng thái phụ `checking` trên `Run`), `run.ts` (`Run.check?: { state: 'running'|'passed'|'failed'; code: number|null; output: string; round: number }`), `timeline.ts` + component chat hiển thị dòng kiểm tra (bấm xem phần cuối output), `threads` (nhãn "Đang kiểm tra"), `styles.scss`

**Interfaces — Consumes:** Task 6 `run_project_check`, `ProjectSettings`; `RunsService.send(runId, text, { from: 'app' })` (thêm cờ để tin nhắn hiện nhãn "TG Studio · kiểm tra", không tính là người dùng gửi và không đặt lại số vòng).

Quy tắc (spec §5.3): chạy khi lượt có thay đổi tệp (so `getDiff(runId)` theo đường dẫn + số dòng trước/sau lượt; trước = ảnh chụp lúc event `user`); không chạy cho Chỉ hỏi, run dừng/lỗi/đã xoá, agent con (`parent`), dự án không có `check`. Hỏng + `autoFix` + approval ≠ `deny` + `round < maxFixRounds` + còn ngân sách → gửi câu sửa (đúng văn bản ở spec §5.3), `round + 1`. Hết vòng → dòng "Đã thử N lần, vẫn hỏng. Bạn xem giúp.". Người dùng gửi câu hoặc bấm dừng → huỷ lần kiểm tra đang chờ (bỏ kết quả về sau) và `round = 0`. Bước Pipeline: kiểm tra và hiện, không tự sửa.

- [ ] **Step 1: Test** (`check.service.spec.ts`, MockBackend): `runs_check_after_turn_with_changes`, `no_check_when_turn_changed_nothing`, `no_check_without_project_command`, `sends_fix_message_on_failure` (văn bản chứa "Lệnh kiểm tra `npm test`" và phần cuối output), `stops_after_max_rounds` (maxFixRounds 2, hỏng mãi → đúng 2 câu sửa rồi dòng "Đã thử 2 lần"), `user_message_cancels_pending_fix`, `deny_approval_never_auto_fixes`, `pipeline_step_checks_without_fixing`, `child_runs_are_not_checked`.
- [ ] **Step 2:** Chạy; Expected: FAIL. Cài. Chạy lại; Expected: PASS.
- [ ] **Step 3:** Ba lệnh kiểm tra đạt. Thử bằng `npm start` (mock, prompt chứa `failcheck`) thấy dòng kiểm tra hỏng → câu sửa → đạt.
- [ ] **Step 4:** Commit `feat(hooks): check the project after each agent turn`.

### Task 9: Tài liệu và đóng đợt (Claude)

- [ ] **Step 1:** Cập nhật `CLAUDE.md` (mục kiến trúc: Source Control/push, terminal PTY, hook dự án; bỏ dòng thanh hunk), `docs/user-guide.md` (Push/PR, Terminal, Thiết lập dự án), `docs/02-roadmap.md` (mục đợt 2), `CHANGELOG.md` (mục Chưa phát hành), `docs/01-product-spec.md` (bỏ "Thanh hunk Accept/Reject", thêm terminal, push/PR), trạng thái ở đầu spec (đã làm, chỗ làm khác thiết kế).
- [ ] **Step 2:** Ba lệnh kiểm tra đạt trên `main` sau khi merge `claude/project-hooks`.
- [ ] **Step 3:** Commit `docs: source control, terminal and project hooks`. Không push, không chạy workflow, không nâng phiên bản (chủ repo tự quyết khi phát hành).

## Thứ tự và song song

- Task 0 trước hết. Sau đó giao ngay Task 2, 4, 6 cho Codex (ba worktree `codex/sync`, `codex/terminal`, `codex/hooks` từ `main`, chạy song song), trong lúc Claude làm Task 1.
- Task 3 cần Task 2; Task 5 cần Task 4; Task 7 và 8 cần Task 6.
- Merge theo việc: `claude/source-control` (1+2+3) → `claude/terminal` (4+5) → `claude/project-hooks` (6+7+8) → Task 9.
