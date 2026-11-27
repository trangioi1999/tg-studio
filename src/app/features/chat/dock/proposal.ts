import { AgentId } from '../../../core/protocol';

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
    const plan = planOf(c.name, c.input);
    if (plan !== null) return plan;
  }
  return null;
}

/**
 * The same plan, from the ACP `tool_call` a task session reports (ClaudeConn's `tool_call_of`:
 * the tool's name in `_meta.claudeCode.toolName`, its input in `rawInput`). Claude's Chỉ hỏi
 * runs as a task, so this is where its plan arrives.
 */
export function toolProposal(agent: AgentId, update: Record<string, unknown>): string | null {
  if (agent !== 'claude') return null;
  const meta = update['_meta'] as { claudeCode?: { toolName?: unknown } } | undefined;
  const name = meta?.claudeCode?.toolName;
  const input = update['rawInput'];
  if (typeof name !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) return null;
  return planOf(name, input as Record<string, unknown>);
}

function planOf(name: string | undefined, input: Record<string, unknown>): string | null {
  if (name === 'ExitPlanMode' && typeof input['plan'] === 'string') return input['plan'];
  // Since CLI 2.1.280 Write also takes `path`.
  const file = typeof input['file_path'] === 'string' ? input['file_path'] : typeof input['path'] === 'string' ? input['path'] : '';
  const path = file.replace(/\\/g, '/');
  if (name === 'Write' && path.includes('/.claude/plans/') && typeof input['content'] === 'string') return input['content'];
  return null;
}
