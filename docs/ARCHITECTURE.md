# Kiến trúc TG Studio

```
Angular UI (signals)
   │  invoke('start_agent' | 'stop_agent' | 'detect_agents' | 'home_dir' | 'list_runs')
   │  listen('agent-event')
   ▼
Rust core (Tauri 2)
   ├─ detect.rs   tìm CLI trên login PATH
   ├─ runner.rs   1 tiến trình con / lượt chạy, stream từng dòng
   ├─ usage.rs    dòng JSON → Usage chuẩn hóa
   ├─ store.rs    lịch sử lượt chạy (SQLite)
   ├─ acp/        JSON-RPC, phiên ACP, fs + terminal trong worktree
   ├─ acp_runner.rs  định tuyến yêu cầu của agent, xin duyệt theo policy
   ├─ acp_tasks.rs   vòng đời tiến trình adapter, lệnh Tauri của task
   ├─ policy.rs   lệnh nào tự cho phép, tự từ chối, hay hỏi người dùng
   ├─ worktree.rs, diff.rs  worktree theo run, duyệt và commit theo hunk
   └─ adapters.rs tham số chạy của từng agent
   │  spawn (stdio)
   ▼
Agent CLI: claude · codex · gemini · kiro-cli
```

## Hợp đồng sự kiện `agent-event`

```ts
{ runId, agent: 'claude'|'codex'|'gemini'|'kiro',
  kind: 'started'|'log'|'stderr'|'usage'|'exit',
  line?, usage?, code?, atMs }
```

`usage` luôn được chuẩn hóa:

| Trường | Ý nghĩa |
|---|---|
| `inputTokens` | input **không** tính phần cache |
| `cachedInputTokens` | input đọc từ cache |
| `outputTokens` | output |
| `costUsd` | chỉ có khi CLI tự báo (Claude Code) |
| `cumulative` | `true`: số tổng của lượt chạy → thay thế; `false`: số của 1 turn → cộng dồn |

Nguồn số liệu từng agent:

| Agent | Dòng chứa usage |
|---|---|
| Claude Code | `{"type":"result", "usage":{…}, "total_cost_usd":…}` (dòng cuối) |
| Codex | `{"type":"turn.completed", "usage":{input_tokens, cached_input_tokens, output_tokens}}` |
| Gemini CLI | `{"type":"result", "stats":{"models":{…:{"tokens":{…}}}}}` |
| Kiro CLI | chưa có — giai đoạn 1/3 |

## Thêm một agent mới

1. Thêm biến thể vào `AgentKind` (`adapters.rs`): tên, binary, tham số headless.
2. Thêm hàm `parse_*` trong `usage.rs` + test.
3. Thêm vào `AgentId`, `AGENT_META` và `AGENT_IDS` (`src/app/core/protocol.ts`), `PRICES` (`pricing.ts`), `MockBackend.detectAgents`, và nhánh trong `describe-line.ts`. Thêm vào `AgentKind::ALL` ở bước 1.
4. Ghi output thật của CLI vào `src-tauri/tests/fixtures/<agent>/<version>/` và thêm contract test.

## Task sửa code (ACP)

Mỗi task có một git worktree riêng trong `<repo>/.tg/worktrees/<run-id>` và một tiến trình adapter ACP. Hàng chờ duyệt là `git diff` trong worktree: accept một hunk sẽ áp nó vào repo người dùng và stage nó trong worktree, nên hunk đó tự rời hàng chờ. Reject bỏ hunk khỏi worktree.

Quyền: `git push`, merge và `gh pr merge` luôn bị từ chối. Lệnh khớp rule "Always allow" được tự cho phép; lệnh ghép và các lệnh chạy được mã tùy ý (`bash`, `python`, `npx`…) không bao giờ có rule. UI không gửi option `allow_always` của agent, vì agent mới quyết định option đó bao trùm những gì.

## Lịch sử lượt chạy

`runner.rs` ghi mọi event vào `tg-studio.db` trong thư mục dữ liệu của app, trước khi phát lên UI. Khi khởi động: lượt còn `running` chuyển thành `interrupted`, và nếu không mở được file thì app dùng DB trong bộ nhớ, chỉ mất lịch sử. UI nạp lại 100 lượt gần nhất qua `list_runs`; các lượt này có `restored: true` nên không tính vào usage của phiên hiện tại.

## Đổi frontend sau này

UI chỉ nói chuyện với lõi qua `AgentBackend` (`src/app/core/backend.ts`) và các kiểu trong `protocol.ts`.
Một frontend khác (React, web dashboard…) chỉ cần tái dùng hai hợp đồng đó; phần Rust giữ nguyên.
