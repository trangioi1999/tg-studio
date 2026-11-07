# Hiện skill và lệnh của agent trong app

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Mở dự án B là thấy ngay các skill mà agent đọc được (của dự án, của máy, của plugin), và gọi được chúng từ ô chat.

**Kết quả (2026-11-07):** chủ repo chưa tự giao qua app, nên làm theo cách cũ: Codex làm S1 qua `codex exec` trong worktree, Claude làm S2 song song theo giao diện chốt sẵn. Mục "Cách làm qua TG Studio" giữ làm mẫu cho đợt sau.

**Đây là đợt đầu tiên giao việc qua chính TG Studio.** Mỗi task là một cuộc trò chuyện trong app (cách làm ở cuối tài liệu). Chỗ nào vướng khi dùng app thì ghi vào mục **Vướng khi tự dùng** của `2026-11-07-chat-polish.md`.

## Đã kiểm chứng (2026-11-07, không tốn token)

Mở phiên ACP trong một dự án có skill riêng: ngay sau `session/new`, adapter gửi `session/update` loại `available_commands_update`. **Agent đã đọc skill của dự án; app chỉ đang bỏ qua thông báo này** (`TaskSession::on_notification` không xử lý, `options::agent_options` dùng handler `Silent`).

| Adapter | Skill dự án | Dạng mục | Fixture |
|---|---|---|---|
| `claude-agent-acp` 0.100.0 | `.claude/skills/<tên>/SKILL.md` | `name` = tên skill; `description` kết thúc bằng ` (project)` hoặc ` (user)`; skill của plugin: `name` = `plugin:skill`, `description` bắt đầu bằng `(plugin) `; lệnh có sẵn (`compact`, `model`, …) và skill đi kèm CLI (`dataviz`) không có dấu nào | `src-tauri/tests/fixtures/claude-agent-acp/0.100.0/available-commands.json` |
| `codex-acp` 2.5.0 | `.agents/skills/<tên>/SKILL.md` | lệnh có sẵn: `plan`, `review`, …; skill: `name` bắt đầu bằng `$` (`$tg-codex-skill`, plugin: `$documents:documents`); description không nói nguồn | `src-tauri/tests/fixtures/codex-acp/2.5.0/available-commands.json` |

Mỗi mục có `name`, `description`, `input` (`null` hoặc `{ "hint": "<gợi ý tham số>" }`). Danh sách đến trong vòng vài giây sau `session/new`, có thể đến lại khi phiên đổi.

Gọi skill: Claude nhận `/tên tham số` ở đầu prompt (cả ACP lẫn `claude -p`); Codex nhận `$tên` trong prompt và `/lệnh` cho lệnh có sẵn.

## Phân công

| Task | Owner | File được sửa | Phụ thuộc |
|---|---|---|---|
| S1 Lõi: đọc và chuyển danh sách lệnh | **Codex** (qua TG Studio) | `options.rs`, `acp_runner.rs`, `lib.rs` | — |
| S2 UI: gõ `/` hoặc `$` để chọn skill, mục skill ở màn Kết nối | **Claude** (qua TG Studio) | `protocol.ts`, `backend.ts`, `mock-backend.ts`, `agents.service.ts`, `runs.service.ts`, `agent-panel.ts`, `integrations.ts`, `styles.scss` + spec | S1 (dùng đúng giao diện dưới đây) |

## Global Constraints

- Chuỗi hiển thị viết tiếng Việt, kể cả lỗi Rust.
- Kiểu trong `protocol.ts` khớp struct Rust (`#[serde(rename_all = "camelCase")]`).
- Thêm phương thức vào `AgentBackend` thì cài ở cả `TauriBackend` và `MockBackend`; lệnh Tauri mới đăng ký trong `generate_handler!`.
- Tên class CSS là toàn cục: đặt tiền tố riêng (`cmd-`), kiểm tra `grep` trước khi dùng.
- Trước khi xong: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`.

## Giao diện chung (S1 cung cấp, S2 dùng)

```rust
// options.rs
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    /// Đúng như adapter gửi: "tg-demo-skill", "superpowers:writing-plans", "$tg-codex-skill", "compact".
    pub name: String,
    /// Đã bỏ dấu nguồn: " (project)", " (user)", "(plugin) ".
    pub description: String,
    /// "skill" hoặc "command".
    pub kind: String,
    /// "project" | "user" | "plugin" | null (không biết, hoặc có sẵn trong CLI).
    pub source: Option<String>,
    /// Tên plugin khi source = "plugin".
    pub plugin: Option<String>,
    /// `input.hint`, nếu có.
    pub hint: Option<String>,
    /// Chữ chèn vào ô chat: "/tg-demo-skill ", "$tg-codex-skill ", "/plan ".
    pub insert: String,
}
```

- Lệnh Tauri `agent_commands(agent: AgentKind, cwd: Option<String>) -> Result<Vec<AgentCommand>, String>`.
- Event mới từ phiên đang chạy: `kind: "commands"`, `data: { "commands": AgentCommand[] }`.

## S1 — Lõi (Codex)

- [x] `pub fn parse_commands(agent: AgentKind, update: &Value, cwd: Option<&Path>) -> Vec<AgentCommand>` đọc `update["availableCommands"]`. Luật phân loại:
  - Claude: description kết thúc ` (project)` → skill/project; ` (user)` → skill/user; bắt đầu `(<x>) ` và `name` có `:` → skill/plugin, `plugin = x`. Còn lại → command, source `null`. `insert = "/" + name + " "`.
  - Codex: `name` bắt đầu `$` → skill; có `:` → plugin (`plugin` = phần trước `:`, bỏ `$`); không thì source = `project` nếu tồn tại `<cwd>/.agents/skills/<tên không có $>/SKILL.md`, còn lại `user`. `insert = name + " "`. Không bắt đầu `$` → command, `insert = "/" + name + " "`.
  - Agent khác: mọi mục là command, `insert = "/" + name + " "`.
  - Bỏ mục `name` rỗng; giữ thứ tự adapter gửi.
- [x] `TaskSession::on_notification`: `available_commands_update` → `queue_data("commands", json!({"commands": parse_commands(self.agent, update, Some(<thư mục làm việc của phiên>))}))`.
- [x] Tách phần spawn + `initialize` + `session/new` trong `agent_options` thành hàm dùng chung; `agent_options` giữ nguyên hành vi. Lệnh mới `agent_commands`: handler riêng ghi lại `available_commands_update` đầu tiên; sau `session/new` chờ tối đa 5 s cho tới khi có; hết giờ thì trả `Ok(vec![])`. Không prompt, không tốn token. Đăng ký trong `lib.rs`.
- [x] Test: hai fixture ở trên (Claude: 2 skill dự án/máy, 2 skill plugin `superpowers`, `dataviz`/`compact`/`model`/`init`/`code-review` là command, `hint` của `code-review`; Codex với `cwd` tạm có `.agents/skills/tg-codex-skill/SKILL.md` → project, `$documents:documents` → plugin `documents`, `plan` → command `/plan `); `TaskSession` phát event `commands` khi nhận update (dùng agent giả `acp/fake.rs` hoặc gọi thẳng `on_notification` như test `usage_update` sẵn có).
- [x] Test thật `#[ignore]` `live_agent_commands_lists_project_skill`: repo tạm có `.claude/skills/tg-live-skill/SKILL.md`, `agent_commands(Claude, repo)` có mục `tg-live-skill` source `project`.

## S2 — UI (Claude)

- [x] `protocol.ts`: `AgentCommand` khớp struct trên; `'commands'` vào `AgentEventKind`.
- [x] `AgentBackend.agentCommands(agent, cwd)` ở cả hai backend. Mock trả danh sách giống fixture (1 skill dự án, 1 skill máy, 2 skill plugin, vài command).
- [x] `AgentsService.commands`: cache theo `agent + thư mục dự án`, nạp lần đầu khi người dùng gõ `/`/`$` hoặc mở màn Kết nối (không mở adapter mỗi lần mở dự án) (không chặn UI, lỗi thì im lặng và để trống); event `commands` của run đang mở cập nhật cache của agent/dự án đó.
- [x] Ô chat: gõ `/` ở đầu ô (mọi agent) hoặc `$` ở đầu một từ (Codex) → popover lọc theo chữ gõ tiếp, nhóm **Skill của dự án** · **Skill trên máy** · **Plugin** · **Lệnh**, mỗi dòng: tên, mô tả một dòng, `hint` mờ. ↑/↓ chọn, Enter/Tab chèn `insert`, Esc đóng; không cản `@mention` sẵn có. Chưa có danh sách thì hiện "Đang đọc skill của {agent}…".
- [x] Màn Kết nối, phần Skills: thêm mục **Skill agent đang thấy ở {dự án}** (chỉ đọc), mỗi agent một nhóm, ghi nguồn; mục thư viện của app giữ nguyên.
- [x] Spec: lọc và nhóm; Enter chèn đúng `insert`; Esc không gửi; event `commands` cập nhật danh sách; mock mode qua Playwright: gõ `/` thấy skill dự án.
- [x] Cập nhật `docs/user-guide.md` (gõ `/`, `$`) và `CLAUDE.md` (event `commands`, `agent_commands`).

## Cách làm qua TG Studio

1. Trong terminal: `git checkout -b claude/agent-skills` (agent làm thẳng trong thư mục, nên làm trên nhánh riêng).
2. Mở TG Studio, mở thư mục `tg-studio`. Cuộc trò chuyện mới, agent **Codex**, quyền **Hỏi trước**, nơi làm việc **Thư mục hiện tại**. Gửi:
   > Đọc AGENTS.md, rồi làm đúng Task S1 trong docs/superpowers/plans/2026-11-07-agent-skills.md. Chỉ sửa file task liệt kê. Chạy `cd src-tauri && cargo test` trước khi báo xong.
   Sandbox của Codex không mở được cổng localhost, nên hai test tg-bridge dùng TCP có thể báo lỗi trong lượt của Codex; chạy lại hai test đó ngoài app trước khi kết luận.
3. Xem diff ở panel phải, **Giữ** những đoạn đúng. Giao S2 cho **Claude** trong một cuộc trò chuyện mới, cùng cách, thay "Task S1" bằng "Task S2" và lệnh kiểm tra là `npm run build && npm test -- --watch=false`.
4. Commit từ app, rồi nhờ Claude (trong terminal) review, chạy cả ba bộ kiểm tra và mở PR.
