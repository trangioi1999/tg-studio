import { TestBed } from '@angular/core/testing';
import { MockBackend } from './mock-backend';
import { AgentBackend, Unlisten } from './backend';
import { AgentEvent, AgentId, DetectedAgent, StoredRun, Usage } from './protocol';
import { RunsService } from './runs.service';

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
  ...over,
});

class FakeBackend extends MockBackend {
  override readonly mode = 'mock' as const;
  handler: (e: AgentEvent) => void = () => {};
  history: Promise<StoredRun[]> = Promise.resolve([]);
  override detectAgents(): Promise<DetectedAgent[]> {
    return Promise.resolve([]);
  }
  override homeDir() {
    return Promise.resolve(null);
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
    expect(run.status).toBe('done');
    expect(run.permissions).toEqual([]);
    expect(run.lastMessage).toBe('fix: sửa lỗi theo yêu cầu');

    const files = await service.getDiff(run.id);
    expect(files.map((f) => f.path)).toEqual(['src/app/app.ts', 'docs/ghi chú mới.md']);
    await expect(service.commitAccepted(run.id, 'x')).rejects.toThrow('Chưa có thay đổi');
    await service.acceptHunk(run.id, files[0].path, files[0].hunks[0].id);
    await service.rejectHunk(run.id, files[1].path, files[1].hunks[0].id);
    expect((await service.getDiff(run.id)).map((f) => f.hunks.length)).toEqual([1]);
    expect(await service.commitAccepted(run.id, 'fix')).toMatch(/^[0-9a-f]+$/);

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
    expect(service.groupRuns(group).map((r) => r.status)).toEqual(['done', 'done']);
    await expect(service.commitChoice(group!, 'x')).rejects.toThrow('Chưa chọn');
    await service.useRun(group!, runs[0].id);
    expect(service.choices()[group!]).toEqual({ runId: runs[0].id, files: 2, commit: null });
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
