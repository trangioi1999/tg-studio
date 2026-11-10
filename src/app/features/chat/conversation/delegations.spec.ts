import { TestBed } from '@angular/core/testing';
import { AgentBackend, Unlisten } from '../../../core/backend';
import { MockBackend } from '../../../core/mock/mock-backend';
import { AgentEvent, DetectedAgent, StoredRun } from '../../../core/protocol';
import { RunsService } from '../../../services/runs/runs.service';
import { Delegations, taskOf } from './delegations';

class FakeBackend extends MockBackend {
  handler: (e: AgentEvent) => void = () => {};
  history: StoredRun[] = [];
  override detectAgents(): Promise<DetectedAgent[]> { return Promise.resolve([]); }
  override listRuns() { return Promise.resolve(this.history); }
  override onEvent(handler: (e: AgentEvent) => void): Promise<Unlisten> {
    this.handler = handler;
    return Promise.resolve(() => {});
  }
}

const ev = (over: Partial<AgentEvent>): AgentEvent => ({ runId: 'p', agent: 'claude', kind: 'log', line: null, usage: null, code: null, atMs: 1000, data: null, ...over });
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r)); };
const delegation = (over: Record<string, unknown>) => ({
  tool: 'delegate', id: 'd1', parent: 'p', child: null, agent: 'codex', task: 'Viết test cho tiêu đề', status: 'running',
  summary: null, filesChanged: [], conflicts: [], worktree: null, ...over,
});

async function setup(history: StoredRun[] = []) {
  const backend = new FakeBackend();
  backend.history = history;
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  const runs = TestBed.inject(RunsService);
  await flush();
  return { backend, runs, send: (e: Partial<AgentEvent>) => backend.handler(ev(e)) };
}

function render(runs: RunsService) {
  const fixture = TestBed.createComponent(Delegations);
  fixture.componentRef.setInput('parent', runs.runs().find((r) => r.id === 'p')!);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('Delegated agents', () => {
  it('a delegated run joins its parent\'s conversation, nested, and gets the task as its prompt', async () => {
    const { runs, send } = await setup();
    send({ kind: 'started', line: 'Claude' });
    send({ kind: 'bridge', line: '◆ tg-bridge · giao cho Codex', data: delegation({}) });
    expect(runs.runs().find((r) => r.id === 'p')!.delegations![0].status).toBe('running');
    send({ runId: 'c', agent: 'codex', kind: 'started', line: 'Codex', data: { parent: 'p' } });
    send({ kind: 'bridge', line: '◆', data: delegation({ child: 'c', worktree: '/repo/.tg/worktrees/c' }) });
    const child = runs.runs().find((r) => r.id === 'c')!;
    const parent = runs.runs().find((r) => r.id === 'p')!;
    expect(child.parent).toBe('p');
    expect(child.thread).toBe(parent.thread);
    expect(child.prompt).toBe('Viết test cho tiêu đề');
    expect(parent.delegations!.length).toBe(1);

    let el = render(runs);
    expect(el.querySelector('.dlg-task')!.textContent).toContain('Viết test cho tiêu đề');
    expect(el.querySelector('.pill')!.textContent).toContain('Đang chạy');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent!.includes('Dừng'))).toBe(true);

    send({ runId: 'c', agent: 'codex', kind: 'exit', code: 0, data: { status: 'done' } });
    send({ kind: 'bridge', line: '◆', data: delegation({ tool: 'delegate_done', child: 'c', status: 'done', filesChanged: ['src/app/app.spec.ts'] }) });
    el = render(runs);
    expect(el.querySelector('.pill')!.textContent).toContain('Xong');
    expect(el.querySelector('.dlg-now')!.textContent).toContain('Đã gộp 1 tệp: src/app/app.spec.ts');
  });

  it('an agent\'s own subagent nests under it with its title, without a draft', async () => {
    const { runs, send } = await setup();
    send({ kind: 'started', line: 'Claude' });
    send({ runId: 'p~1', kind: 'started', line: 'Subagent · Tìm cấu hình', data: { parent: 'p', subagent: true, title: 'Tìm cấu hình' } });
    send({ runId: 'p~1', kind: 'message', data: { text: 'Thấy ở a.json' } });
    const sub = runs.runs().find((r) => r.id === 'p~1')!;
    expect([sub.parent, sub.prompt, sub.thread]).toEqual(['p', 'Tìm cấu hình', runs.runs().find((r) => r.id === 'p')!.thread]);
    const el = render(runs);
    expect(el.querySelector('.dlg-task')!.textContent).toContain('Tìm cấu hình');
    expect(el.querySelector('.dlg-now')!.textContent).toContain('Thấy ở a.json');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent!.includes('Xem thay đổi'))).toBe(false);
  });

  it('shows a refusal and a conflict in words', async () => {
    const { runs, send } = await setup();
    send({ kind: 'started', line: 'Claude' });
    send({ kind: 'bridge', data: delegation({ id: 'd1', status: 'refused', summary: 'Người dùng không cho giao việc này; hãy tự làm phần này.' }) });
    send({ kind: 'bridge', data: delegation({ id: 'd2', status: 'conflict', child: null, conflicts: ['a.ts'] }) });
    const el = render(runs);
    const rows = [...el.querySelectorAll('.dlg-item')].map((r) => r.textContent!);
    expect(rows[0]).toContain('Không giao');
    expect(rows[0]).toContain('Người dùng không cho giao');
    expect(rows[1]).toContain('Xung đột');
    expect(rows[1]).toContain('1 tệp xung đột: a.ts');
  });

  it('history: child runs nest under their parent from the stored link', async () => {
    const stored = (over: Partial<StoredRun>): StoredRun => ({ id: 'p', agent: 'claude', prompt: 'Làm tính năng', cwd: '/repo', startedAt: 1, endedAt: 9, status: 'done', exitCode: 0,
      usage: null, lines: [], worktree: null, group: null, thread: 't', project: '/repo', scope: null, ...over });
    const { runs } = await setup([
      stored({ id: 'c', agent: 'codex', prompt: 'Viết test\n\nTệp liên quan: a.ts\n\n(Việc được Claude Code giao qua TG Studio. Chỉ làm đúng phần này.)', parent: 'p', startedAt: 2 }),
      stored({}),
    ]);
    expect(runs.runs().find((r) => r.id === 'c')!.parent).toBe('p');
    const el = render(runs);
    expect(el.querySelector('.dlg-task')!.textContent!.trim()).toBe('Viết test');
  });

  it('each delegation shows where it was made, once', async () => {
    const { runs, send } = await setup();
    send({ kind: 'started', line: 'Claude' });
    send({ kind: 'bridge', line: '◆ tg-bridge · giao cho Codex: A', data: delegation({ id: 'd1', task: 'A' }) });
    send({ kind: 'bridge', line: '◆', data: delegation({ id: 'd1', task: 'A', child: 'c1' }) });
    send({ kind: 'user', line: 'Làm B' });
    send({ kind: 'bridge', line: '◆ tg-bridge · giao cho Codex: B', data: delegation({ id: 'd2', task: 'B' }) });
    const marks = runs.runs().find((r) => r.id === 'p')!.lines.filter((l) => l.tone === 'delegate');
    expect(marks.map((l) => l.label)).toEqual(['d1', 'd2']);

    const fixture = TestBed.createComponent(Delegations);
    fixture.componentRef.setInput('parent', runs.runs().find((r) => r.id === 'p')!);
    fixture.componentRef.setInput('only', ['d2']);
    fixture.detectChanges();
    const tasks = () => [...(fixture.nativeElement as HTMLElement).querySelectorAll('.dlg-task')].map((t) => t.textContent!.trim());
    expect(tasks()).toEqual(['B']);
    fixture.componentRef.setInput('only', null);
    fixture.componentRef.setInput('except', ['d1', 'd2']);
    fixture.detectChanges();
    expect(tasks()).toEqual([]);
  });

  it('history: saved children match their markers in order; subagents stay unanchored', async () => {
    const stored = (over: Partial<StoredRun>): StoredRun => ({ id: 'p', agent: 'claude', prompt: 'x', cwd: '/repo', startedAt: 1, endedAt: 9, status: 'done', exitCode: 0,
      usage: null, lines: [], worktree: null, group: null, thread: 't', project: '/repo', scope: null, ...over });
    const { runs } = await setup([
      stored({ id: 'c2', agent: 'claude', prompt: 'B', parent: 'p', startedAt: 5 }),
      stored({ id: 'p~1', agent: 'claude', prompt: 'Tìm', parent: 'p', startedAt: 2 }),
      stored({ id: 'c1', agent: 'codex', prompt: 'A', parent: 'p', startedAt: 3 }),
      stored({}),
    ]);
    const fixture = TestBed.createComponent(Delegations);
    fixture.componentRef.setInput('parent', runs.runs().find((r) => r.id === 'p')!);
    const tasks = () => [...(fixture.nativeElement as HTMLElement).querySelectorAll('.dlg-task')].map((t) => t.textContent!.trim());
    fixture.componentRef.setInput('only', [1]);
    fixture.detectChanges();
    expect(tasks()).toEqual(['B']);
    fixture.componentRef.setInput('only', null);
    fixture.componentRef.setInput('except', [0, 1]);
    fixture.detectChanges();
    expect(tasks()).toEqual(['Tìm']);
  });

  it('taskOf strips what TG Studio adds for the agent', () => {
    expect(taskOf('Viết test\n\nTệp liên quan: a.ts, b.ts\n\n(Việc được Claude giao qua TG Studio. Xong thì tóm tắt.)')).toBe('Viết test');
    expect(taskOf('Chỉ một dòng')).toBe('Chỉ một dòng');
  });
});
