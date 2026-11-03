# 04 · Usage & chi phí

## 1. Ba loại số — đừng trộn lẫn

| Loại | Ví dụ | Độ tin cậy | Nhãn trong UI |
|---|---|---|---|
| Token | in / cache / out của một lượt chạy | Cao — CLI báo trực tiếp | (luôn hiện) |
| Chi phí USD | $0.41 | Claude Code tự báo (ước tính phía client); agent khác = token × bảng giá | `reported` / `estimated` / `chưa có giá` |
| Quota gói subscription | "5h window 42%", "312/1000 credits" | Thấp — thường không có API ổn định | `reported` / `parsed` / ẩn |

Quy tắc: **không có nguồn thì không hiện số.** Mỗi số có nhãn nguồn và thời điểm cập nhật.

## 2. Nguồn số liệu từng agent

| Agent | Token | Chi phí | Ghi chú |
|---|---|---|---|
| Claude Code | `result.usage`: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` | `total_cost_usd` (+ breakdown theo model) | Khi resume phiên, `total_cost_usd` là **tổng cả phiên** → app tự trừ ra phần của lượt mới. Đây là ước tính phía client, có thể lệch hóa đơn. Có `--max-budget-usd` để chặn trần. |
| Codex | `turn.completed.usage`: `input_tokens`, `cached_input_tokens`, `output_tokens` | Không có → token × bảng giá | Usage theo từng turn → cộng dồn |
| Gemini CLI | `result.stats` (token theo từng model) | Không có → token × bảng giá | Tên trường đọc linh hoạt (`prompt`/`input`, `candidates`/`output`, `cached`) |
| Kiro CLI | Chưa có trong stream | Tính bằng **credits**, không phải USD | Nguồn khả thi: chạy lệnh `/usage` của Kiro CLI ở chế độ không tương tác rồi parse — dễ vỡ khi Kiro đổi định dạng, phải gắn nhãn `parsed` |

## 3. Chuẩn hóa (đã có trong `src-tauri/src/usage.rs`)

| Trường | Định nghĩa |
|---|---|
| `inputTokens` | input **không** tính cache. Codex/Gemini: `input - cached`. Claude: `input + cache_creation` |
| `cachedInputTokens` | input đọc từ cache |
| `outputTokens` | output |
| `costUsd` | chỉ khi CLI báo |
| `cumulative` | `true` → thay số cũ của run; `false` → cộng thêm |

## 4. Usage Ledger (SQLite, GĐ3)

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), agent TEXT NOT NULL,
  model TEXT, step TEXT, worktree TEXT, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER
);
-- Một dòng cho mỗi sự kiện usage nhận được (append-only, không sửa).
CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY, run_id TEXT REFERENCES runs(id), at INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cost_usd REAL, cumulative INTEGER NOT NULL, source TEXT NOT NULL, raw TEXT
);
CREATE TABLE prices (
  agent TEXT NOT NULL, model TEXT NOT NULL, valid_from INTEGER NOT NULL,
  input_per_mtok REAL NOT NULL, cached_input_per_mtok REAL NOT NULL, output_per_mtok REAL NOT NULL,
  note TEXT, PRIMARY KEY (agent, model, valid_from)
);
CREATE TABLE budgets (
  scope TEXT NOT NULL,            -- 'task' | 'day' | 'week' | 'month'
  scope_id TEXT,                  -- task id khi scope = 'task'
  limit_usd REAL NOT NULL, warn_at REAL NOT NULL DEFAULT 0.8, hard_stop INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE quota_snapshots (
  agent TEXT NOT NULL, plan TEXT, label TEXT NOT NULL, used REAL, total REAL,
  unit TEXT, resets_at INTEGER, source TEXT NOT NULL, at INTEGER NOT NULL
);
```

**Tính usage của một run:** duyệt `usage_events` theo thời gian; `cumulative = 1` thì thay, `0` thì cộng. Lưu thêm view/materialized bảng `run_usage` cho truy vấn nhanh.

**Chi phí ước tính:** dùng giá có `valid_from` gần nhất trước thời điểm sự kiện — đổi bảng giá không làm sai số liệu cũ.

## 5. Bảng giá

- Không hard-code giá trong code. Người dùng nhập (hoặc import file) theo trang pricing chính thức của từng hãng; mỗi dòng có `note` ghi nguồn và ngày.
- GĐ0 tạm dùng `src/app/core/pricing.ts` (mặc định `null` = không đoán tiền).
- Người dùng gói subscription: chi phí "estimated" chỉ để **so sánh tương đối** giữa agent, ghi rõ trong UI.

## 6. Ngân sách & cảnh báo

| Mức | Hành vi |
|---|---|
| ≥ `warn_at` (mặc định 80%) | Toast + chấm vàng ở status bar |
| ≥ 100%, `hard_stop = 1` | Dừng run đang chạy (ACP `session/cancel` → kill), chặn run mới trong scope |
| Claude | Truyền thêm `--max-budget-usd` = phần ngân sách còn lại của task |

Kiểm tra sau mỗi `usage_event`.

## 7. Context window

Thanh "ctx %" = token hiện có trong ngữ cảnh / giới hạn của model. Lấy từ update của agent nếu có; nếu không, ước tính từ tổng input của turn gần nhất. Gần 85% → gợi ý "nén lịch sử" hoặc mở phiên mới.

## 8. Hiển thị (đã có trong mockup)

- Title bar: chip mỗi agent `tên · trạng thái · token · $`.
- Panel agent: khung "Usage · this task" — in/cache/out, ctx, cost, nhãn nguồn; dòng quota gói.
- Status bar: chi phí hôm nay / ngân sách.
- Màn Usage: KPI, biểu đồ theo agent theo ngày, quota gói, bảng phiên, export CSV.
