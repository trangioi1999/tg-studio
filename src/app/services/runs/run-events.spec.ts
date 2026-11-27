import { AgentEvent } from '../../core/protocol';
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

  it('keeps adapter resume notes and the app\'s own progress notes out of the warnings', () => {
    const tone = (line: string) => applyEvent(run({ lines: [] }), ev({ kind: 'stderr', line }), { stopping: false }).run.lines.at(-1)?.tone;
    expect(tone('[session/query] sessionId=6eaa resume=6eaa phase=start')).toBe('muted');
    expect(tone('[session/query] sessionId=6eaa22a0 resume=6eaa22a0-8066')).toBe('muted');
    expect(tone('Đang chuẩn bị adapter. Lần đầu có thể mất vài phút để tải.')).toBe('muted');
    expect(tone('Error: spawn claude ENOENT')).toBe('error');
  });

  it('keeps the credits Kiro reported next to its usage', () => {
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0.04, source: 'reported' as const, cumulative: true };
    const first = applyEvent(run({ agent: 'kiro' }), ev({ agent: 'kiro', kind: 'usage', usage, data: { credits: 1, turnCredits: 0.32 } }), { stopping: false }).run;
    expect(first.credits).toEqual({ total: 1, turn: 0.32 });
    // A usage event without credits (tokens from the prompt result) keeps them.
    expect(applyEvent(first, ev({ agent: 'kiro', kind: 'usage', usage }), { stopping: false }).run.credits).toEqual({ total: 1, turn: 0.32 });
  });

  it('joins a delegated run to its parent\'s conversation', () => {
    const parent = run({ id: 'p', thread: 'tp', project: '/repo', scope: 'src', perm: 'auto' });
    const { run: child } = applyEvent(run({ id: 'c', thread: 'c', project: '' }), ev({ runId: 'c', kind: 'started', line: 'x', data: { parent: 'p' } }), { parent, stopping: false });
    expect(child).toMatchObject({ parent: 'p', thread: 'tp', project: '/repo', scope: 'src', perm: 'auto', place: 'draft', task: true });
  });

  it('takes the plan Claude\'s Chỉ hỏi writes to its plans folder from the tool call (ClaudeConn tool_call_of)', () => {
    const write = (path: string, extra: object = {}) => ({
      sessionUpdate: 'tool_call', toolCallId: 'toolu_1', title: `Write ${path}`, kind: 'edit', status: 'in_progress',
      rawInput: { file_path: path, content: '# Đổi a.txt\n\n- Ghi `xin chào`' }, _meta: { claudeCode: { toolName: 'Write' } },
      content: [{ type: 'diff', path, oldText: null, newText: '# Đổi a.txt' }], locations: [{ path }], ...extra,
    });
    const apply = (r: Run, data: object) => applyEvent(r, ev({ kind: 'tool', data: data as AgentEvent['data'] }), { stopping: false }).run;
    expect(apply(run({ perm: 'read' }), write('/Users/a/.claude/plans/doi-a.md')).proposal).toContain('xin chào');
    expect(apply(run({ perm: 'read' }), write('C:\\Users\\a\\.claude\\plans\\doi-a.md')).proposal).toContain('xin chào');
    // CLI 2.1.280+ may name the file `path`.
    expect(apply(run({ perm: 'read' }), write('/u/.claude/plans/x.md', { rawInput: { path: '/u/.claude/plans/x.md', content: 'Kế hoạch' } })).proposal).toBe('Kế hoạch');
    const exitPlan = { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'ExitPlanMode', kind: 'other', status: 'in_progress',
      rawInput: { plan: 'Bước 1' }, _meta: { claudeCode: { toolName: 'ExitPlanMode' } } };
    expect(apply(run({ perm: 'read' }), exitPlan).proposal).toBe('Bước 1');
    // Not while it may edit, not another agent, not another file; a later update keeps it.
    expect(apply(run({ perm: 'ask' }), write('/u/.claude/plans/x.md')).proposal).toBeFalsy();
    expect(apply(run({ perm: 'read', agent: 'codex' }), write('/u/.claude/plans/x.md')).proposal).toBeFalsy();
    expect(apply(run({ perm: 'read' }), write('/repo/src/a.ts')).proposal).toBeFalsy();
    const proposed = apply(run({ perm: 'read' }), write('/u/.claude/plans/x.md'));
    expect(apply(proposed, { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_1', status: 'completed' }).proposal).toContain('xin chào');
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
