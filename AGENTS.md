# Hướng dẫn cho coding agent làm việc trên repo này

- Frontend: Angular 22, standalone components, **signals** cho state, control flow `@if/@for`. Không dùng NgModules, không thêm zone.js.
- Style: dùng biến CSS trong `src/styles.scss`. Giao diện tối. Agent nhận diện bằng logo (`public/agents/*.svg`, qua `tg-agent-avatar`); màu dành cho trạng thái (`--run`, `--wait`, `--done`, `--fail`, class `.pill[data-status]`). `AGENT_META[a].color` chỉ còn cho vạch của agent trong editor/diff, `chart` cho biểu đồ.
- Mọi giao tiếp với lõi đi qua `AgentBackend`; không gọi `invoke` trực tiếp trong component.
- Rust: mỗi agent khai báo trong `agents/adapters.rs`; mọi thay đổi định dạng usage phải kèm unit test trong `usage/mod.rs`.
- Kiểu dữ liệu trong `src/app/core/protocol.ts` phải khớp với struct Rust (`#[serde(rename_all = "camelCase")]`).
- Trước khi xong việc: `npm run build`, `npm test`, `(cd src-tauri && cargo test)`.
- Tài liệu: `docs/` (đọc `01-product-spec.md` và `02-roadmap.md` trước khi nhận task lớn; `03`–`05` cho phần tích hợp agent/usage/MCP; `06` cho UI).
