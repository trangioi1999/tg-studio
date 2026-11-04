# M0, M2 và các lỗi từ review: Implementation Plan

**Goal:** Windows ổn, mở app nhanh, sửa các lỗi đã xác minh từ review.

**Spec:** `docs/superpowers/specs/2026-11-04-chat-first-design.md` (mục 7, 8.5, 9). Review: `docs/superpowers/specs/2026-11-04-codex-review.md`.

**Thực thi:** ba job Codex song song trong worktree riêng, không commit; Claude review và commit. Mỗi job chỉ sửa tệp được liệt kê.

## Global Constraints

- Tiến trình con chỉ tạo qua `env::command` / `env::std_command`.
- Chuỗi hiển thị bằng tiếng Việt. Thêm phương thức `AgentBackend` thì cài ở cả `TauriBackend` và `MockBackend`. Thêm lệnh Tauri thì đăng ký trong `generate_handler!`. `protocol.ts` khớp struct Rust.
- Không style riêng trong component; CSS ở `src/styles.scss`.
- Với mỗi lỗi từ review: **xác minh trước**, viết test tái hiện đỏ, rồi mới sửa. Lỗi không tái hiện được thì không sửa, ghi lý do vào báo cáo.
- Không sửa test có sẵn để né lỗi. Test `bridge::tests::stdio_server_forwards_to_the_hub_with_its_token` hỏng trong sandbox vì không mở được cổng là bình thường.

---

### Job A: M0 Windows (`md-m0`)

**Files:** `src-tauri/src/env.rs`, `runner.rs`, `adapters.rs`, `compose.rs`, `acp_tasks.rs` (chỉ `terminate_adapter`), `acp/handlers.rs`, `src/app/core/runs.service.ts`, `runs.service.spec.ts`, `src/app/shell/agent-panel.ts`, `src/styles.scss`

1. **Diệt cả cây tiến trình (review #3).** Thêm vào `env.rs`: `pub fn isolate(cmd: &mut tokio::process::Command)` (Unix: `process_group(0)`; Windows: không làm gì) và `pub async fn kill_tree(pid: u32)` (Unix: `kill -KILL -- -<pid>`; Windows: `taskkill /PID <pid> /T /F`; timeout 2 s). `terminate_adapter`, `stop_agent` của `runner.rs`, terminal trong `acp/handlers.rs` và `run_check` của `compose.rs` đều dùng chung. Test Unix cho từng nơi có thể test được: `sh -c "sleep 30 & wait"` không còn tiến trình con sau khi dừng.
2. **Prompt nhiều dòng qua `.cmd` (review #7).** Rust từ chối đối số có `\r` hoặc `\n` khi chạy batch. Trong `adapters.rs` thêm `pub fn headless_invocation(self, prompt: &str, program: &Path) -> Option<(Vec<String>, Option<String>)>`: nếu `program` có đuôi `.cmd` hoặc `.bat` và prompt chứa xuống dòng thì trả về đối số không kèm prompt và nội dung stdin. Claude: `-p --output-format stream-json --verbose`. Codex: `exec --json -`. Gemini: `--output-format stream-json`. Các trường hợp còn lại giữ nguyên cách cũ. `runner.rs` đặt stdin theo kết quả này và ghi rồi đóng. Test bảng cho từng agent, chạy được trên mọi hệ điều hành.
3. **`compose.rs` giới hạn bộ nhớ (review #16).** Đọc output qua pipe, chỉ giữ 64 KB cuối trong lúc chạy, không dùng `wait_with_output`.
4. **Cảnh báo im lặng (spec mục 7).** `Run.lastEventAt: number`, cập nhật ở mọi event trong `RunsService.apply`, kể cả run nạp lại thì lấy `endedAt ?? startedAt`. Hàm thuần `isQuiet(run, now)`: `status === 'running'`, `permissions` rỗng, `now - lastEventAt >= 30000`. `AgentPanel` hiện "Agent chưa phản hồi 30 giây. Có thể vẫn đang xử lý." với nút Dừng. Dùng `runs.now()` có sẵn.

---

### Job B: M2 Khởi động nhanh (`md-m2`)

**Files:** `src-tauri/src/detect.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/ledger.rs` (chỉ thêm khoá setting nếu có danh sách khoá), `src/app/core/agents.service.ts`, tạo `agents.service.spec.ts`, `protocol.ts`, `backend.ts`, `mock-backend.ts`, `src/app/shell/agents-panel.ts`, `onboarding.ts`, `src/styles.scss`

Không sửa `env.rs` trừ mục 3 dưới đây, viết đúng một hàm.

1. **Dò song song.** `detect_agents` chạy mọi agent đồng thời bằng `join_all` tự viết qua `tokio::spawn`, không thêm dependency. Giới hạn 8 s mỗi lệnh vẫn giữ.
2. **Cache.** `AgentsService.refresh()` đọc `settings['agents']` trước: có thì hiện ngay và đặt `checking` là true, rồi dò ở nền và ghi lại. `loading` chỉ true khi chưa có gì để hiện. Cache hỏng thì bỏ qua. `getSetting` / `setSetting` thêm khoá `'agents'`.
3. **PATH có timeout.** `env::read_login_path` (Unix): chạy shell qua thread, chờ tối đa 5 s bằng `try_wait`, quá hạn thì kill và dùng `PATH` của tiến trình.
4. **Kiểm tra đăng nhập.** `DetectedAgent.auth: 'ok' | 'none' | 'unknown'`. Claude: `claude auth status`. Codex: `codex login status`. Mã 0 là `ok`, khác 0 là `none`, không chạy được hoặc hết giờ là `unknown`. Gemini, Kiro: luôn `unknown`. Không bao giờ gửi prompt. Tách hàm thuần ánh xạ kết quả để test. `agents-panel` và `onboarding` đổi nhãn: "Đã đăng nhập", "Cần đăng nhập" (kèm lệnh từ `LOGIN`, nút Chép), "Đã cài, chưa rõ đăng nhập".

---

### Job C: Lỗi từ review (`md-fix`)

**Files:** `src-tauri/src/policy.rs`, `src-tauri/src/skills.rs`, `src/app/core/budget.service.ts`, `budget.service.spec.ts`, `src/app/shell/code-editor.ts`, `workbench.ts`, `compare.ts`, `mission-control.ts`, `usage-screen.ts`

1. **#4 Policy trên Windows.** So khớp chương trình không phân biệt hoa thường và bỏ đuôi `.exe`, `.cmd`, `.bat`, `.com`, trên mọi hệ điều hành. Test: `node.exe -e x` không khớp quy tắc tạo từ `node.exe --version`; `git.exe push` bị coi như `git push`.
2. **#15 Skills.** Tệp hiện có không phải UTF-8 phải được coi là `different` và sao lưu theo byte trước khi ghi. Test với byte UTF-16.
3. **#10 Ngân sách qua ngày.** Mốc đầu ngày phải tính lại khi sang ngày mới và lọc lại lịch sử, không cần có run mới. Test với fake timers.
4. **#18 Đọc usage quá nhiều.** Effect chỉ phụ thuộc số run đã kết thúc, không phụ thuộc mỗi dòng log. Test đếm số lần gọi `usageReport`.
5. **#2 Mất phần sửa tay.** Giữ `CodeEditor` sống khi đổi tab hoặc chuyển buffer ra ngoài component, chọn cách ít đổi hơn. Test nếu tách được logic; nếu không, mô tả cách đã kiểm tra.
6. **#13 Lỗi diff bị coi là không có thay đổi.** `Compare` và `MissionControl` hiện thông báo lỗi thay vì mảng rỗng hoặc số 0.
