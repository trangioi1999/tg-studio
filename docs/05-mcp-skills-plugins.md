# 05 · MCP, Skills, Plugin

Mục tiêu: người dùng khai báo **một lần** trong TG Studio, mọi agent được chọn đều dùng được — không phải sửa config của từng CLI bằng tay.

## 1. Mô hình: registry trung tâm

```
TG Studio registry (app data, JSON/SQLite)
   ├─ mcpServers[]   { id, name, transport: stdio|http, command, args, env(secret refs), url, enabledFor: AgentId[] }
   ├─ skills[]       { id, name, scope: project|personal, path, enabledFor: AgentId[] }
   └─ plugins[]      { agent, name, enabled }      // chỉ bật/tắt, không chuyển đổi
         │
         ├─ (ưu tiên) truyền theo phiên: ACP session/new { mcpServers }, hoặc cờ CLI
         └─ (khi bắt buộc) ghi file config của từng agent ở mức project
```

**Nguyên tắc:**
1. **Ưu tiên truyền theo phiên**, không sửa config toàn cục của người dùng. ACP `session/new` nhận danh sách MCP server; Claude headless nhận `--mcp-config`.
2. Khi phải ghi file: ghi ở **mức project**, sao lưu file cũ, chỉ đụng các mục do TG Studio quản lý (đánh dấu bằng tiền tố tên `tg-`), hiện diff cho người dùng duyệt trước khi ghi.
3. Secret (token, API key) lưu trong Keychain/Credential Manager; file config chỉ chứa tham chiếu biến môi trường.

## 2. Nơi mỗi agent đọc cấu hình MCP

| Agent | Theo phiên | File project | File người dùng |
|---|---|---|---|
| Claude Code | ACP `session/new`; headless `--mcp-config <file-or-json>` | `.mcp.json` ở gốc repo | cấu hình user của Claude Code |
| Codex | ACP `session/new` | — | `~/.codex/config.toml`, mục `[mcp_servers.<tên>]` |
| Gemini CLI | ACP `session/new` | `.gemini/settings.json` → `mcpServers` | `~/.gemini/settings.json` → `mcpServers` |
| Kiro CLI | ACP `session/new` | `.kiro/settings/mcp.json` | `~/.kiro/settings/mcp.json` |

> Đường dẫn và khóa có thể đổi theo phiên bản CLI — adapter của từng agent là nơi duy nhất giữ kiến thức này, kèm test.

## 3. Ma trận bật/tắt (màn Integrations)

Hàng = MCP server, cột = agent. Bật ô → server được thêm vào phiên của agent đó. Server cần OAuth: TG Studio mở luồng đăng nhập một lần, lưu token, cấp cho mọi agent qua biến môi trường.

## 4. Skills

Skill = thư mục có `SKILL.md` (frontmatter `name`, `description` + hướng dẫn) và file phụ trợ.

| Agent | Hỗ trợ | Vị trí |
|---|---|---|
| Claude Code | Có | `.claude/skills/<tên>/` (project), thư mục skills của user |
| Kiro CLI | Có (Skills nằm trong cấu hình project, cùng Steering, Hooks) | theo docs Kiro |
| Codex, Gemini CLI | Kiểm tra theo phiên bản trước khi bật | — |

**Đồng bộ:** thư viện skill gốc nằm trong `<repo>/.tg/skills/` (commit cùng repo) hoặc thư mục cá nhân. TG Studio tạo **symlink** (Windows: junction hoặc copy) sang vị trí từng agent; UI hiện rõ agent nào không hỗ trợ.

## 5. Plugin

Mỗi hãng có khái niệm riêng (Claude plugins, Gemini extensions, Kiro powers/hooks…) và không tương thích nhau. TG Studio chỉ:
- liệt kê plugin đã cài của từng agent (nếu CLI cho phép đọc),
- bật/tắt theo phiên khi CLI hỗ trợ (ví dụ Claude `--plugin-dir`),
- không chuyển đổi định dạng giữa các hãng.

## 6. MCP `tg-bridge` — kênh phối hợp giữa các agent

Một MCP server nhỏ do TG Studio cung cấp, gắn vào **mọi** agent. Nhờ nó, agent khác hãng vẫn phối hợp qua cùng một kênh, và app biết chính xác agent đang làm gì.

| Tool | Input | Tác dụng |
|---|---|---|
| `report_progress` | `{ step, pct?, note? }` | Cập nhật timeline/cột agent |
| `handoff_to` | `{ agent, task, files? }` | Đề xuất chuyển việc → hiện trong merge queue/plan để người dùng duyệt |
| `read_notes` | `{ topic? }` | Đọc ghi chú chung của task (plan, quyết định, quy ước) |
| `write_note` | `{ topic, text }` | Ghi chú chung — các agent khác đọc được |
| `request_approval` | `{ action, reason }` | Xin duyệt việc ngoài phạm vi (dùng khi agent không có cơ chế permission riêng) |
| `get_task_context` | `{}` | Mô tả task, bước pipeline hiện tại, file liên quan |

- Transport: **stdio** (mỗi agent spawn 1 tiến trình `tg-bridge`, nói chuyện với app qua socket cục bộ có token theo run).
- Mỗi lời gọi gắn `run_id` → không agent nào ghi đè ghi chú của task khác.
- Mọi tool chỉ **đề xuất**; hành động có tác động (handoff, merge) luôn qua người dùng.

## 7. Bảo mật

- MCP server bên thứ ba chạy với quyền của người dùng — hiện cảnh báo khi thêm server lạ, hiển thị lệnh sẽ chạy.
- Không bật server cho agent nếu người dùng chưa duyệt ít nhất một lần.
- Log mọi lời gọi tool MCP theo run để xem lại.
