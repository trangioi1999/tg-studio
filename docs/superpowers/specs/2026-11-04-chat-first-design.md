# TG Studio — Thiết kế lại trải nghiệm chính (chat-first)

- **Ngày:** 2026-11-04
- **Trạng thái:** chờ chủ repo duyệt
- **Tham chiếu:** Claude desktop, [T3 Code](https://github.com/pingdotgg/t3code) (mới đọc README và tên component, chưa chạy thử)

Quy ước trong tài liệu: **[Chủ repo]** là điều chủ repo đã nói hoặc đã chốt. **[Đề xuất]** là quyết định của người viết, chủ repo có thể đổi khi duyệt. **[Cần kiểm chứng]** là điều phải chạy thử với CLI thật trước khi code dựa vào nó.

## 1. Ý định

Chủ repo dùng thử và thấy app chưa thân thiện: không biết nạp source vào đâu, không chọn được thư mục từ máy, nhập đường dẫn lỗi liên tục, mỗi lần bật lại chạy lệnh dò AI, và trên Windows hễ gửi prompt là bật cửa sổ cmd rồi treo. **[Chủ repo]** chốt hướng: bố cục giống Claude desktop và T3 Code, nhưng giữ thế mạnh riêng.

TG Studio trở thành **phòng chỉ huy agent**: mở ra đơn giản như một app chat, các tính năng mạnh chỉ hiện khi cần.

**[Chủ repo] Mục tiêu trước mắt:** sớm nhất có thể, chủ repo dùng chính app này để xem và điều phối Claude cùng Codex xây tiếp chính project này. Vì vậy thứ tự làm ưu tiên mốc **M-D** (mục 11): sửa vừa đủ để dùng thật trên giao diện hiện tại, rồi làm các mốc lớn ngay trong app.

Lời hứa cốt lõi vẫn giữ: nhiều agent cùng làm một việc, so sánh và ghép kết quả, code thật chỉ đổi khi người dùng duyệt, chi phí trung thực.

## 2. Mục tiêu và giới hạn

**Mục tiêu**
1. Người mới đi hết 3 bước mà không cần đọc hướng dẫn: **mở thư mục → gõ yêu cầu → xem agent làm và duyệt**.
2. Chat nhiều lượt thật trong một cuộc trò chuyện. Hiện app chưa làm được (mục 3).
3. Xem được source ngay khi mở dự án, không cần giao việc trước.
4. Mở app không phải chờ dò agent, không có cửa sổ cmd nào trên Windows.
5. Mọi trạng thái chờ và mọi lỗi đều nói rõ bằng tiếng Việt: chuyện gì xảy ra và làm gì tiếp theo.

**Không làm trong đợt này**
- Terminal thật, sửa code trực tiếp kiểu VS Code, LSP, extension.
- Mobile, web, điều khiển từ xa, chạy trên cloud.
- Agent mới. Command palette. Theme sáng.
- Khôi phục phiên agent bằng `session/load` (dùng tóm tắt thay thế, mục 8.3).

**Coi là thất bại nếu**
- Code thật của người dùng đổi mà chưa được duyệt.
- Mất bản nháp hoặc lịch sử cũ sau khi nâng cấp.
- Giao diện đẹp hơn nhưng Song song, So sánh hoặc số liệu chi phí bị mất hay sai.
- App trông như đang chạy trong khi thực ra đã treo mà không báo.

**Tiêu chí của M-D (đến trước)**
- Trên macOS, mở repo `tg-studio` bằng hộp thoại, giao cùng một việc nhỏ cho Claude và Codex, xem cả hai chạy trong Giám sát, duyệt lệnh, so sánh, nhận một bản, commit, mà không rời app.

**Tiêu chí nghiệm thu tổng**
- Máy Windows sạch, bản cài: gửi prompt không bật cửa sổ nào, agent trả lời, gửi câu tiếp được, agent còn nhớ câu trước.
- Mở app khi đã có cache: danh sách agent hiện trong dưới 1 giây.
- Chọn thư mục bằng hộp thoại hệ điều hành chạy được trên macOS và Windows, kể cả đường dẫn có dấu cách và dấu tiếng Việt.

## 3. Thực trạng đã kiểm chứng

| Vấn đề | Bằng chứng trong code |
|---|---|
| Mỗi lượt chạy chỉ nhận một prompt, xong là tắt adapter | `drive()` trong `acp_tasks.rs` gọi `prompt_turn` một lần, rồi `terminate_adapter`; ô giao việc luôn tạo run mới |
| Chỉ xem được tệp của worktree | `explorer.ts`, `Tab.file` bắt buộc có `runId`, `workspace.rs` chỉ nhận `Worktree` |
| Không có hộp thoại chọn thư mục | Không có `tauri-plugin-dialog` trong `Cargo.toml`, `package.json`, `capabilities/default.json` |
| Đường dẫn sai bị lưu lại | `WorkspaceService.setFolder` ghi `localStorage` trước khi kiểm tra |
| Thư mục mặc định là home | `WorkspaceService.init` |
| Lỗi thật không hiện | `title-bar.ts` chỉ có nhãn "không phải repo Git", không đọc `repoError` |
| `~`, dấu ngoặc kép, đường dẫn tới tệp đều hỏng | Thử trực tiếp với `git -C`; `worktree::root` không chuẩn hoá |
| Mock che lỗi đường dẫn | `MockBackend.repoInfo` chấp nhận mọi chuỗi khác rỗng |
| Dò agent chậm mỗi lần mở | `App` gọi `refresh()`; `detect.rs` chạy tuần tự; đo trên máy dev: shell 1,6 s, `claude --version` 4,3 s, `codex --version` 0,12 s |
| Đọc PATH có thể treo vô hạn | `env::read_login_path` chạy `$SHELL -ilc` không có timeout |
| Cửa sổ cmd trên Windows | **Đã sửa** ở nhánh `fix/windows-hide-console`, chờ thử trên máy Windows thật |
| Đồng hồ đứng ở 0s | `agent-panel.ts`, `duration()` dùng `Date.now()` trong template, không có tín hiệu cập nhật |
| Thẻ duyệt bị khuất ở cửa sổ 1024×640 | Ảnh chụp mock mode |
| Worktree không chứa tệp chưa commit | `worktree::create` dựng từ `HEAD`; không có cảnh báo nào |
| Bước sau của Pipeline ghi đè run của bước trước | `prepare()` tạo id mới nhưng trả `wt` cũ, `start_task` lại lấy `wt.run_id` làm id. **Phải sửa trước khi dùng `reuse` cho nhiều lượt** |
| Lượt dừng vì `max_tokens`, `refusal`, `cancelled` vẫn ghi là xong | Nhánh `Ok(result)` trong `drive()` không đọc `stopReason` |
| Gói Codex đang ghim đã ngừng phát triển | `@zed-industries/codex-acp@0.16.0` vẫn bắt tay được trên máy dev (báo `loadSession: true`), nhưng npm báo đã thay bằng `@agentclientprotocol/codex-acp` |

**Review tĩnh của Codex (2026-11-04), người viết chưa xác minh hết.** Toàn văn 18 mục được lưu ở `docs/superpowers/specs/2026-11-04-codex-review.md`. Mỗi mục được chọn để sửa phải xác minh lại trước, viết test tái hiện rồi mới sửa. Các mục ảnh hưởng thiết kế này: thay đổi agent đã `git add` biến mất khỏi hàng chờ (#5); có thể mất notification cuối lượt (#6, phải chốt trước khi giữ phiên nhiều lượt); commit lấy cả phần người dùng tự stage (#8); nạp lại webview làm mất thẻ duyệt (#9); bấm gửi hai lần tạo hai lượt tính phí (#14); `Always allow` trên Windows quá rộng với `.exe` / `.cmd` (#4); ô Commit biến mất sau khi Nhận từ editor (#12).

## 4. Khái niệm

| Khái niệm | Định nghĩa | Ánh xạ vào code hiện có |
|---|---|---|
| **Dự án** | Một thư mục người dùng đã mở | Mới, bảng `projects` |
| **Cuộc trò chuyện** (Thread) | Chuỗi lượt trên một dự án, chế độ cố định từ câu đầu | Mới, bảng `threads` |
| **Lượt** (Turn) | Một câu của người dùng và phản hồi của agent | **Chính là `Run` hiện có** |
| **Bản nháp** (Draft) | Worktree chung của cả cuộc trò chuyện | Worktree + `worktree_owner` đã có |

**[Đề xuất]** Lấy lượt = run để giữ nguyên ledger usage, lịch sử, mission control và budget, thay vì đổi nghĩa của run.

**Thuật ngữ hiện trên UI.** Trong code vẫn giữ tên tiếng Anh.

| Hiện tại | Đổi thành |
|---|---|
| worktree | bản nháp |
| hunk | đoạn thay đổi |
| repo | dự án (chỉ nói "repo Git" khi nói riêng về Git) |
| Accept / Reject | Nhận / Bỏ |
| Allow once / Always allow / Deny | Cho phép lần này / Luôn cho phép `<lệnh>` / Từ chối |
| Use this / Dùng bản này | Dùng bản này |
| Chỉ đọc | Chỉ hỏi |
| Pipeline | Theo các bước |
| Song song | Thử với nhiều agent |
| Mission control | Giám sát |
| Integrations | Kết nối (nằm trong Cài đặt) |
| reported / estimated | CLI báo / ước tính |

## 5. Luồng người dùng

### 5.1 Mở lần đầu
1. Màn **Bắt đầu**: nút chính **Mở thư mục**, danh sách dự án gần đây (nếu có), liên kết phụ "Nhập đường dẫn".
2. Agent được dò ở nền, hiện gọn dưới nút. Không có onboarding dạng hộp thoại nhiều bước.
3. Chọn thư mục xong vào ngay màn chính, con trỏ ở ô chat.
4. Trạng thái nào thiếu thì báo đúng chỗ khi cần (mục 5.2, 5.3), không chặn từ đầu.

Nếu chưa có agent nào: ô chat khoá, trong khu vực trò chuyện hiện thẻ **Cài một agent** với lệnh cài và nút Chép, Dò lại.

### 5.2 Mở thư mục
Đầu vào: hộp thoại hệ điều hành, đường dẫn gõ tay, hoặc kéo thả thư mục vào cửa sổ.

Lõi kiểm tra trước, **chỉ lưu khi hợp lệ** (mục 8.1). Kết quả:

| Tình huống | App làm gì |
|---|---|
| Repo Git có commit | Vào luôn, đủ mọi chế độ |
| Thư mục con trong repo | Mở repo gốc, báo nhẹ: "Đã mở dự án `<tên>` chứa thư mục này" |
| Repo chưa có commit | Vào được; chế độ Sửa code hiện nút **Tạo commit đầu tiên** |
| Không phải repo Git | Vào được, chế độ Chỉ hỏi dùng ngay; chế độ Sửa code hiện nút **Khởi tạo Git** |
| Đường dẫn trỏ tới tệp | Mở thư mục chứa tệp đó |
| Không tồn tại / không có quyền | Giữ nguyên dự án cũ, hiện lỗi ngay tại ô nhập |
| Dự án gần đây đã bị xoá | Hiện "không còn tồn tại", có nút Bỏ khỏi danh sách |

### 5.3 Chuẩn bị Git (chỉ khi người dùng bấm)
Hộp xác nhận cho biết số tệp sẽ được commit. **Không bao giờ âm thầm commit tệp nhạy cảm:**
- Nếu không có `.gitignore` mà thư mục có `node_modules`, `.env*`, `*.pem`, `*.key`, `id_rsa*`: đề xuất tạo `.gitignore` chặn chúng, hiện nội dung để người dùng xem trước.
- Git chưa cấu hình tên hoặc email: hỏi và lưu mức repo (`git config --local`).

### 5.4 Một cuộc trò chuyện Sửa code
1. Gõ yêu cầu, Enter. Câu đầu làm tiêu đề (cắt ở 80 ký tự).
2. Nếu dự án có tệp chưa commit: cảnh báo một lần trước khi tạo bản nháp: "Bạn có N tệp chưa commit. Bản nháp bắt đầu từ commit mới nhất nên agent sẽ không thấy chúng." Chọn Tiếp tục hoặc Hủy.
3. Agent chạy. Luồng hiện tin nhắn, thao tác gom nhóm, kế hoạch.
4. Cần duyệt lệnh: thẻ duyệt nằm trong luồng **và** ghim ngay trên ô chat, nên không bao giờ bị khuất. Thẻ ghim có đầy đủ nút thao tác; thẻ trong luồng chỉ là bản ghi sau khi đã xử lý.
5. Xong lượt: thẻ tóm tắt "Đã đổi N tệp, +a −b" với **Xem thay đổi** và **Nhận tất cả**. Panel phải tự mở một lần nếu chưa mở.
6. Gõ tiếp để chat tiếp trên cùng bản nháp, agent nhớ ngữ cảnh.
7. Nhận từng đoạn hoặc tất cả, rồi commit. Commit xong vẫn chat tiếp được: bản nháp giữ nguyên, phần chờ duyệt chỉ còn những gì chưa nhận.

**[Đề xuất] Phạm vi commit.** Trước khi commit, ô Commit liệt kê **mọi tệp đang staged** trong dự án. Tệp không đến từ cuộc trò chuyện này (người dùng tự stage, hoặc nhận từ cuộc khác) được đánh dấu riêng, kèm câu cảnh báo. Không tự bỏ tệp nào khỏi commit.

**[Đề xuất] Bản nháp là ảnh chụp, không tự đồng bộ.** Khi dự án thật có commit mới hoặc đổi nhánh, bản nháp giữ nguyên. Cuộc trò chuyện hiện "Dự án đã có N commit mới so với bản nháp". Đoạn nào không áp được thì báo theo mục 7 và không đổi gì; người dùng mở cuộc trò chuyện mới nếu cần code mới nhất.

**[Đề xuất] Xem thay đổi của lượt cũ.** Thẻ tóm tắt lưu số liệu lúc lượt kết thúc. Nút **Xem thay đổi** luôn mở trạng thái **hiện tại** của bản nháp. Không lưu ảnh chụp theo lượt trong đợt này.

**Đổi agent giữa chừng:** gõ `@codex ...` hoặc đổi trong ô chọn. Agent mới làm trên cùng bản nháp, nhận tóm tắt (mục 8.3). Luồng ghi rõ "Chuyển sang Codex".

### 5.5 Chỉ hỏi
Chạy ở thư mục dự án, không tạo bản nháp, không cần Git. Hỏi tiếp bằng cách nối phiên của CLI (mục 8.4).

**[Đề xuất]** Vì chạy trên code thật, chế độ này phải **chặn ghi bằng cờ của CLI**, không dựa vào việc agent tự giác (mục 8.4). Agent nào chưa kiểm chứng được cờ chặn ghi thì không hiện chế độ Chỉ hỏi.

### 5.6 Thử với nhiều agent
Chọn từ menu trong ô chat. Một cuộc trò chuyện có N nhánh (cùng `group`). Trong luồng hiện thẻ so sánh rút gọn, **So sánh** mở panel phải với màn So sánh và Ghép thủ công hiện có.

Trong lúc chưa chọn bản, ô chat khoá và ghi "Chọn một bản để chat tiếp". **[Đề xuất]** Sau khi chọn bản, chat tiếp bằng agent của bản đó, trên bản nháp của chính nó. Hiện tại luồng "Dùng bản này" dọn worktree của cả nhóm sau commit: phải đổi thành **chỉ dọn các bản không được chọn**. Tóm tắt và ngữ cảnh chỉ lấy lượt của nhánh được chọn, không lấy nhánh đã bỏ. Nếu đã ghép thủ công thì cuộc trò chuyện kết thúc, ô chat mời mở cuộc trò chuyện mới.

### 5.7 Theo các bước
Giữ nguyên `PipelineService`. Các bước là các lượt trong cùng cuộc trò chuyện, chạy nối tiếp trên một bản nháp. Xong bước cuối, chat tiếp với agent của bước cuối.

### 5.8 Dừng và lưu trữ
- **Dừng** thay cho nút gửi khi đang chạy. Không xếp hàng câu tiếp theo trong đợt này.
- **Lưu trữ** chỉ ẩn khỏi danh sách, không xoá gì.
- **Bỏ bản nháp** cần xác nhận. App không tự xoá bản nháp đang có thay đổi chờ duyệt.

## 6. Bố cục

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ▣ tg-studio ▾   main                               ● CL đang sửa  ● CX cần bạn │ 40
├────────────┬──────────────────────────────┬───────────────────────────────┤
│ + Trò chuyện│                              │ Thay đổi │ Tệp │ So sánh    ×│
│   mới      │    Thêm validate form        │ ───────────────────────────── │
│            │                              │ src/login.ts          M +12 −3│
│ CẦN BẠN    │ ┌ Bạn ────────────────────┐  │  ┌ đoạn thay đổi ──────────┐  │
│ ● Validate │ │ Thêm validate cho form… │  │  │ + if (!email) return…   │  │
│            │ └─────────────────────────┘  │  │       [Bỏ]  [Nhận ⌘↵]   │  │
│ ĐANG CHẠY  │ CL Claude Code · 42s         │  └─────────────────────────┘  │
│ ● Sửa CI   │ Mình sẽ chạy test trước…     │                               │
│            │ ▸ 3 thao tác                 │                               │
│ GẦN ĐÂY    │ ┌ Đã đổi 2 tệp, +12 −3 ───┐  │                               │
│ Refactor…  │ │ [Xem thay đổi][Nhận hết]│  │                               │
│ Hỏi về API │ └─────────────────────────┘  │                               │
│            │ ┌ Cần bạn duyệt: npm test ┐  │                               │
│            │ │ [Từ chối][Luôn][Lần này]│  │                               │
│ Giám sát ②│ └─────────────────────────┘  │                               │
│ Chi phí    │ ┌─────────────────────────┐  │                               │
│ Cài đặt    │ │ Gõ yêu cầu…             │  │                               │
│            │ │ Sửa code▾ Claude▾ ＋    ↑│  │                               │
│            │ └─────────────────────────┘  │                               │
├────────────┴──────────────────────────────┴───────────────────────────────┤
│ 1 agent đang chạy                                     Hôm nay $0.42 / $5.00│ 24
└───────────────────────────────────────────────────────────────────────────┘
```

**Kích thước.** Sidebar 260 px, thu gọn bằng ⌘B / Ctrl+B. Cột chat tối đa 760 px, căn giữa. Panel phải mặc định đóng; mở ra rộng 45 % vùng còn lại, kéo được, tối thiểu 420 px, nhớ độ rộng theo máy.

**Cửa sổ hẹp.** Dưới 1200 px sidebar tự thu gọn. Dưới 1100 px panel phải thành lớp phủ trên khu vực chat, có nút đóng. Cỡ tối thiểu 1024×640 vẫn phải thấy đủ thẻ duyệt và nút của nó.

**Quy tắc panel phải**
- Tự mở đúng một lần mỗi cuộc trò chuyện, khi lượt đầu có thay đổi. Người dùng đã đóng thì không tự mở lại.
- Tab **Tệp**: công tắc **Dự án / Bản nháp**. Dự án là chỉ đọc, có dòng "Chỉ đọc. Giao cho agent để sửa." **[Đề xuất]**
- Chế độ "Theo agent" nằm ở tab Tệp, giữ nguyên hành vi. Không tự chuyển tab khi người dùng đang ở tab Thay đổi.

**Sidebar**
- Nhóm cuộc trò chuyện theo trạng thái: Cần bạn, Đang chạy, Có thay đổi chờ duyệt, Gần đây. Trạng thái luôn có chữ, không chỉ màu.
- **Giám sát** luôn nằm ở chân sidebar, nhưng chỉ nổi lên với huy hiệu khi có từ 2 agent chạy hoặc có hàng chờ. **[Đề xuất]**
- **Cài đặt** gồm: Agent, Kết nối (MCP, Skills, tg-bridge), Ngân sách và giá, Chẩn đoán.
- **Chi phí** mở màn Usage hiện có.

**Khu vực chat**
- Thao tác của agent gom thành một dòng "▸ N thao tác", bấm để mở.
- Mỗi lượt có nút **Chi tiết** hiện log thô và stderr (thay cho panel Terminal).
- Cuối mỗi lượt có một dòng nhỏ: token và chi phí kèm nhãn nguồn.

**Ô chat**
- Enter gửi, Shift+Enter xuống dòng. **Bắt buộc bỏ qua Enter khi `event.isComposing`** để không gửi nhầm khi gõ tiếng Việt bằng bộ gõ IME.
- Chọn chế độ (Sửa code / Chỉ hỏi), chọn agent, menu ＋ (Thử với nhiều agent, Theo các bước).
- Lý do không gửi được hiện ngay dưới ô chat, kèm nút xử lý nếu có.
- Chế độ cố định sau câu đầu của cuộc trò chuyện.

**Phím tắt.** Giữ ⌘↵ / ⌘⌫ cho Nhận / Bỏ khi tiêu điểm ở panel thay đổi và cho duyệt lệnh khi có thẻ duyệt. Khi tiêu điểm ở ô chat, Enter chỉ gửi tin nhắn.

**Sắp xếp lại component**

| Hiện có | Xử lý |
|---|---|
| `DiffViewer`, `CodeEditor`, `Compare`, `Mixer`, `PermissionCard`, `MissionControl`, `UsageScreen`, `Integrations` | Giữ, chỉ đổi chỗ và thuật ngữ. `CodeEditor` thêm chế độ chỉ đọc |
| `AgentPanel` | Tách thành `Conversation` và `Composer` |
| `Explorer` | Tách cây tệp thành `FileTree`; phần Worktrees bỏ |
| `Workbench` | Thành `SidePanel` |
| `Terminal` | Bỏ, thay bằng Chi tiết theo lượt |
| `AgentsPanel`, `Onboarding` | Thành `Settings > Agent` và màn `ProjectStart` |
| Activity bar | Bỏ |
| Mới | `ProjectStart`, `ThreadList`, `Settings`, `ProjectService`, `ThreadsService` |

Quy tắc repo vẫn áp dụng: không có style riêng trong component, CSS ở `src/styles.scss`, màu chỉ dành cho danh tính agent, chuỗi hiển thị bằng tiếng Việt.

## 7. Trạng thái và thông báo

| Tình huống | Hiển thị | Hành động |
|---|---|---|
| Lần đầu tải adapter qua `npx` | "Đang tải adapter lần đầu, có thể mất vài phút" | Dừng |
| Đang chạy, im lặng ≥ 30 s, không chờ duyệt | "Agent chưa phản hồi 30 giây. Có thể vẫn đang xử lý." | Dừng, Xem chi tiết |
| Adapter chết giữa lượt | "Agent đã dừng bất ngờ" + dòng stderr cuối | Gửi lại, Xem chi tiết |
| Chưa đăng nhập | "Claude Code chưa đăng nhập" | Mở terminal để đăng nhập, Chép lệnh |
| Hết hạn mức (nếu CLI báo) | Nguyên văn CLI, kèm giờ reset nếu có | Đổi agent |
| Không áp được thay đổi vì code thật đã khác | "Không nhận được đoạn này vì bạn đã sửa cùng chỗ" + tên tệp | Giữ bản nháp, không đổi gì |
| Ngân sách đạt 80 % / 100 % | Giữ cơ chế `BudgetService` hiện có | |

Ngưỡng 30 giây là **[Đề xuất]**: chỉ cảnh báo, không tự dừng. Đồng hồ thời gian dùng một signal `now` chung, tick mỗi giây và chỉ tick khi có lượt đang chạy.

## 8. Lõi Rust

### 8.1 Dự án
`open_project(path) -> Project`:

```ts
interface Project {
  root: string;            // thư mục đã chuẩn hoá (dunce); repo gốc nếu trong repo
  name: string;
  branch: string | null;
  git: 'ready' | 'no_commits' | 'none';
  uncommitted: number;     // 0 khi git !== 'ready'
  gitUser: boolean;        // user.name và user.email đã có
  adjusted: 'subfolder' | 'file' | null;  // vì sao root khác đường dẫn nhập vào
}
```

**Chuẩn hoá `normalize_path` (hàm thuần, có test bảng):** cắt khoảng trắng; bỏ cặp `"..."` hoặc `'...'` bao ngoài; `file://` thành đường dẫn; `~` và `~/` thành home; trên Windows nhận cả `/` và `\`, giữ UNC, bỏ tiền tố `\\?\`; bỏ `/` cuối. Đường dẫn có dấu cách và dấu tiếng Việt phải giữ nguyên.

**Lỗi có mã** để UI hiện đúng câu: `not_found`, `no_permission`, `git_unavailable`. Trước khi gọi `git`, kiểm tra `is_dir` để không ra thông báo sai kiểu "Không chạy được Git".

`git_prepare(path, options)` thực hiện mục 5.3. `pickFolder()` dùng `tauri-plugin-dialog` bản 2 (Rust `tauri-plugin-dialog = "2"`, JS `@tauri-apps/plugin-dialog@^2`, quyền `dialog:allow-open`).

**Di chuyển `tg.repo` trong `localStorage`:** kiểm tra một lần, hợp lệ thì thêm vào `projects`, rồi xoá khoá dù hợp lệ hay không.

### 8.2 Xem source
`list_project_files(root)` và `read_project_file(root, path)`:
- Repo Git: `ls-files --cached --others --exclude-standard`, như `workspace::list_files`.
- Không phải repo: duyệt thư mục bằng `std::fs`, không theo symlink, bỏ `.git`, `node_modules`, `.tg`, `target`, `dist`.
- Dùng chung giới hạn `MAX_FILES`, `MAX_BYTES`, kiểm tra nhị phân và UTF-8, và `Sandbox`.
- `root` phải là dự án có trong bảng `projects`.
- Không có lệnh ghi. Hàm trong `workspace.rs` được tổng quát hoá nhận `root: &Path`, các lệnh worktree giữ nguyên hành vi.

### 8.3 Cuộc trò chuyện Sửa code nhiều lượt
Tách `drive()` thành hai phần: **mở phiên** (initialize + `session/new`) và **chạy một lượt** (`session/prompt`). Thêm state `ThreadSessions`, khoá theo `thread_id`, giữ `AcpClient`, `Child`, `TaskSession`, agent, `pid`, thời điểm dùng gần nhất, token tg-bridge.

Lệnh mới `send_turn(threadId, agent, prompt) -> runId`:

| Tình huống | Xử lý |
|---|---|
| Chưa có bản nháp | Tạo worktree, mở phiên, chạy lượt |
| Có phiên sống, cùng agent, đang rảnh | `session/prompt` trên chính phiên đó |
| Đang có lượt chạy | Từ chối: "Agent đang chạy. Hãy chờ hoặc dừng trước." |
| Đổi agent, phiên đã chết hoặc đã bị dọn, hoặc app vừa mở lại | Mở phiên mới trên cùng worktree (`reuse`), gửi kèm tóm tắt |

**Tóm tắt:** tối đa 6 lượt gần nhất của nhánh đang tiếp tục (yêu cầu + tin nhắn cuối), giới hạn 8 000 ký tự, nói rõ bản nháp có thể đã có thay đổi. Luồng hiện một dòng "Phiên mới, đã gửi tóm tắt N lượt trước". **[Đề xuất]**

**Vòng đời**
- Mỗi lượt là một run: `started` … `exit`. `exit` nghĩa là xong lượt, **không** có nghĩa adapter đã tắt.
- `TaskSession` phải đổi được run hiện tại giữa các lượt, để event, thẻ duyệt và usage ghi đúng lượt.
- Phiên rảnh quá 30 phút thì dọn adapter (**[Đề xuất]**); lượt sau đi nhánh "phiên đã bị dọn".
- `stop_agent` gửi `session/cancel`, chờ 5 giây. Phiên còn trả lời thì giữ để chat tiếp, nhưng mọi lệnh con của lượt phải dừng hẳn. Không trả lời thì kill cả cây tiến trình. Sau Dừng, adapter đang rảnh được phép còn sống; agent không được làm việc tiếp.
- Thoát app hoặc bỏ bản nháp thì kill phiên. Windows dùng `taskkill /T /F`.
- tg-bridge: token sống theo phiên; `run_id` hiện tại cập nhật theo lượt; `scope` của ghi chú là `thread_id`.
- Hành vi một lần gọi `start_task` với `group` và `reuse` vẫn phải chạy cho Song song và Theo các bước. Hai luồng này gọi cùng lõi phiên, không có bản sao thứ hai.

**Điều kiện trước khi giữ phiên nhiều lượt**
- Sửa lỗi id của `reuse` (mục 3): mỗi lượt có id run riêng, worktree vẫn thuộc run gốc.
- Xử lý xong mọi notification đã nhận trước khi phát `exit` của lượt (review #6), nếu không tin nhắn và chi phí cuối lượt có thể rơi sang lượt sau.
- Ghi `stopReason` vào kết quả lượt: `end_turn` là xong; `cancelled` là đã dừng; `max_tokens`, `refusal` hiện rõ lý do trong luồng và không cho bước sau của Theo các bước chạy tiếp.

**Hẹn giờ khởi tạo:** `SETUP_TIMEOUT` 60 s quá ngắn khi `npx` phải tải adapter. Dùng 300 s khi chạy qua `npx`, 60 s khi có adapter sẵn. **[Đề xuất]**

**Usage nhiều lượt. Đây là chỗ dễ sai số nhất.**
- Quy ước mới: số của run là số **của riêng lượt đó**.
- `last_cost` hiện lấy từ `usage_update`. **[Cần kiểm chứng]** số này có cộng dồn theo phiên không, và token trong kết quả `session/prompt` có cộng dồn không. Ghi fixture thật 2 lượt của `claude-agent-acp@0.100.0` trước khi code.
- Nếu cộng dồn: lõi phải trừ số lượt trước và có unit test trong `usage.rs`, theo `AGENTS.md`.
- Nghiệm thu: tổng chi phí 2 lượt khớp số phiên CLI báo, không tính trùng.
- Ngân sách "mỗi task" tính theo cuộc trò chuyện.

### 8.4 Chỉ hỏi nhiều lượt
Giữ `runner.rs`, thêm tham số phiên vào `headless_args`. **Chặn ghi** là một phần của hợp đồng: Claude `--permission-mode plan` hoặc danh sách công cụ cấm, Codex `--sandbox read-only`, Gemini tìm cờ tương đương. **[Cần kiểm chứng]** từng cờ bằng một phép thử thật yêu cầu agent ghi tệp trong thư mục tạm; tệp không được xuất hiện.

| Agent | Cách nối | Trạng thái |
|---|---|---|
| Claude | `--resume <id>`, lấy `session_id` từ stream-json | Cờ có trong `--help`; **[Cần kiểm chứng]** khi chạy với `-p` |
| Codex | `codex exec resume <id> <prompt>` | Lệnh có trong `--help`; **[Cần kiểm chứng]** cờ `--json` và nơi lấy id |
| Gemini | Chưa rõ | Dùng tóm tắt như mục 8.3 |
| Kiro | Không chạy headless | Chế độ Chỉ hỏi không khả dụng, như hiện nay |

Lưu id vào `threads.agent_session`. Nối thất bại thì tự chuyển sang tóm tắt và ghi một dòng trong luồng.

### 8.5 Khởi động
- `App` hiện ngay kết quả dò lần trước từ `settings['agents']`, rồi cập nhật ở nền.
- `detect_agents` tách làm hai: `which` cho mọi agent (nhanh), rồi `--version` và kiểm tra đăng nhập **song song**, phát kết quả dần qua event.
- `read_login_path` có timeout 5 giây, quá hạn thì dùng PATH của tiến trình. Hết treo vô hạn.
- Không lệnh nào ở đây được bật cửa sổ. Test `child_processes_start_through_the_helpers` đã chặn.

`DetectedAgent` thêm `auth: 'ok' | 'none' | 'unknown'`:

| Agent | Lệnh | Trạng thái |
|---|---|---|
| Claude | `claude auth status` | Máy dev đang đăng nhập trả mã 0; **[Cần kiểm chứng]** mã khi chưa đăng nhập |
| Codex | `codex login status` | Như trên |
| Gemini, Kiro | Chưa có lệnh đã kiểm chứng | `unknown`, UI không khẳng định |

Tuyệt đối không gửi prompt thật để kiểm tra đăng nhập. `Settings > Agent` thay "sẵn sàng" bằng: Đã đăng nhập / Cần đăng nhập / Đã cài, chưa rõ đăng nhập.

**Mở terminal để đăng nhập:** macOS `open -a Terminal`, Windows `cmd /c start`. Đây là ngoại lệ duy nhất cố ý hiện cửa sổ. Lỗi thì quay về nút Chép lệnh.

### 8.6 Dữ liệu (schema v7)

```sql
CREATE TABLE projects (
  root TEXT PRIMARY KEY, name TEXT NOT NULL,
  last_opened INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE threads (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL,
  mode TEXT NOT NULL,            -- 'edit' | 'ask'
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  agent_session TEXT             -- id phiên CLI của chế độ Chỉ hỏi
);
ALTER TABLE runs ADD COLUMN thread_id TEXT;
CREATE INDEX runs_thread ON runs(thread_id, started_at);
```

**Di trú dữ liệu cũ, trong một transaction, có test từ DB v6:**
- Run cùng `task_id` (nhóm song song) vào chung một thread.
- Run có `worktree_owner` vào thread của run gốc.
- Run còn lại: mỗi run một thread.
- `project = COALESCE(repo, cwd)`. `mode = 'edit'` khi có `repo`, còn lại `'ask'`. `title` = 80 ký tự đầu của prompt của run sớm nhất.
- Không xoá hay sửa dữ liệu cũ của `runs`, `usage_events`, `run_lines`.

Trạng thái cuộc trò chuyện là **dẫn xuất ở UI**, không lưu: có `permissions` → Cần bạn; có lượt `running` → Đang chạy; có thay đổi chờ duyệt → Có thay đổi; lượt cuối lỗi → Lỗi; còn lại → Rảnh.

### 8.7 Thêm vào `AgentBackend`
Phải cài ở cả `TauriBackend` và `MockBackend`, đăng ký trong `generate_handler!`, khớp `protocol.ts`:

`pickFolder`, `openProject`, `listProjects`, `removeProject`, `gitPrepare`, `listProjectFiles`, `readProjectFile`, `listThreads`, `createThread`, `sendTurn`, `archiveThread`, `openLoginTerminal`.

`getSetting` / `setSetting` thêm khoá `'agents'`.

**MockBackend phải mô phỏng được lỗi:** đường dẫn chứa `missing` trả `not_found`, chứa `nogit` trả `git: 'none'`, chứa `nocommit` trả `no_commits`, chứa `dirty` trả `uncommitted: 3`. Hội thoại mock phải có nhiều lượt.

## 9. Ràng buộc Windows
- Mọi tiến trình con đi qua `env::command` / `env::std_command`.
- **[Cần kiểm chứng]** prompt nhiều dòng và ký tự đặc biệt khi agent là shim `.cmd`. Nếu lỗi, truyền prompt qua stdin hoặc gọi thẳng `node <script>` thay vì qua `.cmd`.
- `stop_agent` của chế độ Chỉ hỏi hiện chỉ `child.kill()`, không diệt được tiến trình con của `.cmd`. Dùng chung cách kill cây tiến trình với `terminate_adapter`.
- Đường dẫn có dấu cách, dấu tiếng Việt, CRLF đều phải có test.
- Trên Windows `read_login_path` không chạy shell, nên `which` phải tìm được `.exe`, `.cmd`, `.bat` như hiện nay.

## 10. Tài liệu phải cập nhật cùng đợt
- `docs/01-product-spec.md`: đổi nguyên tắc 1 "Code là trung tâm" thành "Cuộc trò chuyện là trung tâm, code nằm trong tầm tay"; viết lại 5.1.
- `docs/06-design-system.md`: nguyên tắc 1, mục 4 kích thước bố cục, bảng thuật ngữ.
- `docs/ARCHITECTURE.md`, `CLAUDE.md`: thread, luồng lượt, layout mới, `send_turn`.
- `docs/02-roadmap.md`: thêm các mốc dưới đây; sửa `docs/07-release.md` về `version:sync`.
- `docs/user-guide.md`, `README.md`, ảnh chụp màn hình; `CHANGELOG.md`.

## 11. Các mốc

Theo quy tắc của repo: Codex nhận module tách biệt có test, Claude nhận tích hợp và UI; hai agent không sửa cùng tệp trong một đợt; bên nào viết thì bên kia review.

**Thứ tự:** M-D → M0, M1, M2 → M3 → M4 → M5. Từ sau M-D, việc nào làm được thì giao qua chính TG Studio.

| Mốc | Nội dung | Làm | Xong khi |
|---|---|---|---|
| **M-D** Tự dùng app | Hộp thoại chọn thư mục và `open_project` tối thiểu; đổi Codex sang gói ACP mới rồi chạy kịch bản thật; sửa id `reuse`, `stopReason`, thay đổi đã stage (#5), gửi hai lần (#14), ô Commit (#12), đồng hồ; thông báo lỗi khởi động adapter. Giữ giao diện hiện tại | Codex: Rust + test; Claude: UI, tích hợp, kịch bản thật | Tiêu chí M-D ở mục 2 đạt trên macOS |
| **M0** Windows ổn | Thử bản sửa cửa sổ; kill cây tiến trình; prompt nhiều dòng; timer; cảnh báo im lặng | Chủ repo thử; Codex: kill cây, prompt; Claude: UI | Kịch bản Windows ở mục 12 qua |
| **M1** Mở dự án | `normalize_path`, `open_project`, `git_prepare`, dialog, `projects`, `ProjectStart`, xem source chỉ đọc, mock mô phỏng lỗi | Codex: Rust + test; Claude: UI | Các tình huống ở 5.2 và 5.3 đều qua |
| **M2** Khởi động nhanh | Cache, dò song song, timeout PATH, kiểm tra đăng nhập | Codex | Hiện agent dưới 1 s khi có cache |
| **M3** Nhiều lượt | Fixture 2 lượt; schema v7 + di trú; `ThreadSessions`, `send_turn`; usage; Chỉ hỏi nối phiên | Codex: store, di trú, `usage.rs`, agent giả nhiều lượt; Claude: phiên | Test agent giả và live 2 lượt qua, chi phí không trùng; UI cũ vẫn chạy |
| **M4** Bố cục mới | `ThreadList`, `Conversation`, `Composer`, `SidePanel`, `Settings`, bỏ activity bar và Terminal, cửa sổ hẹp | Claude; Codex review | Playwright mock qua trọn luồng; Song song, Theo các bước, Giám sát, Usage còn chạy |
| **M5** Dọn và nghiệm thu | Thuật ngữ, thông báo mục 7, tài liệu mục 10, nghiệm thu máy thật macOS + Windows | Claude + Chủ repo | Tiêu chí nghiệm thu tổng ở mục 2 đều đạt |

Sau M5 mới làm ký số, tự cập nhật và beta. M1, M2 giao được bản dùng thử ngay trên giao diện cũ. M3 không đổi UI. M4 phụ thuộc M1, M3.

Mỗi mốc một nhánh và một PR riêng. Trước khi xong: `npm run build`, `npm test`, `(cd src-tauri && cargo test)`.

## 12. Kiểm thử

**Kịch bản M-D, chạy thật bằng `npm run dev` trên macOS (tốn token, dùng việc nhỏ)**
1. Mở `tg-studio` bằng hộp thoại.
2. Giao một việc nhỏ cho Claude và Codex ở chế độ Song song.
3. Giám sát thấy cả hai, có thẻ duyệt; duyệt lệnh được.
4. So sánh, Dùng bản này, commit vào một nhánh thử.
5. Chạy Theo các bước 2 bước: mỗi bước có lịch sử và chi phí riêng, không ghi đè nhau.

**Tự động**
- `normalize_path`: bảng đầu vào (dấu cách, dấu tiếng Việt, ngoặc kép, `~`, `file://`, UNC, `\\?\`, `/` cuối). Thêm test `#[cfg(windows)]` riêng.
- `open_project`: mỗi dòng bảng 5.2 trên repo tạm. Không lưu khi lỗi.
- `git_prepare`: không commit `.env`, `node_modules` khi không có `.gitignore`; thiếu danh tính Git.
- Di trú v6 → v7 từ DB mẫu, gồm nhóm song song và `worktree_owner`. Không mất dòng nào.
- Agent giả nhiều lượt: nhớ phiên; event đúng run; dừng giữa lượt rồi gửi tiếp; adapter chết; đổi agent gửi tóm tắt.
- Usage: 2 lượt cộng dồn không tính trùng.
- Angular: dẫn xuất trạng thái; Enter khi `isComposing` không gửi; panel chỉ tự mở một lần; không lưu đường dẫn lỗi.
- Playwright mock: trọn luồng 5.1 → 5.4; đường dẫn lỗi; cửa sổ 1024×640 thấy đủ thẻ duyệt.
- Live `#[ignore]`: 2 lượt với `claude-agent-acp` thật; agent nhớ câu trước.

**Thủ công trên máy Windows, bản `npm run build:app`** (`npm run dev` có console nên không phát hiện được lỗi cửa sổ)
1. Mở app, gửi prompt ở cả hai chế độ: không có cửa sổ cmd nào bật lên, kể cả khi agent chạy lệnh và khi bấm Dừng.
2. Agent cài qua npm (`.cmd`): prompt nhiều dòng, có dấu tiếng Việt và dấu ngoặc kép.
3. Dự án trong đường dẫn có dấu cách và dấu tiếng Việt.
4. Lần đầu chạy Sửa code khi chưa có adapter: thấy thông báo tải, không báo lỗi giả.
5. Bấm Dừng: agent ngừng làm việc, tệp không đổi thêm, lệnh con đã hết trong Task Manager. Sửa code có thể còn adapter rảnh; Chỉ hỏi không còn tiến trình nào.
6. Gửi câu thứ hai: agent nhớ câu đầu.
7. Thoát app: không còn tiến trình agent.

## 13. Quyết định

**Chủ repo đã chốt**
- Hướng chat-first giống Claude desktop và T3 Code, giữ thế mạnh riêng.
- Phần nào giao được thì giao cho Codex.
- Ưu tiên sớm nhất: dùng chính app để xem và điều phối Claude cùng Codex xây tiếp project này.

**Người viết đã chọn, chủ repo xem lại khi duyệt**
1. Lượt = Run, cuộc trò chuyện là lớp mới bọc ngoài.
2. Source mở trực tiếp là **chỉ đọc**.
3. Bỏ activity bar và panel Terminal.
4. Enter gửi, Shift+Enter xuống dòng (hiện tại là ⌘↵).
5. Phiên rảnh 30 phút thì dọn; dùng tóm tắt thay `session/load`.
6. Sau khi Song song chọn một bản, chat tiếp bằng agent đó.
7. Đặt M-D trước mọi mốc khác và giữ giao diện hiện tại trong M-D.
8. M-D chỉ theo dõi agent **do app khởi chạy**. Theo dõi phiên chạy bên ngoài (terminal) là việc riêng, chưa nằm trong spec này.
9. Chỉ hỏi chặn ghi bằng cờ của CLI; agent chưa kiểm chứng thì không có chế độ này.
10. Commit liệt kê và cảnh báo tệp staged ngoài cuộc trò chuyện, không tự loại bỏ.
11. Bản nháp là ảnh chụp, không tự đồng bộ với dự án.
12. Xem thay đổi của lượt cũ mở trạng thái hiện tại của bản nháp.
13. Sau Dừng được giữ adapter rảnh để chat tiếp.
14. Các con số: im lặng 30 s, `npx` 300 s, tóm tắt 6 lượt / 8 000 ký tự.

**Người làm tự quyết**
Tên component cụ thể, kiểu kéo panel, hiệu ứng, chi tiết CSS trong khuôn `docs/06`, cách chia tệp trong `acp_tasks.rs`.
