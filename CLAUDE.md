# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Lệnh

```bash
npm install                     # cần chạy lần đầu
npm run dev                     # app desktop (Tauri + Angular), cần Rust
npm start                       # chỉ UI trong trình duyệt, chạy với MockBackend, không cần Rust
npm run build                   # build Angular
npm run build:app               # đóng gói vào src-tauri/target/release/bundle/

npm test -- --watch=false                               # test Angular (Vitest), chạy một lần
npm test -- --watch=false --include src/app/app.spec.ts # một file spec
(cd src-tauri && cargo test)                            # test Rust
(cd src-tauri && cargo test claude_result_line)         # một test Rust
(cd src-tauri && TG_LIVE_ACP=1 cargo test live_claude -- --ignored --nocapture)  # chạy adapter Claude thật, tốn token
(cd src-tauri && TG_LIVE_ACP=1 cargo test live_codex -- --ignored --nocapture)   # chạy adapter Codex thật, tốn token
(cd src-tauri && cargo build && TG_LIVE_ACP=1 TG_BRIDGE_EXE=$PWD/target/debug/tg-studio cargo test live_claude_tg_bridge -- --ignored)  # tg-bridge với Claude thật
```

Repo chưa cấu hình lint. Prettier có `.prettierrc` nhưng không có script riêng.

## Kiến trúc

Tauri 2: UI Angular gọi lõi Rust, lõi Rust chạy các agent CLI (`claude`, `codex`, `gemini`, `kiro-cli`) thành tiến trình con. Sơ đồ, hợp đồng `agent-event` và nguồn usage của từng agent nằm trong `docs/ARCHITECTURE.md`; đặc tả sản phẩm và tích hợp nằm trong `docs/01`–`07`.

**Luồng một lượt chạy**

1. Ô giao việc trong `AgentPanel` (panel phải) gọi `RunsService.start()`, rồi `AgentBackend.start()` chuyển thành lệnh Tauri `start_agent`.
2. `runner.rs` lấy tham số từ `AgentKind::headless_args`, spawn tiến trình con và trả về `runId`.
3. Mỗi dòng stdout đi qua `usage::parse_line`. Nếu dòng có usage, lõi phát thêm event `usage` trước event `log` của chính dòng đó.
4. `RunsService.apply()` gộp event vào signal `runs`. `describeLine()` đổi JSON thô thành dòng console ở phía UI, nên Rust chỉ chuyển nguyên dòng.

**Những điểm cần đọc nhiều file mới thấy**

- **Thứ tự event:** event `started` có thể đến trước khi `start()` nhận được `runId`. Vì vậy `upsert()` tạo run từ event đầu tiên, còn `prompt` và `cwd` được điền sau.
- **Hai backend:** `app.config.ts` chọn `TauriBackend` hoặc `MockBackend` qua `isTauri()`. Thêm phương thức vào `AgentBackend` thì phải cài ở cả hai. Thêm lệnh Tauri thì đăng ký thêm trong `generate_handler!` ở `lib.rs`.
- **Quy ước usage:** `inputTokens` luôn không gồm phần đọc từ cache. Codex và Gemini báo tổng nên phải trừ phần cache; Claude thì cộng `cache_creation_input_tokens` vào input. `cumulative` quyết định `mergeUsage` thay thế hay cộng dồn số cũ.
- **Chi phí:** dùng `costUsd` do CLI báo nếu có, không thì ước tính bằng giá có hiệu lực lúc lượt chạy bắt đầu (`PRICE_HISTORY` trong `pricing.ts`, nạp từ SQLite, sửa ở màn Usage). Luôn truyền `startedAt` vào `estimateCost`/`costOf`. Biểu đồ dùng `AGENT_META[a].chart`, không dùng `color`.
- **Trạng thái dừng:** `stop_agent` kill tiến trình và event `exit` có `code` là null. UI phân biệt `stopped` với `failed` bằng tập `stopping` trong `RunsService`, không phải bằng dữ liệu từ lõi.
- **PATH:** mọi tiến trình con phải dùng `env::which` và `.env("PATH", env::login_path())`, nếu không app mở từ Finder sẽ không thấy CLI cài qua nvm hoặc Homebrew. `login_path` đọc PATH từ `$SHELL -ilc`, đồng thời hỏi cả `/bin/zsh` và `/bin/bash` rồi gộp (một máy có `SHELL=zsh` nhưng node chỉ được thêm trong `~/.bash_profile`) (chờ tối đa 12 s; Mac Intel với oh-my-zsh/nvm từng quá 5 s và không thấy agent nào), rồi luôn nối thêm thư mục cài quen thuộc còn thiếu (`env::known_dirs`: nvm, fnm, volta, bun, `~/.local/bin`, Homebrew). Cách đọc ghi trong gói Chẩn đoán (`path`).
- **Tài nguyên:** `resources.rs` giữ sổ PID → run/phiên mở sẵn (đăng ký lúc spawn, xoá khi kết thúc); `resource_usage` đo bằng `sysinfo` và gom cây tiến trình theo run; macOS không đo được WebView (dịch vụ XPC, không phải con của app). UI: `ResourceMeter` ở thanh dưới.
- **Tiến trình con:** luôn tạo bằng `env::command` / `env::std_command`, không dùng `Command::new`. Trên Windows nếu thiếu cờ `CREATE_NO_WINDOW`, mỗi tiến trình bật một cửa sổ cmd trống, đóng nó là chết agent. Có test chặn.
- **Mở thư mục:** `project.rs` chuẩn hoá và kiểm tra đường dẫn; `WorkspaceService` chỉ lưu sau khi thành công. Mock mô phỏng lỗi qua chữ trong đường dẫn: `missing`, `nogit`, `nocommit`.
- **Xem source:** Explorer có hai nguồn: dự án (`list_project_files`, tab `source`, `SourceViewer` chỉ đọc) và bản nháp của task. Lõi chỉ cho đọc các root đã qua `open_project` (`OpenedProjects`).
- **Phiên nhiều câu:** một `Run` là một phiên agent sống, không phải một câu. `send_message` gửi câu tiếp, `exit` chỉ phát khi tiến trình kết thúc, `turn_end` đưa run về `idle`. Thời lượng hiển thị đếm từ câu hiện tại (`turnStart`: `turnAt` đặt bởi event `user`), không từ lúc mở phiên. Bước Pipeline dùng `singleTurn` nên vẫn kết thúc bằng `exit`. `drive_session` (`acp_tasks.rs`) giữ vòng đời, tín hiệu dừng được cấp lại cho từng pha. Kiểm tra agent có đang bận qua `TaskRuns::busy`, không qua `contains_key`.
- **Usage nhiều câu:** đo trên adapter Claude thật: token báo theo từng câu, chi phí cộng dồn theo phiên. `TaskSession` cộng token và luôn phát `cumulative: true`; phiên nối lại lấy chi phí trừ `cost_base`.
- **Chế độ duyệt:** adapter kế thừa `defaultMode` trong thiết lập của CLI, có thể là tự duyệt, nên `AcpClient` đặt `session/set_mode` về `default` sau khi mở phiên. Không có bước này thì thẻ duyệt không hiện.
- **Hạn mức:** Codex đọc từ `rate_limits` trong `~/.codex/sessions` (`usage::latest_codex_limits`, trong `account_limits`). Claude từ event của lượt chạy và từ `claude -p /usage --no-session-persistence` (`claude_usage.rs`, lệnh cục bộ, 0 token, Rust chặn ≤ 1 lần/phút, UI gọi mỗi 5 phút hoặc khi bấm). `StatusBar` tải lại mỗi 60 s và khi cửa sổ được focus.
- **Chỉ hỏi chạy trên thư mục thật:** `headless_args` phải luôn kèm cờ chặn ghi của CLI (Claude `--permission-mode plan`, Codex `--sandbox read-only`), vì mặc định của CLI theo thiết lập của người dùng, có thể là tự duyệt. Agent chưa kiểm chứng cờ thì trả về `None`. Test thật: `live_read_only_run_cannot_write`.
- **Chỉ hỏi của Claude là phiên sống:** một tiến trình `claude -p --input-format stream-json --include-partial-messages` cho cả cuộc trò chuyện; câu hỏi là dòng JSON trên stdin (`headless_input`), mỗi dòng `result` phát `turn_end` (run `idle`), `send_message` thử `runner::send_headless` trước ACP. Token cộng qua `usage::SessionTotals`, chi phí lấy số cộng dồn của CLI. Codex vẫn mỗi câu một `exec resume`. Test thật: `live_claude_ask_session_two_questions`.
- **Hàng chờ duyệt:** index của worktree có thể bị agent đổi bằng `git add`/`commit`, nên phần đã nhận lưu ở tệp `tg-accepted` trong git dir của worktree; `diff::pending` khôi phục index từ đó trước khi diff.
- **Gemini, Kiro:** `headless_args` trả về `None`, `detect.rs` dựa vào đó để đặt cờ `headless`; hai agent này chỉ chạy qua ACP (Sửa code).
- **Lịch sử:** `runner.rs` ghi event vào SQLite (`store.rs`) trước khi phát lên UI, và lỗi ghi không được làm hỏng lượt chạy. Lượt nạp lại có `restored: true`, nên logic usage của phiên phải dùng `sessionRuns`, không dùng `runs`.

- **Phiên mở sẵn:** gõ chữ đầu tiên của cuộc trò chuyện Sửa code mới (`direct`, không `reuse`) gọi `warm_task`; `WarmPool` (`warm.rs`) giữ một adapter đã `session/new` với `LateHandler` (gắn `TaskSession` sau) và token tg-bridge `reserve` (gắn bằng `bind`). `start_task` lấy theo `WarmKey` (agent, thư mục, MCP server, bridge), hụt thì mở như cũ. Adapter Claude trả `session/new` sau ~1 s rồi khởi động agent ngầm, nên lợi ích đến từ thời gian người dùng gõ. Chỉ hỏi của Claude/Codex (`runner.rs`) không đi qua đây.
- **Task sửa code:** đi qua `acp_tasks.rs`, không qua `runner.rs`. Logic định tuyến nằm ở `TaskSession` (`acp_runner.rs`), test bằng agent giả `acp/fake.rs`. `stop_agent` dùng chung cho cả hai loại run. Token của task chỉ có trong kết quả `session/prompt`, không có trong `usage_update`.
- **Chạy song song:** các run cùng một yêu cầu có chung `group` (cột `task_id` trong SQLite). "Dùng bản này" đi qua `diff::accept_all`, không lặp `accept_hunk`, để không bao giờ áp dở một run. Lựa chọn của nhóm giữ ở `RunsService.choices`.
- **Pipeline:** các bước nối tiếp dùng chung worktree qua `start_task(reuse)`; `run_worktree` trả về worktree của run gốc (`worktree_owner`). Điều phối nằm ở `PipelineService` phía UI.
- **CSS của Monaco:** esbuild tách CSS mà Monaco import ra file lazy không ai nạp, nên `editor.main.css` được chép thành asset (`angular.json`) và `loadMonaco` tự gắn `<link>`. Kiểm tra editor trên bản build, đừng chỉ trên `ng serve`.
- **tg-bridge:** cùng một file chạy, cờ `--mcp-bridge` (xử lý trong `main.rs` trước Tauri). Logic tool ở `bridge::call_tool` qua trait `ToolEnv` (test bằng env giả); `TaskEnv` trong `acp_tasks.rs` là bản thật. Live test cần `cargo build` rồi `TG_BRIDGE_EXE=target/debug/tg-studio`.
- **MCP:** không ghi vào file cấu hình của agent; server đi vào từng phiên (`mcp::for_acp`, `mcp::claude_config`). Live test MCP dùng `src-tauri/tests/fixtures/mcp/ping-server.js`.
- **Hạn mức gói:** event `limits` thuộc về tài khoản, không thuộc run; `RunsService.apply` xử lý nó trước `upsert`.
- **Xoá cuộc trò chuyện:** `delete_runs` là xoá mềm (`runs.deleted_at`, schema v10): xoá `run_lines`, dọn worktree (bản direct chỉ xoá sổ sách), giữ `usage_events` để màn Chi phí không đổi. `RunsService` nhớ id đã xoá để bỏ event `exit` đến muộn.
- **Chỉ hỏi → làm luôn:** Claude ở `--permission-mode plan` không gọi `ExitPlanMode` mà ghi kế hoạch vào `~/.claude/plans/*.md`; `planProposal` (`core/proposal.ts`) bắt lần ghi đó thành `Run.proposal`, thẻ **Làm luôn** chuyển sang Hỏi trước và gửi kế hoạch. Codex không có tín hiệu tương tự.
- **Skill và lệnh của agent:** adapter ACP gửi `available_commands_update` ngay sau `session/new`; `options::parse_commands` phân loại (Claude: hậu tố ` (project)`/` (user)`, plugin `(tên) …`; Codex: `$tên`, skill dự án nếu có `.agents/skills/<tên>/SKILL.md`). `TaskSession` phát event `commands`; `agent_commands` mở phiên không prompt để đọc trước. UI cache theo agent + thư mục (`AgentsService.commands`), popover `/` (Codex thêm `$`) trong `core/commands.ts`. Test thật: `live_agent_commands_lists_project_skill`.
- **Gửi tin:** `AgentPanel.pending` hiện tin nhắn và "Đang khởi động…" ngay khi bấm gửi, tới khi run mới hoặc event `user` đến; lỗi thì trả chữ về ô chat.
- **Quyền và nơi làm việc:** mọi agent có đủ 3 quyền. `start_task(approval)`: `ask` hiện thẻ duyệt, `auto` để `TaskSession` tự chọn `allow_once` (lệnh cấm trong `policy.rs` vẫn bị chặn, không bao giờ tự chọn "always"), `deny` từ chối mọi yêu cầu và mọi `fs/write_text_file`. Chỉ hỏi của agent không có cờ chặn ghi (Kiro, Gemini) chạy qua ACP với `deny` trong bản nháp tạm, xoá khi phiên kết thúc. `set_approval` đổi quyền của phiên đang mở. `start_task(place)`: `direct` (mặc định ở UI) làm thẳng trong repo; `Worktree` có `branch` rỗng (`is_direct`), `base` là tree chụp thư mục lúc bắt đầu (`worktree::direct`, dùng index tạm trong git dir `tg-direct/`), nên diff chỉ có phần agent sửa; Nhận = stage vào index thật, Bỏ = hoàn tác trên tệp thật; `worktree::remove` với bản direct chỉ xoá tệp sổ sách, không bao giờ đụng repo. `draft` tạo worktree từ nhánh `base` (phải có trong `list_branches`). Nhiều agent luôn dùng bản nháp. Đổi agent hay quyền giữa chừng vẫn giữ `thread` và gửi kèm `recapOf`.
- **Chọn model:** `options.rs` đọc select `model`/`thought_level` trong `configOptions` của phiên ACP (`agent_options` mở phiên không prompt, không tốn token). `start_task(prefs)` áp bằng `session/set_config_option` sau khi mở phiên; `start_agent(prefs)` thêm cờ qua `options::headless_flags`. Lựa chọn lưu theo agent ở `AgentsService.prefs`; `RunsService` tự gửi kèm. Test thật: `live_claude_config_options`.
- **Dòng chat:** `segmentsOf` (`core/timeline.ts`) bỏ tone `muted`/`ok` (event hệ thống, đường dẫn CLI, `✓ success`), gom `tool`/`error` giữa các tin nhắn thành Nhật ký làm việc; `tg-markdown` render tin nhắn (`marked`, Angular sanitize, link không điều hướng cửa sổ). Delta `text_delta` của Claude mang `MESSAGE_KEY` và được `addLine` (`describe-line.ts`) nối lại; bản `assistant` cuối mang `FINAL_KEY`, trùng thì bị bỏ và niêm phong tin nhắn. Lõi không lưu dòng `stream_event` vào SQLite (`runner::is_stream_chunk`), lịch sử dựng lại từ bản cuối. `tg-markdown[animate]` hiện dần theo `nextReveal` (`core/reveal.ts`, ~60 ký tự/giây, tối đa ~3 s mỗi tin), tin nhắn cũ hiện ngay.
- **Thanh tiêu đề:** Windows/Linux tắt decorations trong `setup` (`lib.rs`), nút cửa sổ gọi `AgentBackend.windowAction`; macOS giữ traffic lights. Tên class CSS dùng chung toàn cục, nên đặt tên riêng (từng bị trùng `.hero`, `.seg`, `.stack`).
- **Layout:** `ThreadList` (trái: dự án → cuộc trò chuyện, các màn khác) · `AgentPanel` (giữa: chat, tối đa 760px; thẻ duyệt ghim trên ô chat) · `SidePanel` (phải: `Explorer` + `Workbench`). `SidePanel` luôn được render, chỉ ẩn bằng class, vì nó giữ tệp và diff luôn mới. `WorkspaceService` giữ thư mục/repo, các tab và bộ đệm tệp + diff của từng run (`refresh(runId)`); component nào Accept/Reject hay lưu tệp thì gọi `refresh` để các nơi khác cập nhật. `UiService` giữ màn hình và `sideOpen`; mở một run từ chỗ khác bằng `ui.openRun(id, view)`.
- **Cuộc trò chuyện:** `ThreadsService` gom run theo `Run.thread` (cột `thread_id`; run cũ dùng group hoặc id của nó), chia theo `Run.project`. Trạng thái là dẫn xuất, không lưu. Phạm vi thư mục con là `Run.scope`: nơi agent bắt đầu làm việc, không phải rào chắn (`env::scoped_dir`). Chưa có bảng `threads` như spec, vì chưa có gì cần lưu ngoài run.
- **Cỡ khung:** `LayoutService` (`core/layout.ts`) giữ cỡ cột trái, khung code, cây tệp, khung log (localStorage `tg.layout`) và đặt biến CSS `--w-sidebar`/`--w-side`/`--w-files`/`--h-term` trên `.shell`; chưa kéo thì dùng mặc định trong CSS. Tay kéo là `tg-splitter` (`target` = phần tử anh liền trước hoặc phần tử cha, `grow` = hướng kéo làm to), bấm đúp để về mặc định.
- **Tab xem trước:** bấm một lần ở cây tệp, hoặc Theo agent, mở tab xem trước (chữ nghiêng, `WorkspaceService.previewKey`), tab xem trước tiếp theo thay chỗ nó; bấm đúp hoặc sửa tệp thì giữ tab (`pin`). ⌘P là `QuickOpen` (`core/fuzzy.ts`) trên tệp của dự án. Hai editor dùng chung `EDITOR_OPTIONS` và dòng trạng thái `tg-editor-status` (`core/monaco.ts`).
- **Thanh hunk trong editor:** view zone chỉ để giữ chỗ, thanh nút là content widget, vì lớp chữ của Monaco nằm trên view zone và nuốt click.
- **Phím tắt:** nhãn lấy từ `core/keys.ts` (⌘ trên macOS, Ctrl nơi khác); handler nhận cả `meta` và `control`.
- **Editor:** Monaco tải lazy qua `core/monaco.ts`; worker là `core/editor.worker.ts` (cần `webWorkerTsConfig` và loader `.ttf` trong `angular.json`). Import Monaco qua `monaco-editor/editor/editor.api.js`, không import `monaco-editor` (kéo theo language service).

**Thêm agent mới:** làm theo `docs/ARCHITECTURE.md`.

**Giao việc cho Codex:** nếu đang chạy trong TG Studio (có tool `handoff_to` của tg-bridge) thì giao bằng `handoff_to` để Codex hiện thành cuộc trò chuyện riêng; đừng chạy `codex exec` ngầm (app không thấy nó). Ngoài app: phân công và cách chạy `codex exec` trong worktree nằm ở `docs/superpowers/plans/2026-11-03-roadmap-master.md`.

**Giao diện:** component trong `src/app/shell/` không có style riêng; toàn bộ CSS nằm trong `src/styles.scss`. Chuỗi hiển thị cho người dùng, kể cả lỗi trả về từ Rust, viết bằng tiếng Việt.

Đang làm lại trải nghiệm chính theo `docs/superpowers/specs/2026-11-04-chat-first-design.md`. Giai đoạn 4 (đóng gói) tạm dừng tới sau M5; phần còn lại cần tài khoản/chứng chỉ của chủ repo. Lộ trình nằm trong `docs/02-roadmap.md`, hướng dẫn người dùng ở `docs/user-guide.md`. Phát hành: **mỗi bản build gửi đi đều nâng phiên bản** bằng `npm run release -- patch|minor|major` (nâng mọi nơi, ghi ngày vào CHANGELOG, commit, tag), rồi `npm run build:mac` (universal) và `git push --follow-tags` (xem `docs/07-release.md` §6). **Không workflow nào tự chạy**: CI, Release, Download site đều chỉ chạy khi chủ repo bảo (Actions có hạn phút); đừng tự `gh workflow run`. Trang tải cho người ngoài repo (repo riêng tư): workflow `Download site` build bộ cài, ghép `site/` rồi đẩy sang nhánh `site-dist` (thư mục `site/`); nhánh này có thêm `wrangler.jsonc` nên Cloudflare (Worker: `npx wrangler deploy`; hoặc Pages: output `site`) nối repo trong dashboard và deploy nhánh đó, không build command (§8).
