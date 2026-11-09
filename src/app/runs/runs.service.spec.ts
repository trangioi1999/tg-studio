import { AgentsService } from '../agents/agents.service';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { MockBackend } from '../core/mock-backend';
import { AgentBackend, Unlisten } from '../core/backend';
import { AccountLimits, AgentEvent, AgentId, DetectedAgent, StoredRun, Usage } from '../core/protocol';
import { Run, RunsService, isQuiet, recapOf, turnStart } from './runs.service';

const usage: Usage = {
  inputTokens: 10,
  cachedInputTokens: 20,
  outputTokens: 5,
  costUsd: 0.5,
  source: 'reported',
  cumulative: true,
};

const stored = (over: Partial<StoredRun> = {}): StoredRun => ({
  id: 'old',
  agent: 'claude',
  prompt: 'cũ',
  cwd: '/tmp',
  startedAt: 1000,
  endedAt: 2000,
  status: 'done',
  exitCode: 0,
  usage,
  lines: [],
  worktree: null,
  group: null,
  thread: null,
  project: '/tmp',
  scope: null,
  ...over,
});

class FakeBackend extends MockBackend {
  override readonly mode = 'mock' as const;
  handler: (e: AgentEvent) => void = () => {};
  history: Promise<StoredRun[]> = Promise.resolve([]);
  override detectAgents(): Promise<DetectedAgent[]> {
    return Promise.resolve([]);
  }
  override start(_agent: AgentId, _prompt: string, _cwd: string) {
    return Promise.resolve('new');
  }
  override stop() {
    return Promise.resolve();
  }
  override listRuns() {
    return this.history;
  }
  override onEvent(handler: (e: AgentEvent) => void): Promise<Unlisten> {
    this.handler = handler;
    return Promise.resolve(() => {});
  }
}

function setup(history: StoredRun[] | Promise<StoredRun[]>) {
  const backend = new FakeBackend();
  backend.history = Promise.resolve(history);
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  return { backend, service: TestBed.inject(RunsService) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

const liveEvent = (over: Partial<AgentEvent>): AgentEvent => ({
  runId: 'live',
  agent: 'codex',
  kind: 'log',
  line: null,
  usage: null,
  code: null,
  atMs: 3000,
  data: null,
  ...over,
});

describe('RunsService ACP events', () => {
  const event = (kind: AgentEvent['kind'], data: AgentEvent['data']) => liveEvent({ kind, data });
  const request = {
    requestId: 'q1',
    toolCall: { title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } },
    options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }],
    rule: 'npm test *',
  };

  it('joins message chunks into one line until something interrupts them', async () => {
    const { backend, service } = setup([]);
    await flush();
    backend.handler(event('message', { text: 'Xin ' }));
    backend.handler(event('message', { text: 'chào' }));
    backend.handler(event('tool', { toolCallId: 't1', title: 'Đọc', status: 'pending' }));
    backend.handler(event('message', { text: 'Xong' }));
    const run = service.runs()[0];
    expect(run.lines.map((l) => l.text)).toEqual(['Xin chào', '› Đọc', 'Xong']);
    expect(run.lastMessage).toBe('Xong');
    expect(run.task).toBe(true);
  });

  it('records approval waits and closes them on resolve or exit', async () => {
    const { backend, service } = setup([]);
    await flush();
    backend.handler(liveEvent({ kind: 'permission', data: { ...request, requestId: 'a' }, atMs: 100 }));
    backend.handler(liveEvent({ kind: 'permission_resolved', data: { requestId: 'a' }, atMs: 250 }));
    backend.handler(liveEvent({ kind: 'permission', data: { ...request, requestId: 'b' }, atMs: 400 }));
    expect(service.runs()[0].waits).toEqual([{ from: 100, to: 250 }, { from: 400, to: null }]);
    backend.handler(liveEvent({ kind: 'exit', code: null, atMs: 500 }));
    expect(service.runs()[0].waits).toEqual([{ from: 100, to: 250 }, { from: 400, to: 500 }]);
  });

  it('tracks the file an agent works on across partial tool updates', async () => {
    const { backend, service } = setup([]);
    await flush();
    backend.handler(event('tool', { toolCallId: 't', kind: 'edit', title: 'Edit', status: 'pending', locations: [{ path: '/wt/a.ts', line: 3 }] }));
    expect(service.activity()['live']).toMatchObject({ toolCallId: 't', path: '/wt/a.ts', line: 3, editing: true, done: false });
    backend.handler(event('tool', { toolCallId: 't', status: 'completed' }));
    expect(service.activity()['live']).toMatchObject({ path: '/wt/a.ts', line: 3, editing: true, done: true });
    // Claude's Write: no kind on updates, the diff content names the file.
    backend.handler(event('tool', { toolCallId: 'u', content: [{ type: 'diff', path: '/wt/b.ts', newText: 'x' }] }));
    expect(service.activity()['live']).toMatchObject({ path: '/wt/b.ts', line: null, editing: true, done: false });
    // A read only moves the cursor; a command without a file changes nothing.
    backend.handler(event('tool', { toolCallId: 'r', kind: 'read', rawInput: { file_path: '/wt/c.ts' } }));
    expect(service.activity()['live']).toMatchObject({ path: '/wt/c.ts', editing: false });
    backend.handler(event('tool', { toolCallId: 'v', title: 'npm test', kind: 'execute' }));
    expect(service.activity()['live'].toolCallId).toBe('r');
    backend.handler(liveEvent({ kind: 'exit', code: 0 }));
    expect(service.activity()['live']).toBeUndefined();
  });

  it('updates a tool line in place and keeps its title', async () => {
    const { backend, service } = setup([]);
    await flush();
    backend.handler(event('tool', { toolCallId: 't1', title: 'Chạy test', status: 'pending' }));
    backend.handler(event('tool', { toolCallId: 't1', status: 'completed' }));
    backend.handler(event('tool', { toolCallId: 't2', title: 'Sửa file', status: 'failed' }));
    expect(service.runs()[0].lines).toEqual([
      { key: 'tool:t1', label: 'Chạy test', text: '› Chạy test ✓', tone: 'tool' },
      { key: 'tool:t2', label: 'Sửa file', text: '› Sửa file ✕', tone: 'error' },
    ]);
  });

  it('replaces the plan block when the agent revises it', async () => {
    const { backend, service } = setup([]);
    await flush();
    backend.handler(event('plan', { entries: [{ content: 'A', status: 'pending' }] }));
    backend.handler(event('plan', { entries: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] }));
    expect(service.runs()[0].lines.map((l) => l.text)).toEqual(['[x] A\n[~] B']);
  });

  it('adds and removes permission cards, and clears them when the run ends', async () => {
    const { backend, service } = setup([]);
    await flush();
    backend.handler(event('permission', request));
    backend.handler(event('permission', { ...request, requestId: 'q2' }));
    expect(service.runs()[0].permissions.map((p) => p.requestId)).toEqual(['q1', 'q2']);
    backend.handler(event('permission_resolved', { requestId: 'q1' }));
    expect(service.runs()[0].permissions.map((p) => p.requestId)).toEqual(['q2']);
    backend.handler(liveEvent({ kind: 'exit', code: null, data: { status: 'failed' } }));
    expect(service.runs()[0].permissions).toEqual([]);
    expect(service.runs()[0].status).toBe('failed');
  });

  it('restores saved chunks as one message and marks worktree runs as tasks', async () => {
    const { service } = setup([
      stored({
        worktree: '/repo/.tg/worktrees/old',
        lines: [
          { kind: 'message', line: 'Đã ' },
          { kind: 'message', line: 'sửa xong' },
        ],
      }),
    ]);
    await flush();
    const run = service.runs()[0];
    expect(run.lines.map((l) => l.text)).toEqual(['Đã sửa xong']);
    expect(run.lastMessage).toBe('Đã sửa xong');
    expect(run.task).toBe(true);
    expect('worktree' in run).toBe(false);
  });
});

describe('RunsService history', () => {
  it('restores lines with the right tone and selects the newest run', async () => {
    const { service } = setup([
      stored({
        id: 'newest',
        lines: [
          { kind: 'started', line: 'bắt đầu' },
          { kind: 'log', line: 'xin chào' },
          { kind: 'stderr', line: 'lỗi' },
          { kind: 'stderr', line: '[session/load] sessionId=abc phase=replay durationMs=0 totalMs=1130' },
        ],
      }),
      stored({ id: 'older', startedAt: 500 }),
    ]);
    await flush();

    expect(service.runs().map((r) => r.id)).toEqual(['newest', 'older']);
    expect(service.selectedId()).toBe('newest');
    expect(service.selected()?.lines).toEqual([
      { text: 'bắt đầu', tone: 'muted' },
      { text: 'xin chào', tone: 'text' },
      { text: 'lỗi', tone: 'error' },
      { text: '[session/load] sessionId=abc phase=replay durationMs=0 totalMs=1130', tone: 'muted' },
    ]);
    expect(service.selected()?.restored).toBe(true);
  });

  it('excludes restored runs from this session usage and run count', async () => {
    const { backend, service } = setup([stored()]);
    await flush();

    expect(service.totals()).toEqual({ tokens: 0, costUsd: null });
    expect(service.usageByAgent().find((u) => u.agent === 'claude')?.runs).toBe(0);
    expect(service.sessionRuns()).toHaveLength(0);

    backend.handler(liveEvent({ kind: 'usage', usage: { ...usage, costUsd: null, source: 'tokens' } }));
    expect(service.totals().tokens).toBe(35);
    expect(service.sessionRuns().map((r) => r.id)).toEqual(['live']);
  });

  it('keeps a live run when history arrives late', async () => {
    let resolve: (runs: StoredRun[]) => void = () => {};
    const { backend, service } = setup(new Promise<StoredRun[]>((r) => (resolve = r)));

    backend.handler(liveEvent({ line: 'đang làm' }));
    resolve([stored({ id: 'live', status: 'interrupted', lines: [] }), stored()]);
    await flush();

    expect(service.runs().map((r) => r.id)).toEqual(['live', 'old']);
    const live = service.runs()[0];
    expect(live.status).toBe('running');
    expect(live.restored).toBe(false);
    expect(live.lines).toHaveLength(1);
    expect(service.selectedId()).toBe('live');
  });

  it('reattaches a run already in progress when the UI reloads', async () => {
    let resolve: (runs: StoredRun[]) => void = () => {};
    const { backend, service } = setup(new Promise<StoredRun[]>((r) => (resolve = r)));

    backend.handler(liveEvent({ line: 'dòng 2' }));
    backend.handler(liveEvent({ line: 'dòng 3' }));
    resolve([
      stored({
        id: 'live',
        agent: 'codex',
        prompt: 'việc đang làm',
        cwd: '/repo',
        status: 'running',
        endedAt: null,
        exitCode: null,
        usage: null,
        lines: [
          { kind: 'log', line: 'dòng 1' },
          { kind: 'log', line: 'dòng 2' },
        ],
      }),
    ]);
    await flush();

    const run = service.runs()[0];
    expect(run.prompt).toBe('việc đang làm');
    expect(run.cwd).toBe('/repo');
    expect(run.startedAt).toBe(1000);
    expect(run.lines.map((l) => l.text)).toEqual(['dòng 1', 'dòng 2', 'dòng 3']);
    expect(run.status).toBe('running');
    expect(run.restored).toBe(false);
  });

  it('takes the final status from history when exit happened before the UI listened', async () => {
    let resolve: (runs: StoredRun[]) => void = () => {};
    const { backend, service } = setup(new Promise<StoredRun[]>((r) => (resolve = r)));

    backend.handler(liveEvent({ line: 'dòng cuối' }));
    resolve([stored({ id: 'live', agent: 'codex', status: 'failed', exitCode: 2, endedAt: 2500, usage })]);
    await flush();

    const run = service.runs()[0];
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(2);
    expect(run.endedAt).toBe(2500);
    expect(run.usage).toEqual(usage);
  });

  it('keeps tracking a stored running run with no live event yet', async () => {
    const { backend, service } = setup([
      stored({ id: 'live', agent: 'codex', status: 'running', endedAt: null, exitCode: null, usage }),
    ]);
    await flush();
    expect(service.running()).toHaveLength(1);
    expect(service.sessionRuns()).toHaveLength(1);

    backend.handler(liveEvent({ kind: 'exit', code: 0 }));
    expect(service.runs()[0].status).toBe('done');
  });

  it('does not count an interrupted run as running', async () => {
    const { service } = setup([stored({ status: 'interrupted', endedAt: null })]);
    await flush();
    expect(service.running()).toHaveLength(0);
  });

  it('survives a history failure', async () => {
    const { backend, service } = setup(Promise.reject(new Error('no db')));
    await flush();
    expect(service.runs()).toEqual([]);
    backend.handler(liveEvent({ line: 'vẫn chạy' }));
    expect(service.runs()).toHaveLength(1);
  });
});

describe('RunsService exit status', () => {
  for (const status of ['done', 'failed', 'stopped'] as const) {
    it(`honors explicit ACP ${status} status over local exit inference`, async () => {
      const { backend, service } = setup([]);
      await flush();
      if (status !== 'stopped') await service.stop('live');
      backend.handler(liveEvent({ kind: 'exit', code: status === 'done' ? null : 0, data: { status } }));
      expect(service.runs()[0].status).toBe(status);
      expect(service.runs()[0].endedAt).toBe(3000);
    });
  }

  for (const data of [null, 'stopped', [], { status: 'running' }, { status: 1 }]) {
    it(`falls back to headless exit codes for ${JSON.stringify(data)}`, async () => {
      const { backend, service } = setup([]);
      await flush();
      backend.handler(liveEvent({ kind: 'exit', code: 0, data }));
      expect(service.runs()[0].status).toBe('done');
      backend.handler(liveEvent({ runId: 'failed', kind: 'exit', code: null, data }));
      expect(service.runs().find(r => r.id === 'failed')?.status).toBe('failed');
      await service.stop('stopped');
      backend.handler(liveEvent({ runId: 'stopped', kind: 'exit', code: 0, data }));
      expect(service.runs().find(r => r.id === 'stopped')?.status).toBe('stopped');
    });
  }
});

describe('MockBackend task flow', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('goes from approval through review to commit', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useClass: MockBackend }] });
    const service = TestBed.inject(RunsService);
    await service.startTask('claude', 'sửa lỗi', '/repo');
    await wait(300);
    const pending = service.selected();
    expect(pending?.permissions).toHaveLength(1);
    expect(pending?.task).toBe(true);
    expect(pending?.status).toBe('running');

    await service.respondPermission(pending!.id, pending!.permissions[0].requestId, 'allow', false);
    await wait(800);
    const run = service.selected()!;
    expect(run.status).toBe('idle');
    expect(run.permissions).toEqual([]);
    expect(run.lastMessage.split('\n')[0]).toBe('fix: sửa lỗi theo yêu cầu');

    const files = await service.getDiff(run.id);
    expect(files.map((f) => f.path)).toEqual(['src/app/app.ts', 'docs/ghi chú mới.md']);
    await expect(TestBed.inject(AgentBackend).commitAccepted(run.id, 'x')).rejects.toThrow('Chưa có thay đổi');
    await service.acceptHunk(run.id, files[0].path, files[0].hunks[0].id);
    await service.rejectHunk(run.id, files[1].path, files[1].hunks[0].id);
    expect((await service.getDiff(run.id)).map((f) => f.hunks.length)).toEqual([1]);
    expect(await TestBed.inject(AgentBackend).commitAccepted(run.id, 'fix')).toMatch(/^[0-9a-f]+$/);

    await service.discardWorktree(run.id);
    expect(service.selected()?.task).toBe(false);
  });
});

describe('RunsService parallel mode', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('starts one grouped task per agent and accepts a whole run', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useClass: MockBackend }] });
    const service = TestBed.inject(RunsService);
    const errors = await service.startParallel(['codex', 'claude'], 'cùng một việc', '/repo');
    expect(errors).toEqual([]);
    const group = service.selected()!.group;
    expect(group).toBeTruthy();
    const runs = service.groupRuns(group);
    expect(runs.map((r) => r.agent)).toEqual(['claude', 'codex']);
    expect(runs.every((r) => r.task && r.prompt === 'cùng một việc' && r.cwd === '/repo')).toBe(true);
    expect(service.groupRuns(null)).toEqual([]);

    await wait(300);
    await expect(service.acceptAll(runs[0].id)).rejects.toThrow('đang chạy');
    for (const r of service.groupRuns(group)) {
      await service.respondPermission(r.id, r.permissions[0].requestId, 'allow', false);
    }
    await wait(800);
    expect(service.groupRuns(group).map((r) => r.status)).toEqual(['idle', 'idle']);
    await expect(service.commitChoice(group!, 'x')).rejects.toThrow('Chưa chọn');
    await service.useRun(group!, runs[0].id);
    expect(service.choices()[group!]).toEqual({ runId: runs[0].id, compositeId: null, files: 2, commit: null });
    expect(await service.getDiff(runs[0].id)).toEqual([]);
    await expect(service.useRun(group!, runs[1].id)).rejects.toThrow('đã chọn');
    expect(await service.commitChoice(group!, 'dùng bản của Claude')).toMatch(/^[0-9a-f]+$/);
    expect(service.choices()[group!].commit).toBe('abc1234');
  });

  it('reports agents that failed to start and throws when none did', async () => {
    class Flaky extends MockBackend {
      override startTask(agent: AgentId, prompt: string, repo: string, group: string | null = null) {
        return agent === 'gemini' ? Promise.reject(new Error('không có adapter')) : super.startTask(agent, prompt, repo, group);
      }
    }
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useClass: Flaky }] });
    const service = TestBed.inject(RunsService);
    expect(await service.startParallel(['claude', 'gemini'], 'p', '/repo')).toEqual(['Gemini CLI: không có adapter']);
    expect(service.runs()).toHaveLength(1);
    await expect(service.startParallel(['gemini'], 'p', '/repo')).rejects.toThrow('không có adapter');
  });
});

describe('RunsService plan limits', () => {
  const windows = [{ id: 'five_hour', utilization: 0.4, resetsAt: 9_000, status: 'allowed' }];

  it('keeps limits per agent without creating a run, preferring newer reports', async () => {
    const backend = new FakeBackend();
    let resolve!: (v: AccountLimits[]) => void;
    backend.accountLimits = () => new Promise((r) => (resolve = r));
    backend.refreshClaudeLimits = async () => null;
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
    const service = TestBed.inject(RunsService);
    await flush();
    backend.handler(liveEvent({ agent: 'claude', kind: 'limits', data: { windows }, atMs: 500 }));
    expect(service.runs()).toEqual([]);
    expect(service.limits().claude).toEqual({ agent: 'claude', windows, at: 500 });
    // Saved history older than the live report must not replace it.
    resolve([{ agent: 'claude', windows: [], at: 100 }, { agent: 'codex', windows, at: 50 }]);
    await flush();
    expect(service.limits().claude?.at).toBe(500);
    expect(service.limits().codex?.at).toBe(50);
  });
});

describe('RunsService agent commands', () => {
  it('keeps the skills a live session reports for its agent and folder', async () => {
    const backend = new FakeBackend();
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
    const service = TestBed.inject(RunsService);
    await flush();
    backend.handler(liveEvent({ kind: 'started', atMs: 1 }));
    const run = service.runs()[0];
    const commands = [{ name: '$doc', description: 'd', kind: 'skill', source: 'project', plugin: null, hint: null, insert: '$doc ' }];
    backend.handler(liveEvent({ kind: 'commands', data: { commands }, atMs: 2 }));
    expect(TestBed.inject(AgentsService).commandsFor('codex', run.project || run.cwd || null)).toEqual(commands);
  });
});

describe('RunsService composites', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('mixes hunks from two runs, checks, uses and commits the mix', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useClass: MockBackend }] });
    const service = TestBed.inject(RunsService);
    await service.startParallel(['claude', 'gemini'], 'p', '/repo');
    const group = service.selected()!.group!;
    await wait(300);
    for (const r of service.groupRuns(group)) await service.respondPermission(r.id, r.permissions[0].requestId, 'allow', false);
    await wait(800);
    const [claude, gemini] = service.groupRuns(group);
    const a = await service.getDiff(claude.id);
    const b = await service.getDiff(gemini.id);
    // The same lines from both runs cannot be mixed.
    await expect(service.compose(group, [
      { runId: claude.id, path: a[0].path, hunkId: a[0].hunks[0].id },
      { runId: gemini.id, path: b[0].path, hunkId: b[0].hunks[0].id },
    ])).rejects.toThrow('trùng chỗ sửa');
    const mix = await service.compose(group, [
      { runId: claude.id, path: a[0].path, hunkId: a[0].hunks[0].id },
      { runId: gemini.id, path: b[0].path, hunkId: b[0].hunks[1].id },
      { runId: gemini.id, path: b[1].path, hunkId: b[1].hunks[0].id },
    ]);
    expect(mix.files.map((f) => [f.path, f.hunks.length])).toEqual([['src/app/app.ts', 2], ['docs/ghi chú mới.md', 1]]);
    expect((await service.checkComposite(group, 'npm test')).code).toBe(0);
    expect((await service.checkComposite(group, 'npm run fail')).code).toBe(1);
    expect(service.checkCommand()).toBe('npm run fail');
    await service.useComposite(group);
    expect(service.choices()[group]).toEqual({ runId: null, compositeId: mix.id, files: 2, commit: null });
    expect(await service.commitChoice(group, 'ghép')).toBe('mix5678def1234');
    await service.dropComposite(group);
    expect(service.composites()[group]).toBeUndefined();
  });
});

describe('RunsService tg-bridge events', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('records progress and handoff proposals, ignoring bad ones', async () => {
    const { backend, service } = setup([]);
    await flush();
    backend.handler(liveEvent({ kind: 'bridge', line: '◆ tg-bridge · Viết test (40%)', data: { tool: 'report_progress', step: 'Viết test', pct: 40, note: null }, atMs: 10 }));
    expect(service.runs()[0].progress).toEqual({ step: 'Viết test', pct: 40, note: null, at: 10 });
    expect(service.runs()[0].lines.at(-1)).toEqual({ text: '◆ tg-bridge · Viết test (40%)', tone: 'tool' });
    const handoff = { tool: 'handoff_to', id: 'h1', agent: 'gemini', task: 'Review', files: ['a.ts', 3] };
    backend.handler(liveEvent({ kind: 'bridge', line: 'x', data: handoff }));
    backend.handler(liveEvent({ kind: 'bridge', line: 'x', data: handoff }));
    backend.handler(liveEvent({ kind: 'bridge', line: 'x', data: { ...handoff, id: 'h2', agent: 'cursor' } }));
    expect(service.handoffs()).toEqual([{ id: 'h1', runId: 'live', from: 'codex', agent: 'gemini', task: 'Review', files: ['a.ts'], at: 3000 }]);
    service.dismissHandoff('h1');
    expect(service.handoffs()).toEqual([]);
  });

  it('accepting a handoff continues in the finished run\'s worktree', async () => {
    const backend = new MockBackend();
    const calls: (string | null)[] = [];
    const start = backend.startTask.bind(backend);
    backend.startTask = (agent, prompt, repo, group = null, reuse = null) => { calls.push(reuse); return start(agent, prompt, repo, group, reuse); };
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
    const service = TestBed.inject(RunsService);
    await service.startTask('claude', 'Đổi tiêu đề', '/repo');
    await wait(300);
    const r = service.selected()!;
    await service.respondPermission(r.id, r.permissions[0].requestId, 'allow', false);
    await wait(800);
    // Mock Claude proposes a handoff to Codex while it works.
    const h = service.handoffs()[0];
    expect(h).toMatchObject({ runId: r.id, from: 'claude', agent: 'codex' });
    const next = await service.acceptHandoff(h.id, '/repo');
    expect(calls).toEqual([null, r.id]);
    expect(service.runs().find((x) => x.id === next)?.prompt).toBe(h.task);
    expect(service.handoffs()).toEqual([]);
    await expect(service.acceptHandoff('gone', '/repo')).rejects.toThrow('không còn');
  });
});

describe('RunsService clock', () => {
  afterEach(() => vi.useRealTimers());

  it('ticks only while a run is running', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { backend, service } = setup([]);
    await flush();
    TestBed.tick();
    const idle = service.now();
    vi.advanceTimersByTime(5000);
    expect(service.now()).toBe(idle);
    backend.handler(liveEvent({ kind: 'started' }));
    TestBed.tick();
    vi.advanceTimersByTime(1000);
    expect(service.now()).toBeGreaterThan(idle);
    backend.handler(liveEvent({ kind: 'exit', code: 0 }));
    TestBed.tick();
    const ended = service.now();
    vi.advanceTimersByTime(5000);
    expect(service.now()).toBe(ended);
  });
});

describe('RunsService open sessions', () => {
  it('waits for the next message after a turn, then runs again', async () => {
    const { backend, service } = setup([]);
    await flush();
    backend.handler(liveEvent({ kind: 'started' }));
    backend.handler(liveEvent({ kind: 'turn_end', data: { status: 'done' }, atMs: 5000 }));
    expect(service.runs()[0]).toMatchObject({ status: 'idle', endedAt: 5000 });
    backend.handler(liveEvent({ kind: 'user', line: 'câu hai' }));
    expect(service.runs()[0]).toMatchObject({ status: 'running', endedAt: null });
    expect(service.runs()[0].lines.at(-1)).toEqual({ text: 'câu hai', tone: 'user' });
    backend.handler(liveEvent({ kind: 'exit', code: 0, data: { status: 'done' } }));
    expect(service.runs()[0].status).toBe('done');
  });

  it('keeps how the last turn ended while the session waits', async () => {
    const { backend, service } = setup([]);
    await flush();
    backend.handler(liveEvent({ kind: 'started' }));
    backend.handler(liveEvent({ kind: 'turn_end', data: { status: 'failed' }, atMs: 5000 }));
    expect(service.runs()[0]).toMatchObject({ status: 'idle', lastTurn: 'failed' });
    backend.handler(liveEvent({ kind: 'user', line: 'thử lại' }));
    expect(service.runs()[0].lastTurn).toBeNull();
    backend.handler(liveEvent({ kind: 'turn_end', data: { status: 'stopped' }, atMs: 6000 }));
    expect(service.runs()[0].lastTurn).toBe('stopped');
    backend.handler(liveEvent({ kind: 'user', line: 'tiếp' }));
    backend.handler(liveEvent({ kind: 'turn_end', data: { status: 'done' }, atMs: 7000 }));
    expect(service.runs()[0].lastTurn).toBe('done');
  });

  it('times each question from when it was sent, not from the session start', async () => {
    const { backend, service } = setup([]);
    await flush();
    backend.handler(liveEvent({ kind: 'started', atMs: 1000 }));
    backend.handler(liveEvent({ kind: 'turn_end', data: { status: 'done' }, atMs: 5000 }));
    backend.handler(liveEvent({ kind: 'user', line: 'câu hai', atMs: 90_000 }));
    backend.handler(liveEvent({ kind: 'turn_end', data: { status: 'done' }, atMs: 93_000 }));
    const run = service.runs()[0];
    expect(run.turnAt).toBe(90_000);
    expect(run.endedAt! - turnStart(run)).toBe(3000);
  });

  it('returns a stopped turn to the waiting state', async () => {
    const { backend, service } = setup([]);
    await flush();
    backend.handler(liveEvent({ kind: 'started' }));
    await service.stop('live').catch(() => {});
    backend.handler(liveEvent({ kind: 'turn_end', data: { status: 'stopped' } }));
    expect(service.runs()[0].status).toBe('idle');
    backend.handler(liveEvent({ kind: 'exit', code: 0, data: { status: 'done' } }));
    expect(service.runs()[0].status).toBe('done');
  });

  it('keeps an idle run live across a UI reload', async () => {
    const { service } = setup([stored({ id: 'open', status: 'idle', endedAt: null })]);
    await flush();
    expect(service.runs()[0]).toMatchObject({ status: 'idle', restored: false });
  });

  it('restores what the user said', async () => {
    const { service } = setup([stored({ lines: [{ kind: 'user', line: 'câu hai' }] })]);
    await flush();
    expect(service.runs()[0].lines[0]).toEqual({ text: 'câu hai', tone: 'user' });
  });
});

describe('recapOf', () => {
  it('has the first prompt and what was said, not tool noise', () => {
    const recap = recapOf({ prompt: 'câu đầu', lines: [{ text: 'trả lời', tone: 'text' }, { text: 'npm test', tone: 'tool' }, { text: 'câu hai', tone: 'user' }] });
    expect(recap).toContain('Người dùng: câu đầu');
    expect(recap).toContain('Agent: trả lời');
    expect(recap).toContain('Người dùng: câu hai');
    expect(recap).not.toContain('npm test');
  });

  it('keeps the newest text when too long', () => {
    const recap = recapOf({ prompt: 'x'.repeat(9000), lines: [{ text: 'mới nhất', tone: 'text' }] });
    expect(recap).toContain('mới nhất');
    expect(recap.length).toBeLessThan(8200);
  });
});

describe('isQuiet', () => {
  const run = (over: Partial<Run> = {}) => ({ status: 'running', permissions: [], startedAt: 0, ...over }) as Run;

  it('notices a running agent with nothing heard for 30 seconds', () => {
    expect(isQuiet(run(), 1000, 30_999)).toBe(false);
    expect(isQuiet(run(), 1000, 31_000)).toBe(true);
    expect(isQuiet(run(), undefined, 30_000)).toBe(true);
  });

  it('stays calm while it waits for the user or has ended', () => {
    expect(isQuiet(run({ permissions: [{}] as Run['permissions'] }), 0, 99_000)).toBe(false);
    expect(isQuiet(run({ status: 'idle' }), 0, 99_000)).toBe(false);
  });
});
