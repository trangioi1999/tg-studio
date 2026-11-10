import { AgentId } from '../../../core/protocol';

/** `delegate` marks where a run handed work to another agent (`label`: the delegation id, live only). */
export type LineTone = 'text' | 'user' | 'tool' | 'muted' | 'error' | 'ok' | 'delegate';
export interface ConsoleLine {
  text: string;
  tone: LineTone;
  /** Identifies a line that later events update in place. */
  key?: string;
  label?: string;
}

export const MESSAGE_KEY = 'message';

const BRIDGE = '◆ tg-bridge · ';

/**
 * A saved tg-bridge report (`emit_delegation`, `report_progress`…). A delegation keeps
 * its place in the chat; its end is in the nested block already; the rest are work steps.
 */
function bridgeLine(line: string): ConsoleLine {
  if (line.startsWith(`${BRIDGE}giao cho `)) return { text: line, tone: 'delegate' };
  if (/ (waiting_approval|running|done|failed|stopped|refused|conflict): /.test(line)) return { text: line, tone: 'muted' };
  return { text: line, tone: 'tool' };
}
export const FINAL_KEY = 'message-final';

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const obj = (v: unknown): Json | null => (v && typeof v === 'object' ? (v as Json) : null);

/**
 * Turns one raw JSON line from an agent into something readable.
 * Unknown shapes fall back to `[type]` so nothing is silently lost.
 */
export function describeLine(agent: AgentId, raw: string): ConsoleLine | null {
  const line = raw.trim();
  if (!line) return null;
  // Plain lines: a leading "›" marks a tool call (mock mode, simple CLIs); anything else is said.
  if (line.startsWith(BRIDGE)) return bridgeLine(line);
  if (!line.startsWith('{')) return { text: line, tone: line.startsWith('›') ? 'tool' : 'text' };
  let v: Json;
  try {
    v = JSON.parse(line) as Json;
  } catch {
    return { text: line, tone: 'text' };
  }
  const type = str(v['type']) ?? '';

  if (agent === 'claude') {
    if (type === 'stream_event') {
      const event = obj(v['event']);
      const delta = obj(event?.['delta']);
      if (event?.['type'] === 'content_block_delta' && delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        return { text: delta['text'], tone: 'text', key: MESSAGE_KEY };
      }
      return null;
    }
    if (type === 'rate_limit_event') return null;
    if (type === 'system' && (v['subtype'] === 'hook_started' || v['subtype'] === 'hook_response')) return null;
    if (type === 'assistant') {
      const content = obj(v['message'])?.['content'];
      if (Array.isArray(content)) {
        const parts = content.map((c) => {
          const block = obj(c);
          if (!block) return '';
          if (block['type'] === 'text') return str(block['text']) ?? '';
          if (block['type'] === 'tool_use') return `› ${str(block['name']) ?? 'tool'} ${summarizeInput(block['input'])}`;
          return '';
        }).filter(Boolean);
        if (parts.length) return {
          text: parts.join('\n'),
          tone: parts[0].startsWith('›') ? 'tool' : 'text',
          ...(content.every((c) => obj(c)?.['type'] === 'text') ? { key: FINAL_KEY } : {}),
        };
      }
      return null;
    }
    if (type === 'system') return { text: `● ${str(v['subtype']) ?? 'system'}`, tone: 'muted' };
    if (type === 'user') return null; // tool results: too noisy for the console
    if (type === 'result') return { text: `✓ ${str(v['subtype']) ?? 'done'}`, tone: 'ok' };
  }

  if (agent === 'codex') {
    const item = obj(v['item']);
    if (type === 'item.completed' && item) {
      const itemType = str(item['type']);
      if (itemType === 'agent_message') return { text: str(item['text']) ?? '', tone: 'text' };
      if (itemType === 'reasoning') return { text: `… ${str(item['text']) ?? ''}`, tone: 'muted' };
      if (itemType === 'command_execution') return { text: `› $ ${str(item['command']) ?? ''}`, tone: 'tool' };
      if (itemType === 'file_change') return { text: '› file change', tone: 'tool' };
      return { text: `› ${itemType ?? 'item'}`, tone: 'tool' };
    }
    if (type === 'thread.started' || type === 'turn.started' || type === 'item.started' || type === 'item.updated') return null;
    if (type === 'turn.failed' || type === 'error') return { text: `✕ ${str(v['message']) ?? type}`, tone: 'error' };
    if (type === 'turn.completed') return { text: '✓ turn completed', tone: 'ok' };
  }

  if (agent === 'gemini') {
    if (type === 'message') {
      const text = str(v['content']) ?? str(v['text']);
      return text ? { text, tone: 'text' } : null;
    }
    if (type === 'tool_use') return { text: `› ${str(v['tool_name']) ?? str(v['name']) ?? 'tool'}`, tone: 'tool' };
    if (type === 'tool_result') return null;
    if (type === 'result') return { text: '✓ done', tone: 'ok' };
    if (type === 'error') return { text: `✕ ${str(v['message']) ?? 'error'}`, tone: 'error' };
  }

  return { text: `[${type || 'json'}]`, tone: 'muted' };
}

function summarizeInput(input: unknown): string {
  const o = obj(input);
  if (!o) return '';
  const first = str(o['file_path']) ?? str(o['path']) ?? str(o['command']) ?? str(o['pattern']);
  return first ? first.slice(0, 120) : '';
}

/** Streamed chunks join their message; its final copy seals it without duplication. */
export function addLine(lines: ConsoleLine[], line: ConsoleLine | null): ConsoleLine[] {
  if (!line) return lines;
  const last = lines.at(-1);
  if (line.key === FINAL_KEY) {
    if (last?.key === MESSAGE_KEY && last.text.trim().endsWith(line.text.trim())) {
      const { key, ...sealed } = last;
      return [...lines.slice(0, -1), sealed];
    }
    const { key, ...final } = line;
    return [...lines, final];
  }
  if (line.key === MESSAGE_KEY && last?.key === MESSAGE_KEY) {
    return [...lines.slice(0, -1), { ...last, text: last.text + line.text }];
  }
  return [...lines, line];
}
