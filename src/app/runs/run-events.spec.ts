import { AgentEvent } from '../core/protocol';
import { Run } from './run';
import { applyEvent } from './run-events';

const run = (over: Partial<Run> = {}): Run => ({
  id: 'r', agent: 'claude', prompt: 'p', cwd: '/a', startedAt: 1, endedAt: null, status: 'running', lines: [], usage: null, exitCode: null, restored: false,
  task: true, permissions: [], lastMessage: '', group: null, thread: 't', project: '/a', scope: null, waits: [{ from: 1, to: null }], plan: [], progress: null, ...over,
});
const ev = (over: Partial<AgentEvent>): AgentEvent => ({ runId: 'r', agent: 'claude', kind: 'log', line: null, usage: null, code: null, atMs: 9, data: null, ...over });

describe('applyEvent', () => {
  it('ends a turn the user stopped as stopped, and asks to forget tools and reload limits', () => {
    const { run: next, effects } = applyEvent(run(), ev({ kind: 'turn_end', data: { status: 'done' } }), { stopping: true });
    expect(next).toMatchObject({ status: 'idle', lastTurn: 'stopped', endedAt: 9, waits: [{ from: 1, to: 9 }] });
    expect(effects).toEqual([{ kind: 'forget' }, { kind: 'limits' }]);
  });

  it('reports what the core said over the stop flag when a session exits', () => {
    expect(applyEvent(run(), ev({ kind: 'exit', code: 1, data: { status: 'failed' } }), { stopping: true }).run.status).toBe('failed');
    expect(applyEvent(run(), ev({ kind: 'exit', code: null }), { stopping: true }).run.status).toBe('stopped');
    expect(applyEvent(run(), ev({ kind: 'exit', code: 0 }), { stopping: false }).run.status).toBe('done');
  });

  it('joins a delegated run to its parent\'s conversation', () => {
    const parent = run({ id: 'p', thread: 'tp', project: '/repo', scope: 'src', perm: 'auto' });
    const { run: child } = applyEvent(run({ id: 'c', thread: 'c', project: '' }), ev({ runId: 'c', kind: 'started', line: 'x', data: { parent: 'p' } }), { parent, stopping: false });
    expect(child).toMatchObject({ parent: 'p', thread: 'tp', project: '/repo', scope: 'src', perm: 'auto', place: 'draft', task: true });
  });

  it('hands tool tracking, agent commands and handoffs to the service as effects', () => {
    expect(applyEvent(run(), ev({ kind: 'tool', data: { toolCallId: 't1', title: 'Đọc a.ts' } }), { stopping: false }).effects)
      .toEqual([{ kind: 'track', update: { toolCallId: 't1', title: 'Đọc a.ts' }, at: 9 }]);
    expect(applyEvent(run(), ev({ kind: 'commands', data: { commands: [{ name: 'review' }] } }), { stopping: false }).effects)
      .toEqual([{ kind: 'commands', list: [{ name: 'review' }] }]);
    const { effects } = applyEvent(run(), ev({ kind: 'bridge', line: '◆', data: { tool: 'handoff_to', id: 'h', agent: 'codex', task: 'Viết test', files: ['a.ts', 3] } }), { stopping: false });
    expect(effects).toEqual([{ kind: 'handoff', handoff: { id: 'h', runId: 'r', from: 'claude', agent: 'codex', task: 'Viết test', files: ['a.ts'], at: 9 } }]);
  });
});
