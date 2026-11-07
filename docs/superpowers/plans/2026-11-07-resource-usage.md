# Hiện RAM và CPU mà app và các agent đang chiếm

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Người dùng thấy ngay TG Studio và từng agent đang chiếm bao nhiêu RAM/CPU, và dừng được agent không dùng nữa để giải phóng bộ nhớ. Phát hành ở **0.3.0**.

**Đo tay (2026-11-07, macOS):** lõi Rust ~103 MB; WebView của macOS (3 tiến trình XPC `com.apple.WebKit.*`, cha là launchd, không phải app) ~165 MB; một phiên Chỉ hỏi Claude sống ~250 MB, kèm MCP do Claude tự mở (Playwright ~90 MB). Rảnh thì CPU gần 0.

## Phân công

| Task | Owner | File được sửa | Phụ thuộc |
|---|---|---|---|
| R1 Lõi: sổ PID, đo, lệnh | **Codex** | `resources.rs` (mới), `runner.rs`, `acp_tasks.rs`, `warm.rs`, `lib.rs`, `Cargo.toml` (đã thêm `sysinfo` 0.40.1, đã `cargo fetch`) | — |
| R2 UI: ô ở thanh dưới, bảng chi tiết, nút Dừng | Claude | `protocol.ts`, `backend.ts`, `mock-backend.ts`, `status-bar.ts`, `styles.scss` + spec | R1 (giao diện dưới đây) |

## Global Constraints

- Chuỗi hiển thị viết tiếng Việt, kể cả lỗi Rust. Kiểu `protocol.ts` khớp struct Rust (`camelCase`).
- Thêm phương thức vào `AgentBackend` thì cài ở cả hai backend; lệnh Tauri mới đăng ký trong `generate_handler!`.
- Đo không bao giờ làm hỏng hay làm chậm lượt chạy: lỗi đo chỉ `eprintln!`, sổ PID không giữ khoá khi spawn.
- Trước khi xong: `npm run build`, `npm test -- --watch=false`, `(cd src-tauri && cargo test)`.

## Giao diện chung

```rust
// resources.rs
#[derive(Serialize, Clone, Debug, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct ProcStat { pub pid: u32, pub parent: Option<u32>, pub name: String, /** % của một nhân */ pub cpu: f32, /** byte, RSS */ pub memory: u64 }

#[derive(Serialize, Clone, Debug, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct UsageGroup {
    /// "app" (lõi + WebView nếu đo được), "run" (một run), "warm" (phiên mở sẵn), "other" (con của app không thuộc run nào: probe model/skill, tiến trình mồ côi).
    pub kind: String,
    pub run_id: Option<String>,
    pub cpu: f32, pub memory: u64,
    /// Cả cây: tiến trình gốc trước, rồi con cháu.
    pub processes: Vec<ProcStat>,
}

#[derive(Serialize, Clone, Debug, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct ResourceReport { pub at: u64, pub cpu: f32, pub memory: u64, pub cores: usize, pub groups: Vec<UsageGroup>, /** WebView đã được tính vào nhóm app */ pub webview: bool }
```

- `resource_usage() -> Result<ResourceReport, String>`
- `kill_process(pid: u32) -> Result<(), String>`: chỉ cho tiến trình là **con cháu** của app và không thuộc run nào đang sống (nhóm `other`); còn lại trả lỗi tiếng Việt. Dùng `env::kill_tree`.

## R1 — Lõi (Codex)

- [x] `resources.rs`: sổ PID toàn cục (`static REGISTRY: Mutex<HashMap<u32, Owner>>`, `Owner::Run(String) | Owner::Warm`), hàm `register(pid, owner)`, `unregister(pid)`. Gọi `register` ngay sau mỗi `spawn` có PID và `unregister` khi tiến trình kết thúc: `runner.rs` (Chỉ hỏi, khoảng dòng 247), `acp_tasks.rs` (Sửa code, nơi lấy `pid` từ warm hoặc `child.id()`), `warm.rs` (`Owner::Warm` lúc mở; khi được nhận cho một run thì chuyển sang `Owner::Run(id)`). Probe `options.rs` không đăng ký: sẽ rơi vào `other`.
- [x] Đo bằng `sysinfo` 0.40 (`System` giữ trong `static Mutex<Option<System>>` để CPU có mẫu trước; lần gọi đầu CPU = 0). Mỗi lần gọi: refresh processes (CPU + memory), lấy cây con cháu của `std::process::id()`. Nhóm `app` = chính app + con cháu không thuộc run/warm **và là WebView** (Windows: `msedgewebview2.exe`; Linux: `WebKitWebProcess`/`WebKitNetworkProcess`). macOS: WebView là dịch vụ XPC không phải con của app, nên `webview = false` (UI sẽ ghi chú). Mỗi PID trong sổ → nhóm `run`/`warm` gồm cả cây của nó. Con cháu còn lại → một nhóm `other`. `cpu`, `memory` của nhóm và của báo cáo là tổng.
- [x] Tách phần gom nhóm thành hàm thuần (đầu vào: danh sách `ProcStat` + sổ PID + PID app) để test không cần tiến trình thật.
- [x] Test: gom đúng cây theo run, warm, other; PID trong sổ đã chết thì bỏ qua; WebView trên Windows vào `app`; `kill_process` từ chối PID của app, của run đang sống, và PID không phải con cháu.

## R2 — UI (Claude)

- [x] `AgentBackend.resourceUsage()`, `killProcess(pid)` ở hai backend (mock: số giả hợp lý, đổi nhẹ mỗi lần).
- [x] `StatusBar`: ô `TG · 610 MB · 1%` (tổng), hỏi 3 s một lần khi cửa sổ đang hiện, 15 s khi ẩn. Bấm mở bảng: dòng **TG Studio** (lõi, WebView hoặc ghi chú "macOS không cho đo WebView của app"), mỗi run một dòng (logo agent, tên cuộc trò chuyện, RAM, CPU, số tiến trình con, nút **Dừng** khi run còn sống), dòng **Phiên mở sẵn**, nhóm **Khác** với nút **Dừng** từng tiến trình. RAM hiển thị MB/GB, CPU là % của một nhân.
- [x] Spec: định dạng số; bấm Dừng gọi `runs.stop`; nhóm Khác gọi `killProcess`.
- [x] Phát hành: `npm run release -- minor` (0.3.0), `npm run build:mac`.
