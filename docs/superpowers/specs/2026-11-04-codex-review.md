# Review tĩnh của Codex, 2026-11-04

Review chỉ đọc code, chưa chạy thử và chưa được xác minh hết. Mục nào được chọn sửa phải xác minh lại trước. Số dòng tính theo commit `1776c28`.

Đã đọc `AGENTS.md`, `CLAUDE.md` và các phần được yêu cầu. Có **18 phát hiện**, xếp theo mức độ. Không sửa tệp, commit, chạy agent thật hay build/test; đây là review tĩnh, chưa tái hiện trên Windows.

1. **Cao — Pipeline dùng nhầm ID, ghi đè lịch sử bước đầu.**  
   [acp_tasks.rs:101](src-tauri/src/acp_tasks.rs:101), [acp_tasks.rs:196](src-tauri/src/acp_tasks.rs:196).  
   `prepare()` lưu bước mới bằng UUID mới nhưng trả worktree cũ; `start_task()` lấy `wt.run_id` làm ID chạy. Từ bước Build, log/usage/trạng thái đều ghi vào run Plan, trong khi hàng SQLite mới vẫn `running`. UI giữ trạng thái `done` của Plan, có thể chuyển tiếp sớm rồi lỗi “Bước trước vẫn đang chạy”; agent và chi phí cũng bị gán sai. **Xác minh: đọc code xuyên Rust → RunsService → PipelineService.**

2. **Cao — Chuyển sang tab Thay đổi/So sánh làm mất toàn bộ sửa tay chưa lưu.**  
   [code-editor.ts:104](src/app/shell/code-editor.ts:104), [workbench.ts:37](src/app/shell/workbench.ts:37).  
   Buffer chỉ nằm trong component. Khi đổi loại tab, `@switch` hủy `CodeEditor`, và `ngOnDestroy()` dispose mọi model, không lưu hay hỏi. Sửa tệp → mở Thay đổi → quay lại tệp sẽ mất nội dung chưa lưu, kể cả buffer của các tab tệp khác. **Xác minh: đọc code.**

3. **Cao — “Dừng” vẫn để tiến trình con tiếp tục chạy.**  
   [runner.rs:209](src-tauri/src/runner.rs:209), [handlers.rs:155](src-tauri/src/acp/handlers.rs:155), [compose.rs:76](src-tauri/src/compose.rs:76).  
   Headless và terminal ACP chỉ kill child trực tiếp; kiểm tra bản ghép dựa vào `kill_on_drop`. Trên Windows, child có thể là `cmd.exe` chạy shim npm, còn `node.exe` tiếp tục chạy, tiêu token hoặc ghi tệp dù UI báo đã dừng. Terminal ACP do app spawn riêng cũng không thuộc cây adapter được `terminate_adapter()` xử lý. **Xác minh: đọc code; chưa chạy thử cây tiến trình Windows.**

4. **Cao — Policy bỏ lọt executable Windows, tạo quyền “Always allow” quá rộng.**  
   [policy.rs:128](src-tauri/src/policy.rs:128), [policy.rs:89](src-tauri/src/policy.rs:89).  
   So khớp chỉ tách `/`, không chuẩn hóa `.exe`, `.cmd` hay chữ hoa/thường. Cho phép luôn `node.exe --version` tạo rule `node.exe *`; lần sau `node.exe -e ...` được tự duyệt dù `node` vốn nằm trong danh sách không được tạo rule. Tương tự, `git.exe push` không nhận verdict cấm. **Xác minh: đọc code, suy ra trực tiếp từ bộ tokenizer và matcher.**

5. **Cao — Thay đổi agent đã stage biến mất khỏi hàng chờ duyệt.**  
   [diff.rs:117](src-tauri/src/diff.rs:117).  
   Agent sửa rồi chạy `git add` nhưng chưa commit: HEAD vẫn bằng base nên không reset; `pending()` chỉ đọc `git diff` giữa working tree và index. Phần đã stage không xuất hiện, `accept_all()` cũng không lấy nó. UI có thể báo hết thay đổi, sau đó người dùng dọn worktree và mất kết quả chưa từng được đưa vào repo. `add -N` không thay thế entry đã có trong index ([mã nguồn Git](https://raw.githubusercontent.com/git/git/master/read-cache.c)). **Xác minh: đọc code và đối chiếu Git.**

6. **Cao — Có thể mất các notification ACP cuối lượt, gồm tin nhắn và chi phí.**  
   [client.rs:44](src-tauri/src/acp/client.rs:44), [acp_tasks.rs:164](src-tauri/src/acp_tasks.rs:164), [acp_runner.rs:159](src-tauri/src/acp_runner.rs:159).  
   Transport đưa notification vào queue nhưng giải quyết response `session/prompt` qua oneshot riêng. Nếu response được xử lý trước khi dispatcher tiêu hết queue, `finish()` đóng permissions; notification còn lại bị `on_notification()` bỏ qua. `finish()` chỉ chờ event đang phát, không chờ queue incoming ACP. **Xác minh: nghi ngờ race có đường thực thi rõ trong code; chưa tái hiện.**

7. **Vừa — Prompt nhiều dòng không chạy được qua shim `.cmd` trên Windows.**  
   [runner.rs:131](src-tauri/src/runner.rs:131), [adapters.rs:56](src-tauri/src/adapters.rs:56).  
   Chọn Chỉ đọc với CLI cài qua npm rồi nhập prompt hai dòng: prompt được đưa nguyên vào argument, stdin lại đóng. Rust từ chối argument chứa `\r` hoặc `\n` khi chạy batch script, nên spawn thất bại trước khi agent chạy ([mã nguồn Rust](https://raw.githubusercontent.com/rust-lang/rust/master/library/std/src/sys/args/windows.rs)). **Xác minh: đọc code và đối chiếu Rust; chưa chạy Windows.**

8. **Vừa — Commit “các thay đổi đã chấp nhận” lấy luôn mọi thay đổi staged khác.**  
   [diff.rs:182](src-tauri/src/diff.rs:182).  
   Người dùng đã stage tệp A bên ngoài app; trong TG Studio accept hunk của tệp B rồi bấm Commit. Lệnh thực tế chỉ là `git commit -m`, nên commit chứa cả A. Không có kiểm tra hay thông báo rằng phạm vi commit vượt quá các hunk vừa duyệt. **Xác minh: đọc code.**

9. **Vừa — Reload UI khi đang chờ quyền làm mất thẻ duyệt và agent chờ vô hạn.**  
   [runs.service.ts:517](src/app/core/runs.service.ts:517), [acp_runner.rs:145](src-tauri/src/acp_runner.rs:145).  
   `restoreRun()` hỗ trợ khôi phục run đang chạy nhưng luôn đặt `permissions: []`. Pending request vẫn nằm trong Rust, không có API lấy lại hoặc phát lại thẻ. Sau reload webview, run hiện đang chạy nhưng người dùng không còn cách trả lời quyền đó ngoài dừng run. **Xác minh: đọc code.**

10. **Vừa — Ngân sách ngày không tự chuyển ngày, có thể chặn mãi sau nửa đêm.**  
    [budget.service.ts:38](src/app/core/budget.service.ts:38).  
    Chạm ngân sách rồi để app mở qua đêm: `Date.now()` không phải dependency signal, nên computed không tự tính lại. `todayRows` cũng chỉ tải khi có thay đổi runs; dữ liệu cũ không được lọc lại theo `since` ở vòng cộng lịch sử. UI nói “đợi sang ngày mới” nhưng vẫn chặn chạy khi app đứng yên. **Xác minh: đọc code.**

11. **Vừa — Pipeline lỗi ngay bước đầu bị nuốt, prompt bị xóa mà không thấy lỗi.**  
    [pipeline.service.ts:120](src/app/core/pipeline.service.ts:120), [agent-panel.ts:386](src/app/shell/agent-panel.ts:386).  
    Adapter không spawn được hoặc tạo worktree thất bại: `launch()` chỉ lưu lỗi vào pipeline, không throw. `send()` coi là thành công và xóa prompt. Vì chưa có run ID, `pipelineOf()` không tìm được pipeline để hiện lỗi trong Thread. **Xác minh: đọc code.**

12. **Vừa — Accept xong có thể không còn đường Commit trong UI.**  
    [diff-viewer.ts:30](src/app/shell/diff-viewer.ts:30), [diff-viewer.ts:102](src/app/shell/diff-viewer.ts:102), [code-editor.ts:310](src/app/shell/code-editor.ts:310).  
    Ô Commit phụ thuộc bộ đếm `accepted` cục bộ. Accept từ editor không tăng bộ đếm này; accept trong DiffViewer rồi chuyển tab quay lại cũng reset về 0. Hunk đã được stage và biến mất khỏi pending, nhưng ô Commit không hiện. **Xác minh: đọc code.**

13. **Vừa — Lỗi đọc diff bị trình bày thành “không có thay đổi”.**  
    [compare.ts:167](src/app/shell/compare.ts:167), [mission-control.ts:281](src/app/shell/mission-control.ts:281).  
    Git index bị khóa, worktree không truy cập được hoặc Git trả lỗi: Compare thay kết quả bằng mảng rỗng, Mission Control dùng số 0. Người dùng thấy bản không có thay đổi, nút dùng bản bị khóa hoặc hàng review biến mất, không có thông báo nguyên nhân. **Xác minh: đọc code.**

14. **Vừa — Bấm Chạy liên tiếp tạo nhiều lượt tính phí cho cùng prompt.**  
    [agent-panel.ts:302](src/app/shell/agent-panel.ts:302), [agent-panel.ts:379](src/app/shell/agent-panel.ts:379).  
    Trong lúc chờ backend tạo worktree/spawn, `canRun()` vẫn true và không có cờ đang gửi. Double-click hoặc nhấn phím tắt hai lần khởi động hai task, hai nhóm song song hoặc hai pipeline. Prompt chỉ xóa sau khi await hoàn tất. **Xác minh: đọc code.**

15. **Vừa — Cài skill có thể ghi đè bản cũ mà không sao lưu nếu encoding không phải UTF-8.**  
    [skills.rs:73](src-tauri/src/skills.rs:73), [skills.rs:85](src-tauri/src/skills.rs:85).  
    `SKILL.md` hiện có lưu UTF-16 hoặc encoding Windows khác: `read_to_string()` lỗi, `state()` coi là `missing`. Installer bỏ qua backup rồi `fs::write()` ghi đè nội dung. Đây là mất dữ liệu dù UI hứa sao lưu bản khác trước khi ghi. **Xác minh: đọc code.**

16. **Vừa — Giới hạn output kiểm tra bản ghép không giới hạn bộ nhớ thực tế.**  
    [compose.rs:76](src-tauri/src/compose.rs:76), [compose.rs:89](src-tauri/src/compose.rs:89).  
    Chạy test/watch hoặc script sinh log liên tục: `wait_with_output()` giữ toàn bộ stdout/stderr tối đa 10 phút. Chỉ sau khi kết thúc mới cắt xuống 64 KiB. Output lớn có thể khiến app hết bộ nhớ trước timeout, ảnh hưởng cả các run khác. **Xác minh: đọc code.**

17. **Vừa — Mọi response thành công của ACP đều bị coi là task hoàn tất.**  
    [acp_tasks.rs:164](src-tauri/src/acp_tasks.rs:164).  
    Adapter trả `session/prompt` với `stopReason` như `max_tokens`, `refusal` hoặc `cancelled` nhưng không trả RPC error: app luôn ghi `done`, exit code 0. Pipeline tiếp tục bước sau với kết quả thiếu hoặc bị từ chối, không thông báo lý do dừng. **Xác minh: đọc code; nhánh này hoàn toàn không kiểm tra `stopReason`.**

18. **Vừa — Mỗi chunk log có thể kích hoạt đọc lại toàn bộ usage trong ngày/khoảng lọc.**  
    [budget.service.ts:65](src/app/core/budget.service.ts:65), [usage-screen.ts:259](src/app/shell/usage-screen.ts:259), [store.rs:234](src-tauri/src/store.rs:234).  
    Effect đọc trực tiếp signal `runs`; biểu thức `.filter(...).length` không ngăn effect chạy lại khi log cập nhật. Agent stream nhiều chunk sẽ tạo hàng loạt `usageReport`, mỗi lần replay usage của từng run trong transaction, dùng chung mutex SQLite với ghi event. Lịch sử lớn có thể gây giật UI và tồn đọng xử lý event. **Xác minh: đọc code; mức độ chậm chưa đo thực nghiệm.**