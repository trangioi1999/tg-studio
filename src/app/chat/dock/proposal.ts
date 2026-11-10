import { AgentId } from '../../core/protocol';

/**
 * The plan a read-only (Chỉ hỏi) agent wrote instead of editing, if this stdout line holds one.
 *
 * Measured on Claude Code 2.1.319: in `--permission-mode plan` (headless), asked to change a
 * file, Claude does not call `ExitPlanMode` (no `permission_denials`); it writes the plan to
 * `~/.claude/plans/<slug>.md` with the Write tool and replies that it has not edited anything.
 * That write is the signal. `ExitPlanMode` is accepted too, in case a version calls it.
 * Codex's read-only sandbox gives no such signal, so it never proposes.
 */
export function planProposal(agent: AgentId, line: string | null): string | null {
  if (agent !== 'claude' || !line || !line.includes('"tool_use"')) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  const msg = (v as { type?: string; message?: { content?: unknown } }).type === 'assistant' ? (v as { message?: { content?: unknown } }).message : null;
  const content = Array.isArray(msg?.content) ? msg.content : [];
  for (const c of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
    if (c.type !== 'tool_use' || !c.input) continue;
    if (c.name === 'ExitPlanMode' && typeof c.input['plan'] === 'string') return c.input['plan'];
    const path = typeof c.input['file_path'] === 'string' ? c.input['file_path'].replace(/\\/g, '/') : '';
    if (c.name === 'Write' && path.includes('/.claude/plans/') && typeof c.input['content'] === 'string') return c.input['content'];
  }
  return null;
}
