import { PermissionRequest } from '../../core/protocol';
import { Run } from '../../services/runs/run';
import { PRICE_HISTORY } from '../../services/usage/pricing';
import { mascotPose, NAP_MS } from '../chat/dock/dock-mascot';
import { boardCards, boardCounts } from './board';

const now = 100 * 60 * 60_000;
const hour = 60 * 60_000;
const permission: PermissionRequest = { requestId: 'p', toolCall: { title: 'Ghi tệp' }, options: [], rule: null };
const run = (id: string, over: Partial<Run> = {}): Run => ({
  id, agent: 'claude', prompt: `Việc ${id}`, cwd: '/repo', project: '/repo', thread: id,
  startedAt: now - 10_000, endedAt: null, status: 'running', lines: [], usage: null,
  exitCode: null, restored: false, task: true, permissions: [], lastMessage: '', group: null,
  scope: null, waits: [], plan: [], progress: null, ...over,
});

afterEach(() => PRICE_HISTORY.set([]));

describe('boardCards', () => {
  it('orders states, uses mascotPose, and counts every state', () => {
    const runs = [
      run('work', { lines: [{ tone: 'tool', text: '› Đọc tệp' }] }),
      run('ask', { status: 'idle', permissions: [permission] }),
      run('old', { status: 'done', startedAt: now - 3 * hour, endedAt: now - 2 * hour }),
      run('restored', { status: 'done', restored: true, endedAt: now - 1000 }),
      run('done', { status: 'idle', endedAt: now - 1000 }),
      run('failed', { status: 'failed', endedAt: now - 1000 }),
    ];
    const cards = boardCards(runs, { work: now, old: now - 2 * hour }, now);
    expect(cards.map(c => c.state)).toEqual(['needs_you', 'running', 'failed', 'done', 'sleep', 'sleep']);
    expect(cards.find(c => c.runId === 'work')?.pose).toBe('coding');
    expect(cards[0].permission).toBe(permission);
    for (const c of cards) expect(c.pose).toBe(mascotPose(runs.find(r => r.id === c.runId)!, { now, lastEvent: ({ work: now, old: now - 2 * hour } as Record<string, number>)[c.runId] }).pose);
    expect(boardCounts(cards)).toEqual({ all: 6, needs_you: 1, running: 1, failed: 1, done: 1, sleep: 2 });
  });

  it('a restored run sleeps even if it failed, and tails are reused for an unchanged run', () => {
    const now = 10_000_000;
    const failed = run('f', { status: 'failed', restored: true, endedAt: now - 60_000 });
    expect(boardCards([failed], {}, now)[0].state).toBe('sleep');
    const live = run('l', { status: 'running', endedAt: null, lines: [{ tone: 'text', text: 'xin chào' }] });
    expect(boardCards([live], {}, now)[0].tail).toBe(boardCards([live], {}, now + 1000)[0].tail);
  });

  it('old_runs_are_left_out', () => {
    expect(boardCards([run('old', { startedAt: now - 26 * hour, endedAt: now - 25 * hour, status: 'done' })], { old: now }, now)).toEqual([]);
    expect(boardCards([run('edge', { startedAt: now - 26 * hour, endedAt: now - 24 * hour, status: 'done' })], {}, now)).toHaveLength(1);
  });

  it('child_state_is_its_own', () => {
    const parent = run('parent', { status: 'done', restored: true, endedAt: now - 25 * hour, startedAt: now - 26 * hour });
    const child = run('child', { parent: parent.id, thread: parent.thread });
    const cards = boardCards([child, parent], {}, now);
    expect(cards.find(c => c.runId === 'child')).toMatchObject({ state: 'running', parentTitle: parent.prompt });
    expect(cards.find(c => c.runId === 'parent')).toMatchObject({ state: 'sleep', parentTitle: null });
  });

  it('selects the latest main run per conversation, keeping eligible children separately', () => {
    const first = run('first', { thread: 't', startedAt: now - hour, status: 'done', endedAt: now - hour });
    const latest = run('latest', { thread: 't' });
    const child = run('child', { thread: 't', parent: 'first' });
    const cards = boardCards([latest, child, first], {}, now);
    expect(cards.map(c => c.runId).sort()).toEqual(['child', 'latest']);
    expect(cards.find(c => c.runId === 'latest')?.title).toBe(first.prompt);
    expect(cards.find(c => c.runId === 'child')?.parentTitle).toBe(first.prompt);
  });

  it('sorts within a state by latest activity without mutating runs', () => {
    const runs = [run('a'), run('b')];
    expect(boardCards(runs, { a: now - 500, b: now }, now).map(c => c.runId)).toEqual(['b', 'a']);
    expect(runs.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('sleeps at five minutes, but keeps running and approval states regardless of age', () => {
    const cards = boardCards([
      run('idle', { status: 'idle', startedAt: now - hour, endedAt: now - NAP_MS }),
      run('running', { startedAt: now - 25 * hour }),
      run('ask', { startedAt: now - 25 * hour, status: 'idle', permissions: [permission] }),
    ], {}, now);
    expect(cards.map(c => c.state)).toEqual(['needs_you', 'running', 'sleep']);
  });

  it('formats the last three CLI rows and drops protocol noise', () => {
    const r = run('cli', { lines: [
      { tone: 'user', text: 'Làm giúp tôi' },
      { tone: 'text', text: 'Bắt đầu' },
      { tone: 'tool', text: '› Lệnh ✓', head: { name: 'Bash', arg: 'npm test' }, result: 'Đã qua' },
      { tone: 'muted', text: '{"type":"system"}' }, { tone: 'ok', text: '✓ success' },
    ] });
    expect(boardCards([r], {}, now)[0].tail).toEqual(['Bắt đầu', '● Bash(npm test)', '└ Đã qua']);
    // Runs are replaced, never changed in place (the tail is cached per run object).
    const next = { ...r, lines: [...r.lines, { tone: 'text' as const, text: `một\nhai\n${'x'.repeat(100)}\nbốn` }] };
    const tail = boardCards([next], {}, now)[0].tail;
    expect(tail).toHaveLength(3);
    expect(tail[0]).toBe('hai');
    expect(tail[2]).toBe('bốn');
    expect(tail.every(s => s.length <= 80 && !s.includes('\n'))).toBe(true);
  });

  it('bounds tool arguments and results, and shows diff counts', () => {
    const r = run('cli', { lines: [{ tone: 'tool', text: 'Sửa tệp', head: { name: 'Update', arg: '/src/' + 'a'.repeat(100) },
      diff: { path: '/src/a', added: 2, removed: 1, lines: [], more: 0 } }] });
    const tail = boardCards([r], {}, now)[0].tail;
    expect(tail[0].startsWith('● Update(')).toBe(true);
    expect(tail[0].endsWith(')')).toBe(true);
    expect(tail.every(s => s.length <= 80)).toBe(true);
    expect(tail[1]).toBe('└ +2 −1');
  });

  it('uses historical pricing at startedAt, current-turn duration, and nullable context', () => {
    PRICE_HISTORY.set([
      { agent: 'claude', fromMs: 0, input: 1, cachedInput: 0, output: 2 },
      { agent: 'claude', fromMs: now - 5000, input: 10, cachedInput: 0, output: 20 },
    ]);
    const r = run('priced', { turnAt: now - 1000, usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, costUsd: null, source: 'tokens', cumulative: true } });
    expect(boardCards([r], {}, now)[0]).toMatchObject({ durationMs: 1000, costUsd: 1, contextPercent: null, project: '/repo' });
    r.status = 'idle'; r.endedAt = now - 500;
    r.context = { used: 0, size: 100, percent: 0, source: 'acp' };
    r.usage!.costUsd = 0;
    expect(boardCards([r], {}, now)[0]).toMatchObject({ durationMs: 500, costUsd: 0, contextPercent: 0 });
  });

  it('handles an empty board and missing optional data', () => {
    expect(boardCounts([])).toEqual({ all: 0, needs_you: 0, running: 0, failed: 0, done: 0, sleep: 0 });
    expect(boardCards([run('empty', { prompt: '', parent: 'missing' })], {}, now)[0]).toMatchObject({
      title: 'Cuộc trò chuyện', parentTitle: null, tail: [], costUsd: null, contextPercent: null, permission: null,
    });
  });
});

it('gom con ngay sau cha cùng trạng thái, giữ thứ tự trạng thái và con thiếu cha', () => {
  const cards = boardCards([
    run('child', { parent: 'parent', startedAt: now - 1000 }),
    run('other', { startedAt: now - 2000 }),
    run('parent', { startedAt: now - 3000 }),
    run('sibling', { parent: 'parent', startedAt: now - 4000 }),
    run('orphan', { parent: 'absent', startedAt: now - 5000 }),
    run('failed-child', { parent: 'parent', status: 'failed', endedAt: now }),
  ], {}, now);
  expect(cards.map(c => c.runId)).toEqual(['other', 'parent', 'child', 'sibling', 'orphan', 'failed-child']);
});
it('bỏ Markdown khỏi đuôi tin nhắn trên bảng', () => {
  expect(boardCards([run('r', { lines: [{ tone: 'text', text: '# **Xong**\n- `a.ts`\n> [Đọc](url)' }] })], {}, now)[0].tail).toEqual(['Xong', 'a.ts', 'Đọc']);
});
