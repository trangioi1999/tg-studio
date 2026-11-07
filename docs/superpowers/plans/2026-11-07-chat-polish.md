# Chat mượt hơn: gửi không đơ, xoá cuộc trò chuyện, làm mới hạn mức, hỏi xong làm luôn

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sửa 4 chỗ chủ repo gặp khi dùng thật (2026-11-07): bấm gửi thì màn hình đứng vài giây; không xoá được cuộc trò chuyện; hạn mức chỉ cập nhật khi chat; đang Chỉ hỏi muốn agent làm luôn thì phải tự đổi chế độ.

**Tech Stack:** Tauri 2, Rust, Angular 22 signals, Vitest.

## Phân công

| Task | Owner | File được sửa | Phụ thuộc |
|---|---|---|---|
| T1 Gửi không đơ | Claude | `agent-panel.ts`, `runs.service.ts`, `styles.scss` + spec | — |
| T2 Làm mới hạn mức | Claude | `status-bar.ts`, `runs.service.ts` + spec | T1 (cùng `runs.service.ts`, làm nối tiếp) |
| T3 Lõi xoá cuộc trò chuyện | **Codex** | `store.rs`, `acp_tasks.rs` | — (song song với T1, T2) |
| T4 UI xoá cuộc trò chuyện | Claude | `lib.rs`, `backend.ts`, `mock-backend.ts`, `threads.service.ts`, `thread-list.ts`, `styles.scss` + spec | T3 |
| T6 Hạn mức Claude không cần chat | **Codex** | `claude_usage.rs` (mới), `Cargo.toml`, dòng `mod` trong `lib.rs` | — |
| T5 Chỉ hỏi → làm luôn | Claude | `runner.rs`/`usage.rs` (nếu cần), `runs.service.ts`, `agent-panel.ts` | T1, kiểm chứng live trước |

Quy tắc như `2026-11-03-roadmap-master.md`: Claude review và commit việc của Codex; không sửa test để né lỗi.

## Global Constraints

- Chuỗi hiển thị viết tiếng Việt, kể cả lỗi Rust.
- Thêm phương thức vào `AgentBackend` thì cài ở cả `TauriBackend` và `MockBackend`; lệnh Tauri mới đăng ký trong `generate_handler!`.
- Không dùng `confirm()`/`alert()` của trình duyệt: xác nhận hiện ngay trong giao diện.
- Trước khi xong: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`.

## T1 — Gửi không đơ

**Hiện trạng:** `AgentPanel.send()` chờ `start`/`startTask`/`sendMessage` (spawn CLI hoặc mở phiên ACP, 1–10 s, lần đầu tải adapter còn lâu hơn). Trong lúc đó chỉ có cờ `sending` khoá nút gửi: chữ vẫn nằm trong ô, tin nhắn chưa hiện, không có gì báo đang chạy.

- [ ] `RunsService.pending` (signal): `{ thread: string | null; agent; text; at } | null`, đặt ngay khi bấm gửi, xoá khi event đầu tiên của run đó đến (`started`/`user`) hoặc khi `send` lỗi.
- [ ] `AgentPanel`: xoá ô chat ngay khi bấm gửi; khung chat hiện tin nhắn của người dùng + dòng "Đang khởi động {agent}…" có chấm nhấp nháy (CSS, tôn trọng `prefers-reduced-motion`). Cuộc trò chuyện mới (chưa có run) cũng hiện khung này thay cho màn trống.
- [ ] Lỗi khi gửi: trả chữ về ô chat, hiện lỗi như cũ, bỏ `pending`.
- [ ] Sau khi lượt đã chạy mà agent chưa có dòng nào: giữ "Đang nghĩ…" (chấm nhấp nháy) cho tới chữ đầu tiên.
- [ ] Spec: gửi → tin nhắn hiện trước khi `startTask` resolve; `startTask` reject → ô chat có lại chữ.

## T2 — Làm mới hạn mức

**Hiện trạng:** `account_limits` (`store.rs:517`) đã đọc hạn mức Codex mới nhất từ `~/.codex/sessions`, nhưng UI chỉ gọi một lần lúc mở app (`RunsService.loadLimits`). Claude chỉ có số từ `rate_limit_event` trong lượt chạy; chưa có nguồn nào khác đã kiểm chứng.

- [ ] Gọi lại `loadLimits()` khi cửa sổ được focus lại (tối đa một lần mỗi 30 s) và mỗi 5 phút khi app đang mở.
- [ ] Bấm vào ô hạn mức ở `StatusBar` thì tải lại ngay; tooltip ghi "Cập nhật lúc HH:MM" và nguồn (Codex: nhật ký phiên của Codex, cả khi chạy ngoài app; Claude: lượt chạy gần nhất trong app).
- [ ] Spec: focus cửa sổ gọi `accountLimits`; hai lần focus trong 30 s chỉ gọi một lần.

Ghi chú (2026-11-07): `StatusBar` đã gọi `loadLimits()` mỗi 60 s, nên số Codex đã tự mới. Phần thiếu là Claude, xem T6.

## T6 — Hạn mức Claude không cần chat (Codex)

**Đã kiểm chứng (Claude Code 2.1.319):** `claude -p "/usage" --output-format json` là lệnh cục bộ: `num_turns: 0`, `total_cost_usd: 0`, `local_command: "usage"`, không tốn token, ~3–5 s. Trường `result` là chữ, ví dụ `Current session: 8% used · resets Nov 7 at 6:59pm (Asia/Saigon)` và `Current week (all models): 18% used · resets Nov 9 at 3:59am (Asia/Saigon)`. Fixture: `src-tauri/tests/fixtures/claude/2.1.319/usage-command.json`.

- [ ] `Cargo.toml`: thêm `chrono = { version = "0.4", default-features = false, features = ["clock", "std"] }` (đã có trong `Cargo.lock`, build `--offline` được).
- [ ] Module mới `src-tauri/src/claude_usage.rs` (khai báo `mod claude_usage;` trong `lib.rs`, không sửa gì khác ở `lib.rs`):
  - `pub fn parse_usage_text(text: &str, now: chrono::DateTime<chrono::Local>) -> Option<Vec<LimitWindow>>`: mỗi dòng `<tên>: <n>% used · resets <Mon> <d> at <h:mm><am|pm> (<tz>)` thành một `LimitWindow`. `Current session` → id `five_hour`; `Current week (all models)` → `seven_day`; `Current week (<x> only)` → `seven_day_<x viết thường, khoảng trắng thành _>`. `utilization = n / 100`, `status = None`. `resets_at`: hiểu ngày giờ theo giờ máy (`Local`; tên vùng trong ngoặc là vùng của máy), năm là năm hiện tại, nếu ra thời điểm sớm hơn `now` quá 1 ngày thì cộng 1 năm. Dòng không có `resets …` thì `resets_at = None`. Không có dòng nào khớp (ví dụ đang dùng API key) → `None`.
  - `pub fn parse_usage_output(json: &str, now) -> Option<Vec<LimitWindow>>`: chỉ nhận khi `type == "result"`, `is_error == false`, `local_command == "usage"`; đọc `result` rồi gọi hàm trên.
  - `#[tauri::command] pub async fn refresh_claude_limits(store: State<'_, Store>) -> Result<Option<AccountLimits>, String>`: tìm `claude` bằng `env::which`, chạy bằng `env::command` với `.env("PATH", env::login_path())`, thư mục làm việc là thư mục home, stdin null, tham số `-p /usage --output-format json`, timeout 30 s (kill khi quá). Gọi lại trong vòng 60 s kể từ lần chạy trước thì trả về số đã lưu, không spawn. Có số thì `store.set_limits(AgentKind::Claude, &windows, now_ms)` và trả về `AccountLimits` của Claude. Không có `claude` hoặc không đọc được số → `Ok(None)`. Lỗi spawn/timeout → `Err` tiếng Việt.
- [ ] Test (`#[cfg(test)]` trong module): fixture thật → 2 cửa sổ đúng id, `utilization` 0.08 và 0.18, `resets_at` đúng giờ địa phương; dòng `Current week (Sonnet only)`; 12:05am và 12:05pm; ngày đã qua đầu năm (now = 31/12, reset 2/1 → năm sau); output API key không có dòng nào → `None`; `is_error: true` → `None`.
- [ ] UI (Claude làm sau): gọi lúc mở app, khi bấm ô hạn mức, và mỗi 5 phút.

## T3 — Lõi xoá cuộc trò chuyện (Codex)

Xoá là **ẩn khỏi lịch sử và dọn nơi làm việc**, không làm sai số chi phí: bảng `usage_events` giữ nguyên để màn Usage không đổi tổng.

**Store (`store.rs`)**
- [ ] Migration lên `user_version = 8`: `ALTER TABLE runs ADD COLUMN deleted_at INTEGER`.
- [ ] `list_runs` bỏ các run có `deleted_at`. Màn Usage (`usage_report` trong `ledger.rs`) vẫn tính run đã xoá; kiểm tra truy vấn hiện tại và thêm test nếu nó lọc theo `runs`.
- [ ] `Store::delete_runs(ids: &[String], at: u64) -> Result<()>`: trong một transaction, đặt `deleted_at`, xoá `run_lines` của các run đó, xoá worktree khỏi sổ (`worktree = NULL, branch = NULL, base = NULL, worktree_owner = NULL`).
- [ ] Test: run bị xoá không còn trong `list_runs`, không còn dòng log; tổng usage trước và sau như nhau; migration từ DB v7 có sẵn dữ liệu không mất dòng nào.

**Lệnh (`acp_tasks.rs`)**
- [ ] `#[tauri::command] pub async fn delete_runs(store, tasks: State<TaskRuns>, runs: State<Runs>, run_ids: Vec<String>) -> Result<(), String>`:
  1. Run nào đang bận (`tasks.busy(id)`) → `Err("Hãy dừng agent trước khi xoá cuộc trò chuyện.")`. Không đổi gì.
  2. Gửi tín hiệu dừng cho mọi run còn trong `runs.0` (phiên rảnh của Sửa code và phiên Chỉ hỏi của Claude), chờ tối đa 5 s cho tới khi `tasks` không còn giữ chúng, giống `discard_worktree`.
  3. Với mỗi worktree khác nhau của các run (`stored_worktree`): nếu `runs_sharing_worktree` có run **ngoài** danh sách thì bỏ qua; không thì `worktree::remove(&repo, &wt, true)`. Bản direct chỉ xoá tệp sổ sách (hành vi sẵn có của `worktree::remove`), không bao giờ đụng repo. Lỗi xoá worktree không chặn bước 4, nhưng gom lại và trả về sau cùng: `"Đã xoá cuộc trò chuyện, nhưng chưa dọn được bản nháp: …"`.
  4. `store.delete_runs(&run_ids, now_ms)`.
- [ ] Test với repo tạm: xoá một run có bản nháp → thư mục worktree và nhánh mất, repo gốc không đổi; xoá một run direct → tệp trong repo không đổi; run đang bận → lỗi và không đổi gì.
- [ ] **Không** sửa `lib.rs`, `backend.ts` hay file TypeScript nào (Claude nối ở T4).

## T4 — UI xoá cuộc trò chuyện

- [ ] Đăng ký `acp_tasks::delete_runs` trong `lib.rs`; `AgentBackend.deleteRuns(runIds)` ở cả hai backend (mock xoá khỏi danh sách đã lưu).
- [ ] `ThreadsService.remove(thread)`: gọi `deleteRuns` với mọi run của thread, rồi bỏ chúng khỏi `RunsService.runs`; nếu đang mở thread đó thì về màn trò chuyện mới.
- [ ] `ThreadList`: nút "⋯" hiện khi rê chuột trên một cuộc trò chuyện → "Xoá cuộc trò chuyện". Bấm thì dòng đó đổi thành xác nhận ngay tại chỗ: "Xoá? Bản nháp chưa nhận sẽ mất." [Xoá] [Huỷ]. Cuộc trò chuyện đang chạy thì nút bị khoá kèm lý do.
- [ ] Spec: xoá gọi backend với đủ run id; huỷ không gọi; lỗi hiện tại dòng đó.

## T5 — Chỉ hỏi xong làm luôn

**Ý chủ repo:** không cần nút riêng; agent đề xuất, người dùng đồng ý, agent làm.

Mặc định của ô chat đã là Sửa code + "Hỏi trước" trên thư mục thật: agent trả lời câu hỏi bình thường, khi cần sửa thì hiện thẻ duyệt. Đó chính là "đồng ý thì làm". Việc còn lại là khi người dùng **chủ động chọn Chỉ hỏi**.

- [ ] Kiểm chứng live (tốn ít token): Chỉ hỏi Claude (`--permission-mode plan`), yêu cầu sửa một tệp. Ghi lại agent báo gì: `ExitPlanMode` trong `permission_denials` của dòng `result`, hay chỉ trả lời bằng chữ. Lưu fixture vào `src-tauri/tests/fixtures/claude/<version>/`.
- [ ] Nếu có tín hiệu: hiện thẻ ngay trên ô chat như thẻ duyệt: "{Agent} muốn bắt đầu sửa code." [Cho phép] [Không]. Cho phép = đổi quyền của cuộc trò chuyện sang "Hỏi trước" và gửi "Làm theo đề xuất vừa rồi." (đường `startTask` có `recap` sẵn có). Thẻ duyệt từng lệnh vẫn hiện như thường.
- [ ] Codex (`--sandbox read-only`): ghi lại có tín hiệu tương tự không; không có thì không hiện thẻ (không đoán bằng chữ).
- [ ] Cập nhật `docs/user-guide.md`: "Hỏi trước" là chế độ chat mặc định; Chỉ hỏi chỉ dùng khi chắc chắn không muốn sửa gì.

## Dùng TG Studio để làm tiếp

Sau khi T1–T4 vào `main`, các việc tiếp theo giao qua chính app: `npm run dev`, mở repo `tg-studio`, mỗi task một cuộc trò chuyện "Hỏi trước" (hoặc Bản nháp khi chạy song song Claude + Codex). Ghi lại mọi chỗ vướng vào mục **Vướng khi tự dùng** dưới đây để xếp vào đợt sau.

### Vướng khi tự dùng

- (chưa có)
