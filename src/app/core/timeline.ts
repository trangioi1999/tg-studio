import { ConsoleLine } from './describe-line';

export type StepState = 'done' | 'running' | 'failed' | 'note';

export interface WorkStep {
  /** Verb-first action as the agent named it, e.g. "Read src/app.ts". */
  text: string;
  state: StepState;
}

/** What a run said, in the order the chat shows it. Raw events never get here. */
export type Segment =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'work'; steps: WorkStep[]; failed: number; live: boolean };

/**
 * Groups a run's console lines for the chat: messages stay as they are, tool calls
 * between them collapse into one work log, and protocol noise (system events, the CLI
 * path, "✓ success", plans, unknown JSON) is dropped. `running` marks the last step
 * of a trailing work log as the one in progress.
 */
export function segmentsOf(lines: ConsoleLine[], running: boolean): Segment[] {
  const out: Segment[] = [];
  const work = (): Extract<Segment, { kind: 'work' }> => {
    const last = out.at(-1);
    if (last?.kind === 'work') return last;
    const fresh = { kind: 'work' as const, steps: [] as WorkStep[], failed: 0, live: false };
    out.push(fresh);
    return fresh;
  };
  for (const line of lines) {
    switch (line.tone) {
      case 'user':
        out.push({ kind: 'user', text: line.text });
        break;
      case 'text': {
        const text = line.text.trim();
        if (text) out.push({ kind: 'text', text });
        break;
      }
      case 'tool': {
        const failed = /\s✕$/.test(line.text);
        const text = line.text.replace(/^›\s*/, '').replace(/\s[✓✕]$/, '').trim();
        if (!text) break;
        const group = work();
        group.steps.push({ text, state: failed ? 'failed' : 'done' });
        if (failed) group.failed++;
        break;
      }
      case 'error': {
        const group = work();
        group.steps.push({ text: line.text.trim(), state: 'note' });
        break;
      }
      default:
        // muted / ok: protocol noise, not conversation.
        break;
    }
  }
  const last = out.at(-1);
  if (running && last?.kind === 'work') {
    last.live = true;
    const step = last.steps.at(-1);
    if (step?.state === 'done') step.state = 'running';
  }
  return out;
}
