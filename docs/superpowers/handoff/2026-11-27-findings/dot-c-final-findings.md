Final whole-range review of Đợt C — fix ALL of these in one wave (main working tree, branch claude/gallant-wozniak-f489hn).

IMPORTANT 1 — permission labels inconsistent with the new menu.
- src/app/features/chat/conversation/chat-turn.ts (~171, `permLabel`) shows `Tự động` for `auto` and `Sửa code` for `edit`; the menu (perm-menu.ts) now says **Tự làm** and **Hỏi trước** (and **Chỉ hỏi** for read). Fix permLabel accordingly.
- Update docs/user-guide.md:56 and :164, and comments at chat.state.ts:136, run.ts:56, run.ts:138, mock-backend.ts:208. Add/adjust a spec assertion.

IMPORTANT 2 — running placeholder promises something the app blocks.
- chat.state.ts:332 shows "Nhắn thêm, agent đọc sau bước này…" for every running run, but `blocked()` (chat.state.ts:179-180) blocks sending for running task/read runs ("Agent đang chạy. Hãy chờ, bấm Dừng…").
- Ruling: keep the blocking behaviour (plan says keep ChatState's mid-turn behaviour). Show "Nhắn thêm, agent đọc sau bước này…" only when `blocked()` is null while running; otherwise use "Agent đang làm… (Esc để dừng)". Update the assertion at agent-panel.spec.ts:410 and test both cases.

IMPORTANT 3 — clicking a child row in "Đang chạy" selects the child as the conversation's active run (thread-list.ts:83, `ui.openRun(r.id)`), so composer/send/stop target a one-turn child or a `~n` id without a session.
- Ruling: fix. Add `open: string` to `RunningRow` = parent id when the parent is in `runs`, else the run's own id; click → `ui.openRun(r.open)`. Assert in running-group.spec.ts.

MINOR (fix in this wave):
a. tool-step.ts `resultLine`: for Read (`head.name === 'Read'` / kind read) show a line count like "212 dòng" instead of the file's last line. Wire it where applyTool calls resultLine. Test.
b. chat-turn.ts `argParts` (~155): split into path prefix + bold filename only for path-like args (not when head.name === 'Bash', not when the arg contains spaces or `://`); keep the closing `)` outside the clipped span so it isn't lost when `.cl-arg` ellipsizes. Test.
c. Docs: docs/user-guide.md:70 "nút kẹp giấy" → "+ → Đính kèm tệp"; :78 work-log description → CLI-style lines with the last 3 steps always shown, earlier steps folded; :26 mention the "Đang chạy" group at the top of the left bar. CLAUDE.md Layout line: approvals now live inside the chat block (`.cx-approve`), not "ghim trên ô chat" — edit just that phrase.
d. Doc comments on exported `toolHead`, `miniDiff`, `resultLine`, `middleTruncate` (tool-step.ts).

ACCEPTED / deferred (do not change): current step repeated in .cl-live/.cl-step/.cx-tray; mascot overlapping top 8px of .cx-approve (pointer-events none); approval strip shows only first request; .cmp-keys hint removed; orphan child "↳" not indented; .esc hidden by viewport media query; chat-turn import order.
