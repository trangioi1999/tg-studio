# Bàn giao đợt 3 · Làm việc như Claude desktop (2026-11-27)

Ghi chú để làm tiếp ở phiên hoặc tài khoản khác. Đọc hết tệp này trước, rồi mới đọc spec và plan.

## Nhánh và tài liệu

- **Nhánh:** `claude/gallant-wozniak-f489hn`. Đã push hết phần đã commit. Chưa merge vào `main` (`main` đang ở `ca5c649`, có mèo TG).
- **Spec (đã duyệt):** `docs/superpowers/specs/2026-11-27-claude-desktop-parity-design.md`. Mục 11 ghi các quyết định sau khi soát.
- **Mockup:** `docs/mockups/2026-11-27-claude-desktop/` (6 khung, kèm README). Canvas gốc thuộc tài khoản cũ, nên dùng tệp trong repo.
- **Plan theo đợt:**
  - A: `docs/superpowers/plans/2026-11-27-dot-a-one-session.md`
  - B: `docs/superpowers/plans/2026-11-27-dot-b-tokens-context.md`
  - C: `docs/superpowers/plans/2026-11-27-dot-c-composer-cli-lines.md`
  - D: `docs/superpowers/plans/2026-11-27-dot-d-subagents.md`
  - E: `docs/superpowers/plans/2026-11-27-dot-e-agent-board.md`
- **Cách đã làm:** mỗi task của plan giao cho một agent làm (TDD), một agent khác soát (đúng spec và chất lượng code), lỗi quan trọng gửi về sửa rồi soát lại. Hết mỗi đợt có một lượt soát toàn nhánh. Skill `superpowers:subagent-driven-development`.

## Tình trạng

| Đợt | Trạng thái |
|---|---|
| A · Một phiên cho mọi chế độ | **Xong**, lượt soát toàn nhánh sạch (commit `8d1d14b..44b1078`) |
| B · Token và context | **Xong** (`4e0a034..fcfdf07`), soát toàn đợt và soát lại lượt sửa đều sạch |
| C · Ô chat A, dòng kiểu CLI, nhóm Đang chạy | **Xong** (`7e575a7..468c01b`), lượt sửa sau soát đã soát lại: sạch |
| D · Agent con trong chat, cửa sổ lớn | **Xong** (`8e89a91..c111cc5`), soát từng task và soát toàn đợt, đã sửa các điểm Important |
| E · Bảng agent | **Xong** (Task 1 + 2 + lượt sửa sau soát toàn đợt: Approved) |

### Cập nhật 2026-11-28 (đợt C, D, E xong)

Kiểm tra lúc dừng: npm test 404, cargo 445 / 16 bỏ qua, build qua. Chưa merge `main`.

Việc nhỏ còn lại (đã soát, cho phép hoãn):
- README dòng 13 và 67–69 vẫn tả màn "Giám sát" cũ, ảnh `docs/images/mission-control.png` cần chụp lại.
- `mission-control.ts`: `queue` còn dựng mục approve/commit không ai hiện, chỉ `reviewCount` dùng.
- Bảng agent: đóng cửa sổ lớn khi thẻ mở nó đã rời bộ lọc thì focus rơi về body; `aria-label` của thẻ che mất nội dung thẻ với trình đọc màn hình.
- Trình đọc chữ ở thẻ hiện markdown thô (`**...**`).
- Test thật với tài khoản Claude (mục dưới) vẫn chỉ chủ repo chạy được.

### Cập nhật 2026-11-27 tối (phiên trên máy chủ repo)

Mỗi task: subagent làm, subagent khác soát; một số task giao Codex (`codex exec` trong worktree `../tg-studio-wt/<task>`, Claude commit và soát). Kiểm tra lúc dừng: npm test 353, cargo 442, build qua.

Việc làm tiếp, theo thứ tự:
1. **Soát lại `468c01b`** (sửa sau soát đợt C) theo `2026-11-27-findings/dot-c-final-findings.md`. Lưu ý: test "Nhắn thêm…" chỉ dựng được khi `ChatState.mode` khác chế độ của run.
2. **Đợt D task 1** (terminal nhỏ): nhánh `claude/d1-terminal` (`1705be3`, base `0d34482`), đã soát: Approved. Còn một điểm Important: "một agent con mở trong một tin nhắn" mới đúng trong từng `tg-delegations`; tin có nhiều dấu giao việc thì mở được nhiều cái. Cách sửa: giữ khoá mở theo `parent.id` ở service dùng chung. Điểm nhỏ:
   - `view` chạy lại `segmentsOf` mỗi giây.
   - Run `idle` vẫn đếm giờ.
   - Một chú thích test sai.

   Sửa xong thì cherry-pick vào nhánh chính.
3. **Đợt D task 3, phần Rust** (agent con direct lấy phiên mở sẵn): nhánh `codex/d3-warm` (`330becd`). Soát ra lỗi **Critical**: phiên mở sẵn chạy tg-bridge không có `TG_BRIDGE_CHILD`, nên agent con thấy `delegate` và `handoff_to`, mà `handoff_to` không chặn agent con. Quyết định sửa và test cần thêm nằm trong `2026-11-27-findings/dot-d-task-3-findings.md`:
   - Agent con chỉ lấy phiên mở sẵn khi tg-bridge tắt.
   - Chặn `handoff_to` và nhóm tool giao việc ở `TaskEnv` của agent con.

   Lượt sửa của Codex bị dừng giữa chừng: worktree có thể còn thay đổi dở chưa commit. Xem `git -C ../tg-studio-wt/d3-warm diff`, bỏ nếu không chắc. **Không** cherry-pick `330becd` khi chưa sửa.
4. Đợt D: task 2 (cửa sổ lớn), rồi phần UI của task 3 (dòng subagent trong `delegations.ts`, mock có subagent Claude). Phần UI làm sau task 1 vì task 1 viết lại `delegations.ts`. Cuối đợt soát toàn đợt.
5. Đợt E.

Quyết định đã đưa ra trong phiên này (giá phải trả nếu sai):
- Plan B ghi `agent-backend.ts`, tệp thật là `core/backend.ts`. Không tốn gì.
- Số token dùng `fmtTokens` (dấu chấm: `~1.5k`) ở mọi nơi, kể cả bảng context. Sai thì đổi một hàm.
- Chấp nhận: thẻ nhắc thu gọn có thể hiện lại một thoáng sau `/compact`; giới hạn 5 s của `refresh_context` không nguyên tử. Giá: hiện cũ một thoáng.
- Nhãn "Tự động"/"Sửa code" → "Tự làm"/"Hỏi trước" sửa ở lượt soát cuối đợt C, không mở vòng sửa riêng.
- Giữ việc chặn gửi giữa lượt; chỉ đổi câu gợi ý khi đang chạy. Sai thì sửa một câu.
- Bấm dòng agent con ở nhóm Đang chạy mở run cha (plan ghi `openRun(id)`). Sai thì dòng con mở chat của cha thay vì con.
- Đợt D task 3: tách phần Rust (Codex làm trước) và phần UI (sau task 1). Agent con chỉ lấy phiên mở sẵn khi tg-bridge tắt. Giá: tg-bridge bật (mặc định) thì agent con không nhanh hơn.

Mèo TG (`tg-mascot`, `tg-dock-mascot`, `public/mascot/`) đã có trên `main` từ trước.

### Việc dở ngay lúc bàn giao: soát lại lượt sửa task 2 của đợt B

Lượt soát task 2 tìm ra hai điểm. Agent đã sửa ở commit `6330492`:
- `refresh_context` đổi thành `#[tauri::command(async)]`, và `ask_context` spawn bằng `tauri::async_runtime::spawn`. Có test mới `context_refresh_works_outside_a_runtime`.
- `set_approval` đã đổi lại thành `#[tauri::command(async)]`.

Lúc đó cargo test 440 qua, 0 cảnh báo. **Chưa có agent soát lại** phần sửa này. Việc đầu tiên: soát diff `31f9e44..6330492` theo hai điểm trên, rồi sang task 3 của đợt B.

## Môi trường (container cloud)

- Cần thư viện hệ thống để `cargo test` biên dịch được Tauri trên Linux:

  ```bash
  apt-get update && apt-get install -y libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev build-essential pkg-config libssl-dev
  ```

- Lần build Rust đầu mất vài phút.
- Claude CLI 2.1.332 có sẵn (`claude`) nhưng **chưa đăng nhập**.
  - Chỉ gửi lệnh điều khiển (`initialize`, `get_context_usage`, `set_permission_mode`…). Các lệnh này 0 token.
  - **Không bao giờ gửi câu hỏi thật**: câu hỏi sẽ lỗi, hoặc tốn token nếu máy có đăng nhập.
- Ba lệnh kiểm tra trước khi xong mỗi task:

  ```bash
  npm run build
  ```

  ```bash
  npm test -- --watch=false
  ```

  ```bash
  (cd src-tauri && cargo test)
  ```

  Lúc bàn giao: build qua, Vitest 311, cargo 440 qua / 16 bỏ qua (test thật), 0 cảnh báo.

## Đợt A đã làm gì (để người làm tiếp hiểu lõi)

- **`AgentConn`** (`src-tauri/src/acp/conn.rs`): trait mà `drive_session` dùng. Có hai cài đặt: `AcpClient` (Codex, Gemini, Kiro, và Claude khi `TG_CLAUDE_ACP=1`) và `ClaudeConn`.
- **`ClaudeConn`** (`src-tauri/src/acp/claude_conn.rs`): "adapter trong tiến trình".
  - Đọc stream-json của `claude -p` rồi dịch sang đúng hình dạng ACP mà `TaskSession` vẫn dùng: tin nhắn, `tool_call`, `can_use_tool` → `session/request_permission`, interrupt, `set_permission_mode`, `set_model`, subagent → run `<cha>~n`, `rate_limit_event`, và (đợt B) `_tg/progress` / `_tg/context`.
  - Đầu tệp ghi các điều đã kiểm chứng với CLI và SDK.
  - Agent giả để test: `src-tauri/src/acp/fake_claude.rs`.
- **Chế độ:** Chỉ hỏi = `deny` + `--permission-mode plan`; Hỏi trước = `default`; Tự làm = `acceptEdits`.
  - Lệnh luôn có `--permission-prompt-tool stdio --permission-prompts host`.
  - Host từ chối mọi thao tác ghi ở Chỉ hỏi. Ngoại lệ duy nhất là `~/.claude/plans/`: đã chuẩn hoá đường dẫn, chặn `..` và symlink.
- **Chỉ hỏi của Claude:**
  - Là task `deny` làm thẳng trong thư mục (`Place::Direct`).
  - Thư mục chưa phải repo git hoặc chưa có commit: vẫn chạy qua `headless.rs` cũ (spec §11.4).
  - Chỉ hỏi không bao giờ lấy phiên mở sẵn.
- **Đổi chế độ giữa phiên:** UI dùng `canSwitchLive` (`src/app/services/runs/run.ts`) rồi gọi `setApproval`. Rust `set_approval` gọi hook → `set_permission_mode`. Gemini/Kiro rời Chỉ hỏi (bản nháp tạm) bị từ chối, UI mở phiên mới kèm ghi chú.
- **"Làm luôn":** đọc lần ghi kế hoạch từ event `tool` (`toolProposal` trong `features/chat/dock/proposal.ts`), rồi `setApproval('ask')` và gửi kế hoạch trong cùng phiên.
- **Nối lại phiên:**
  - Có kiểm tra tệp phiên trước khi nạp.
  - CLI từ chối `--resume` thì chạy lại `claude -p` không kèm `--resume` và gửi recap.
- **Giữ nguyên (spec §11.1):** `tasks/headless.rs`, `start_agent`, `claude-agent-acp`. Chỉ xoá sau khi chủ repo chạy test thật và báo qua. Codex Chỉ hỏi vẫn dùng `codex exec`.

## Việc chỉ chủ repo làm được: test thật với tài khoản Claude

Chạy trên máy đã đăng nhập Claude (tốn token):

```bash
cd src-tauri && TG_LIVE_ACP=1 cargo test live_claude_native -- --ignored --nocapture
```

Các test: hai câu cùng phiên; Chỉ hỏi không ghi được tệp; Chỉ hỏi → Hỏi trước giữ trí nhớ, có thẻ duyệt; mở phiên 0 token. Cần kiểm thêm bằng tay trong app desktop:

- Thẻ duyệt hiện ở Hỏi trước.
- "Làm luôn" hiện sau một câu Chỉ hỏi.
- Esc dừng giữa lượt.
- Subagent của Claude hiện thành dòng riêng.
- `/compact`.
- Model chọn ở ô chat được `--model` nhận.

Nếu thẻ duyệt không về (luồng `can_use_tool` hỏng), đặt `TG_CLAUDE_ACP=1` để quay về đường cũ (spec §11.1).

## Quyết định đã tự đưa ra khi chạy (giá phải trả nếu sai)

**Đợt A**
- Thư mục home lấy bằng `crate::agents::detect::home_dir()`, không thêm crate `dirs`. Sai thì đổi một dòng.
- Fixture xác định usage theo lượt là `tests/fixtures/claude/2.1.318/ask-session.jsonl` (plan ghi nhầm 2.1.319). Không tốn gì.
- `native_args` truyền cả `--permission-prompt-tool stdio` và `--permission-prompts host`; CLI 2.1.332 nhận cả hai. Sai thì thẻ duyệt không về; test thật sẽ bắt được.
- Chỉ hỏi của Claude không lấy phiên mở sẵn, để chế độ plan luôn nằm sẵn trên dòng lệnh. Sai thì Chỉ hỏi khởi động chậm hơn khoảng 1 s.
- Chế độ Hỏi trước gửi `"default"`; CLI nhận cả `"default"` lẫn `"manual"`.

**Đợt B**
- Với Claude chỉ dùng token thật. Số ước lượng `~` chỉ hiện khi phiên chưa nhận `_tg/progress` nào. Sai thì Claude hiện `~` một thoáng trước khung số thật đầu tiên.
- Chỉ hỏi của Claude ở thư mục không phải repo (đường `headless.rs`) không có token theo thời gian thực, không có context.

## Việc nhỏ để sau (đã được soát và cho phép hoãn)

- **Lịch sử nạp lại:**
  - Không có thẻ "Làm luôn" (`restoreRun` không phát lại dữ liệu tool).
  - `reattach` không giữ `proposal`.
- **Đổi chế độ:** chỉ áp ở lần gửi sau, chưa áp giữa lượt (spec §4.2 muốn áp cho thao tác kế tiếp).
- **Thông báo lỗi:**
  - Câu "Không đọc được phiên ACP." ở `set_approval` còn chữ ACP.
  - UI nhận ra lỗi "rời Chỉ hỏi trong bản nháp tạm" bằng cụm chữ "bản nháp tạm" (test Rust giữ cụm này).
- **Thư mục và lưu trữ:**
  - Ngoại lệ thư mục plans dùng `$HOME/.claude/plans`, còn kiểm tra tệp phiên theo `CLAUDE_CONFIG_DIR`. Nên thống nhất.
  - Mỗi câu Chỉ hỏi của Claude chụp thư mục vào index tạm `.git/tg-direct/`, chậm hơn với repo lớn.
  - Thư mục vừa thành repo giữa cuộc trò chuyện thì câu sau mở phiên mới kèm recap.
- **Model và lệnh:**
  - Danh sách model và lệnh của Claude vẫn lấy từ adapter `claude-agent-acp` (npx).
  - Giá trị model chưa kiểm chứng với `--model`.
- **Phiên đóng và nối lại:**
  - Task sửa code chưa có đường lùi khi phiên "đã đóng".
  - Đường lùi "đã đóng" của Chỉ hỏi có thể lặp một dòng tin của người dùng trong lịch sử.
  - Khi đang kiểm tra nạp lại phiên (tối đa 30 s), nút Dừng chưa có tác dụng.
  - `initialize` chậm có thể mất khoảng 60 s mới báo lỗi.
- **CHANGELOG:** thêm một dòng: cuộc trò chuyện Chỉ hỏi cũ (trước bản này) nối tiếp bằng recap, không `--resume`.
- **Đợt B:** kiểm tra và đóng dấu giới hạn 5 s của `refresh_context` không nguyên tử. Một lần tự hỏi context bị lỗi chặn làm mới trong 5 s.

## Làm tiếp thế nào

1. Đọc mục "Việc dở" ở trên, soát lại lượt sửa task 2 đợt B.
2. Chạy tiếp plan đợt B từ task 3 (UI: `Run.live`, `Run.context`, dòng trạng thái có token), rồi task 4 (chip, bảng context, nhắc thu gọn). Cuối đợt soát toàn nhánh.
3. Lần lượt chạy plan đợt C, D, E. Mỗi plan có mục "Phụ thuộc" ghi nó cần gì từ đợt trước.
4. Mỗi task: commit trên nhánh, push. Không merge `main` khi chủ repo chưa bảo.
5. Thư mục `.superpowers/sdd/` (sổ theo dõi khi chạy) bị git bỏ qua nên không có trong repo. Ghi chú này thay cho nó.
