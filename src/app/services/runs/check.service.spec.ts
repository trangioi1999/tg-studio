import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../../core/backend';
import { MockBackend } from '../../core/mock/mock-backend';
import { AgentEvent, CheckResult, FileDiff, ProjectSettings } from '../../core/protocol';
import { CheckService, fixMessage } from './check.service';
import { RunsService } from './runs.service';
import { Run } from './run';

const run = (over: Partial<Run>): Run => ({
  id: 'r1', agent: 'claude', prompt: 'p', cwd: '/repo', startedAt: 1, endedAt: null, status: 'running', lines: [], usage: null, exitCode: null, restored: false,
  task: true, permissions: [], lastMessage: '', group: null, thread: 't', project: '/repo', scope: null, waits: [], plan: [], progress: null, perm: 'ask', ...over,
});

const file = (path: string, added: number): FileDiff => ({
  path, status: 'M', binary: false, patchHeader: '',
  hunks: [{ id: `${path}-${added}`, header: '', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [], added, removed: 0 }],
});

const FAIL: CheckResult = { code: 1, output: 'Tests: 1 failed', truncated: false, durationMs: 10 };
const PASS: CheckResult = { code: 0, output: 'Tests: 9 passed', truncated: false, durationMs: 10 };

class Backend extends MockBackend {
  handler: (e: AgentEvent) => void = () => {};
  diff: FileDiff[] = [];
  hooks: ProjectSettings = { setup: '', check: 'npm test', autoFix: true, maxFixRounds: 2 };
  results: CheckResult[] = [];
  checks: string[] = [];
  sent: [string, string][] = [];
  override async onEvent(h: (e: AgentEvent) => void) { this.handler = h; return () => {}; }
  override async getDiff() { return this.diff; }
  override async projectSettings() { return this.hooks; }
  override async runProjectCheck(runId: string) {
    this.checks.push(runId);
    if (!this.hooks.check) return null;
    return this.results.shift() ?? PASS;
  }
  override async sendMessage(runId: string, text: string) { this.sent.push([runId, text]); }
}

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r)); };
const ev = (kind: string, over: Partial<AgentEvent> = {}): AgentEvent =>
  ({ runId: 'r1', agent: 'claude', kind, line: null, usage: null, code: null, data: null, atMs: 1, ...over } as AgentEvent);

async function setup(over: Partial<Run> = {}) {
  const backend = new Backend();
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  const runs = TestBed.inject(RunsService);
  runs.runs.set([run(over)]);
  const service = TestBed.inject(CheckService);
  await service.ready;
  /** One agent turn: the user's message, then what the agent changed, then the end of the turn. */
  const turn = async (after: FileDiff[], text = 'sửa lỗi', end: AgentEvent = ev('turn_end', { data: { status: 'done' } })) => {
    backend.handler(ev('user', { line: text }));
    await tick();
    backend.diff = after;
    backend.handler(end);
    await tick();
  };
  const notes = () => runs.runs()[0].lines.map((l) => l.text);
  return { backend, runs, service, turn, notes };
}

describe('CheckService', () => {
  it('runs_check_after_turn_with_changes', async () => {
    const { backend, turn, notes } = await setup();
    await turn([file('a.ts', 3)]);
    expect(backend.checks).toEqual(['r1']);
    expect(notes().at(-1)).toContain('Kiểm tra `npm test`: đạt');
  });

  it('no_check_when_turn_changed_nothing', async () => {
    const { backend, turn } = await setup();
    backend.diff = [file('a.ts', 3)];
    await turn([file('a.ts', 3)]);
    expect(backend.checks).toEqual([]);
  });

  it('no_check_without_project_command', async () => {
    const { backend, turn, notes } = await setup();
    backend.hooks = { ...backend.hooks, check: '' };
    await turn([file('a.ts', 3)]);
    expect(notes().some((n) => n.includes('Kiểm tra'))).toBe(false);
  });

  it('sends_fix_message_on_failure', async () => {
    const { backend, turn, notes } = await setup();
    backend.results = [FAIL];
    await turn([file('a.ts', 3)]);
    expect(notes().at(-1)).toContain('hỏng (mã 1)');
    expect(backend.sent.length).toBe(1);
    expect(backend.sent[0][1]).toBe(fixMessage('npm test', FAIL));
    expect(backend.sent[0][1]).toContain('Lệnh kiểm tra `npm test`');
    expect(backend.sent[0][1]).toContain('Tests: 1 failed');
  });

  it('stops_after_max_rounds', async () => {
    const { backend, turn, notes } = await setup();
    backend.results = [FAIL, FAIL, FAIL];
    await turn([file('a.ts', 1)]);
    await turn([file('a.ts', 2)], backend.sent[0][1]);
    await turn([file('a.ts', 3)], backend.sent[1][1]);
    expect(backend.sent.length).toBe(2);
    expect(notes().at(-1)).toContain('Đã thử 2 lần, vẫn hỏng');
  });

  it('user_message_cancels_pending_fix', async () => {
    const { backend, service, turn } = await setup();
    let release!: (r: CheckResult) => void;
    backend.runProjectCheck = async (id: string) => { backend.checks.push(id); return new Promise<CheckResult>((r) => (release = r)); };
    await turn([file('a.ts', 1)]);
    backend.handler(ev('user', { line: 'thôi, làm việc khác' }));
    release(FAIL);
    await tick();
    expect(backend.sent).toEqual([]);
    expect(service.rounds('r1')).toBe(0);
  });

  it('deny_approval_never_auto_fixes', async () => {
    const { backend, turn } = await setup({ perm: 'read' });
    backend.results = [FAIL];
    await turn([file('a.ts', 1)]);
    expect(backend.checks).toEqual([]);
    expect(backend.sent).toEqual([]);
  });

  it('pipeline_step_checks_without_fixing', async () => {
    const { backend, turn, notes } = await setup();
    backend.results = [FAIL];
    await turn([file('a.ts', 1)], 'bước 1', ev('exit', { code: 0, data: { status: 'done' } }));
    expect(backend.checks).toEqual(['r1']);
    expect(notes().at(-1)).toContain('hỏng');
    expect(backend.sent).toEqual([]);
  });

  it('child_runs_are_not_checked', async () => {
    const { backend, turn } = await setup({ parent: 'p1' });
    await turn([file('a.ts', 1)]);
    expect(backend.checks).toEqual([]);
  });

  it('a_stopped_turn_is_not_checked', async () => {
    const { backend, turn } = await setup();
    await turn([file('a.ts', 1)], 'x', ev('turn_end', { data: { status: 'stopped' } }));
    expect(backend.checks).toEqual([]);
  });
});
