# Kiến trúc TG Studio

```
Angular UI (signals)
   │  invoke('start_agent' | 'stop_agent' | 'detect_agents' | 'home_dir')
   │  listen('agent-event')
   ▼
Rust core (Tauri 2)
   ├─ detect.rs   tìm CLI trên login PATH
   ├─ runner.rs   1 tiến trình con / lượt chạy, stream từng dòng
   ├─ usage.rs    dòng JSON → Usage chuẩn hóa
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
3. Thêm vào `AgentId` và `AGENT_META` (`src/app/core/protocol.ts`), và nhánh trong `describe-line.ts`.

## Đổi frontend sau này

UI chỉ nói chuyện với lõi qua `AgentBackend` (`src/app/core/backend.ts`) và các kiểu trong `protocol.ts`.
Một frontend khác (React, web dashboard…) chỉ cần tái dùng hai hợp đồng đó; phần Rust giữ nguyên.
