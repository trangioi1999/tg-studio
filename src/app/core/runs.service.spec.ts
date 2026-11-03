import { TestBed } from '@angular/core/testing';
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
  ...over,
});

class FakeBackend extends AgentBackend {
  readonly mode = 'mock' as const;
  handler: (e: AgentEvent) => void = () => {};
  history: Promise<StoredRun[]> = Promise.resolve([]);
  detectAgents(): Promise<DetectedAgent[]> {
    return Promise.resolve([]);
  }
  homeDir() {
    return Promise.resolve(null);
  }
  start(_agent: AgentId, _prompt: string, _cwd: string) {
    return Promise.resolve('new');
  }
  stop() {
    return Promise.resolve();
  }
  listRuns() {
    return this.history;
  }
  onEvent(handler: (e: AgentEvent) => void): Promise<Unlisten> {
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
  ...over,
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
