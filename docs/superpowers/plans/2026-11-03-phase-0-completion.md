# Hoàn tất Giai đoạn 0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đóng các việc còn lại của GĐ0: có git + CI hai hệ điều hành, lịch sử lượt chạy còn nguyên sau khi mở lại app, và parser được kiểm chứng bằng output thật của CLI.

**Architecture:** Lõi Rust ghi mọi lượt chạy vào SQLite ngay khi event phát sinh; UI nạp lại lịch sử lúc khởi động qua `AgentBackend`. Schema là tập con tương thích với Usage Ledger trong `docs/04-usage-and-cost.md` để GĐ3 mở rộng tiếp.

**Tech Stack:** Rust + `rusqlite` (feature `bundled`), Tauri 2, Angular 22 signals, Vitest, GitHub Actions.

**Spec:** `docs/02-roadmap.md` (GĐ0), `docs/04-usage-and-cost.md` §4, `docs/03-agent-integration.md` §9. Lộ trình tổng và quy tắc giao việc: `2026-11-03-roadmap-master.md`.

## Global Constraints

- Tuân theo `AGENTS.md`: signals, không NgModules/zone.js, không gọi `invoke` trong component, `protocol.ts` khớp struct Rust (`camelCase`).
- Timestamp là mili giây Unix; chuỗi hiển thị cho người dùng viết tiếng Việt.
- Lỗi ghi SQLite không bao giờ được làm hỏng lượt chạy: ghi `eprintln!` rồi đi tiếp.
- Không push lên remote và không tạo repo GitHub: đó là quyết định của chủ repo.
- Ghi lại CLI thật: chỉ dùng yêu cầu chỉ-đọc, và lọc thông tin cá nhân khỏi fixture trước khi commit.

## Review Focus

1. App bị tắt hoặc crash khi run đang chạy: mở lại không được hiện "đang chạy" mãi (Task 3 — `mark_interrupted`).
2. File DB hỏng hoặc không mở được: app vẫn chạy, chỉ mất lịch sử (Task 3 — fallback in-memory).
3. Lịch sử cũ không được cộng vào khung "USAGE · PHIÊN NÀY" (Task 3 — test `restored`).
4. Dòng log và usage đến sau event `exit`: vẫn được lưu, không mất số liệu của dòng cuối (Task 2 — test thứ tự).
5. Prompt có dấu, đường dẫn có dấu cách, run rất nhiều dòng: lưu đúng và chỉ nạp 2000 dòng cuối (Task 2).

---

### Task 1: Git, CI và dependency (Owner: Claude)

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `CLAUDE.md`

**Interfaces:**
- Produces: nhánh `main` có commit gốc; `rusqlite` đã tải sẵn để Codex build `--offline` trong sandbox.

- [ ] **Step 1:** `git init -b main`, commit toàn bộ mã hiện có. Kiểm tra `git status --ignored` không chứa `dist`, `node_modules`, `target`, `.angular`, `.DS_Store`.
- [ ] **Step 2:** Thêm `rusqlite = { version = "*bản mới nhất*", features = ["bundled"] }`, chạy `cargo fetch`.
- [ ] **Step 3:** Viết `ci.yml`: push + pull_request, matrix `macos-latest` và `windows-latest`; Node 24, Rust stable; theo thứ tự `npm ci`, `npm run build`, `npm test -- --watch=false`, `cargo test` trong `src-tauri`.
- [ ] **Step 4:** Xác minh: `npx --yes js-yaml .github/workflows/ci.yml` parse được. Expected: in ra cấu trúc, không lỗi.
- [ ] **Step 5:** Commit `chore: add CI and rusqlite dependency`.

### Task 2: `store.rs` — lưu trữ SQLite (Owner: Codex)

**Files:**
- Create: `src-tauri/src/store.rs` (test nằm cùng file)
- Modify: `src-tauri/src/lib.rs` (chỉ thêm `mod store;`, kèm `#![allow(dead_code)]` trên khai báo mod cho đến khi Task 3 nối vào)

**Interfaces:**
- Consumes: `AgentKind`, `Usage { input_tokens, cached_input_tokens, output_tokens, cost_usd, source: &'static str, cumulative }`.
- Produces:
```rust
pub struct Store(Mutex<Connection>);
pub struct NewRun<'a> { pub id: &'a str, pub agent: AgentKind, pub prompt: &'a str, pub cwd: &'a str, pub started_at: u64 }
#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")]
pub struct StoredLine { pub kind: String, pub line: String }
#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")]
pub struct StoredRun { pub id: String, pub agent: AgentKind, pub prompt: String, pub cwd: String,
  pub started_at: u64, pub ended_at: Option<u64>, pub status: String, pub exit_code: Option<i32>,
  pub usage: Option<Usage>, pub lines: Vec<StoredLine> }
impl Store {
  pub fn open(path: &Path) -> rusqlite::Result<Store>;   // tạo thư mục cha, WAL, migrate
  pub fn open_in_memory() -> rusqlite::Result<Store>;
  pub fn insert_run(&self, run: &NewRun) -> rusqlite::Result<()>;   // status = "running"
  pub fn append_line(&self, run_id: &str, kind: &str, line: &str, at: u64) -> rusqlite::Result<()>;
  pub fn add_usage(&self, run_id: &str, at: u64, usage: &Usage) -> rusqlite::Result<()>;
  pub fn finish_run(&self, run_id: &str, status: &str, code: Option<i32>, at: u64) -> rusqlite::Result<()>;
  pub fn mark_interrupted(&self) -> rusqlite::Result<usize>;  // running → interrupted
  pub fn list_runs(&self, limit: usize) -> rusqlite::Result<Vec<StoredRun>>;  // mới nhất trước
}
```

**Schema** (`PRAGMA user_version = 1`; bật `foreign_keys`):
- `runs(id PK, agent, prompt, cwd, status, exit_code, started_at, ended_at, model NULL, step NULL, worktree NULL, task_id NULL)`
- `usage_events` đúng như `docs/04-usage-and-cost.md` §4
- `run_lines(id INTEGER PK, run_id REFERENCES runs, kind, line, at)` + index theo `run_id`

- [ ] **Step 1: Viết test trước** trong `#[cfg(test)]`:
  - `reopen_keeps_runs`: `open` file tạm, ghi run, đóng, `open` lại vẫn đọc được.
  - `usage_replays_cumulative_and_incremental`: hai event `cumulative=false` (10/1/2 và 5/1/1) cộng thành 15/2/3; thêm event `cumulative=true` (100/0/9, cost 0.5) thì thay thế, `cost_usd == Some(0.5)`.
  - `incremental_cost_stays_none`: chỉ có event cost `None` → kết quả `None`, `source == "tokens"`.
  - `lines_after_finish_are_kept`: `finish_run` rồi `append_line` và `add_usage` vẫn xuất hiện; status không đổi.
  - `only_last_2000_lines_in_order`: 2005 dòng → 2000 dòng, dòng đầu là `line-5`, dòng cuối `line-2004`.
  - `mark_interrupted_only_touches_running`: run `done` giữ nguyên, run `running` thành `interrupted`, trả về `1`.
  - `list_is_newest_first_and_limited`: 3 run, `limit=2` → hai run mới nhất theo `started_at`.
  - `unicode_round_trip`: prompt `Giải thích ✓`, cwd `/tmp/thư mục có dấu cách` đọc lại nguyên vẹn.
- [ ] **Step 2:** `cd src-tauri && cargo test --offline store::` — Expected: FAIL/không biên dịch.
- [ ] **Step 3:** Cài đặt. `source` khi đọc lại ánh xạ `"reported"` → `"reported"`, còn lại → `"tokens"` để giữ kiểu `&'static str`. Cộng dồn usage theo đúng quy tắc của `mergeUsage` trong `runs.service.ts`.
- [ ] **Step 4:** `cargo test --offline` — Expected: toàn bộ PASS, không warning mới.
- [ ] **Step 5:** Không tự commit (sandbox Codex không ghi được `.git`). Claude review rồi commit `feat(core): add SQLite run store`.

### Task 3: Nối store vào lõi và UI (Owner: Claude)

**Files:**
- Modify: `src-tauri/src/runner.rs`, `src-tauri/src/lib.rs`
- Modify: `src/app/core/protocol.ts`, `backend.ts`, `mock-backend.ts`, `runs.service.ts`, `src/app/shell/run-console.ts`, `status-bar.ts` nếu cần
- Create: `src/app/core/runs.service.spec.ts`

**Interfaces:**
- Consumes: `Store` từ Task 2.
- Produces: lệnh Tauri `list_runs() -> Vec<StoredRun>` (giới hạn 100); `AgentBackend.listRuns(): Promise<StoredRun[]>`; `Run.restored: boolean`; `RunStatus` thêm `'interrupted'`.

- [ ] **Step 1: Viết test** `runs.service.spec.ts` với backend giả:
  - hydrate: run `done` có dòng `log`/`stderr`/`started` hiện đúng tone, `selectedId` là run mới nhất.
  - `restored runs are excluded from usageByAgent and totals`.
  - `live event wins over late hydration`: event đến trước khi `listRuns` resolve thì không bị ghi đè.
  - `interrupted run is not counted in running`.
- [ ] **Step 2:** `npm test -- --watch=false --include src/app/core/runs.service.spec.ts` — Expected: FAIL.
- [ ] **Step 3:** Cài phía Angular: `RunsService.hydrate()` gọi trong constructor; tách hàm đổi `{kind, line}` thành `ConsoleLine` dùng chung cho event trực tiếp và lịch sử; `listRuns` lỗi thì bỏ qua, không chặn UI. Thêm nhãn cho `interrupted` trong `run-console.ts`: `gián đoạn`.
- [ ] **Step 4:** Cài phía Rust: `setup` mở `app_data_dir()/tg-studio.db`, lỗi thì `eprintln!` và dùng `open_in_memory`; luôn gọi `mark_interrupted`. `start_agent` gọi `insert_run` trước khi spawn task đọc; ghi `started`/`log`/`stderr`, `add_usage`; kết thúc: stop → `stopped`, code 0 → `done`, còn lại → `failed`.
- [ ] **Step 5:** `npm test -- --watch=false` và `cargo test` — Expected: PASS.
- [ ] **Step 6:** Commit `feat: persist run history across restarts`.

### Task 4: Contract test bằng output thật (Owner: Claude ghi fixture, Codex viết test)

**Files:**
- Create: `src-tauri/tests/fixtures/claude/<version>/readonly.jsonl`, `src-tauri/tests/fixtures/codex/<version>/readonly.jsonl`
- Modify: `src-tauri/src/usage.rs` (chỉ khối test)
- Create: `src/app/core/describe-line.spec.ts`

**Interfaces:**
- Consumes: `usage::parse_line`, `describeLine`. `usage.rs` là mod riêng tư nên test nằm trong crate, đọc fixture bằng `include_str!`.

- [ ] **Step 1 (Claude):** Chạy mỗi CLI một yêu cầu chỉ-đọc, lọc khỏi fixture mọi đường dẫn nhà, email, session id, danh sách tool/plugin.
- [ ] **Step 2 (Codex):** Test `claude_fixture_usage`, `codex_fixture_usage`: chạy `parse_line` trên mọi dòng, so số với giá trị đọc từ dòng `result`/`turn.completed` trong fixture. Phải có đúng số event usage như fixture.
- [ ] **Step 3 (Codex):** `describe-line.spec.ts`: mỗi agent phủ dòng text, tool, kết thúc, dòng lỗi, dòng không phải JSON, và type lạ phải rơi về `[type]`.
- [ ] **Step 4:** `cargo test --offline usage::` và `npm test -- --watch=false --include src/app/core/describe-line.spec.ts` — Expected: PASS. Nếu test lộ parser sai với output thật: báo lại, không sửa test cho khớp.
- [ ] **Step 5:** Claude review rồi commit `test: add CLI contract fixtures`.

### Task 5: Nghiệm thu GĐ0 (Owner: Claude, Codex review chéo)

**Files:** Modify: `docs/02-roadmap.md`, `CLAUDE.md`

- [ ] **Step 1:** `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`, `npm run build:app` — Expected: tất cả exit 0.
- [ ] **Step 2:** Mở bản build, kiểm tra app chạy; xác minh file `tg-studio.db` có dữ liệu sau một lượt chạy thật nếu tự động hóa được, nếu không thì ghi rõ phần nào chưa kiểm được.
- [ ] **Step 3:** `codex exec -s read-only` review toàn bộ diff so với commit gốc; xử lý phát hiện đúng.
- [ ] **Step 4:** Đánh dấu roadmap: chỉ tick việc thực sự đã kiểm chứng. Windows chưa chạy thật thì giữ `[ ]`.
- [ ] **Step 5:** Commit `docs: update phase 0 status`.
