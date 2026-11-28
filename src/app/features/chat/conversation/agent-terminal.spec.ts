import { TestBed } from '@angular/core/testing';
import { AgentBackend, Unlisten } from '../../../core/backend';
import { MockBackend } from '../../../core/mock/mock-backend';
import { AgentEvent, DetectedAgent } from '../../../core/protocol';
import { UiService } from '../../../services/app/ui.service';
import { RunsService } from '../../../services/runs/runs.service';
import { Run } from '../../../services/runs/run';
import { AgentTerminal, clock, canMessage, runEnd, terminalLines } from './agent-terminal';
import { Delegations } from './delegations';

class FakeBackend extends MockBackend {
  handler: (e: AgentEvent) => void = () => {};
  sent: [string, string][] = [];
  override detectAgents(): Promise<DetectedAgent[]> { return Promise.resolve([]); }
  override listRuns() { return Promise.resolve([]); }
  override onEvent(handler: (e: AgentEvent) => void): Promise<Unlisten> { this.handler = handler; return Promise.resolve(() => {}); }
  override async sendMessage(runId: string, text: string): Promise<void> { this.sent.push([runId, text]); }
}

const ev = (over: Partial<AgentEvent>): AgentEvent => ({ runId: 'p', agent: 'claude', kind: 'log', line: null, usage: null, code: null, atMs: 1000, data: null, ...over });
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r)); };
const tool = (n: number) => ({ tone: 'tool' as const, text: `› Read f${n}.ts ✓` });

async function setup() {
  const backend = new FakeBackend();
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  const runs = TestBed.inject(RunsService);
  await flush();
  return { backend, runs, send: (e: Partial<AgentEvent>) => backend.handler(ev(e)) };
}

function runOf(over: Partial<Run> = {}): Run {
  return { id: 'c', agent: 'codex', prompt: 'Việc con', cwd: '/r', startedAt: 1, endedAt: null, status: 'running', lines: [], usage: null, exitCode: null, restored: false,
    task: false, permissions: [], lastMessage: '', group: null, thread: 't', project: '/r', scope: null, waits: [], plan: [], progress: null, parent: 'p', ...over } as Run;
}

describe('Agent terminal', () => {
  it('terminal_keeps_last_500_lines', async () => {
    const run = runOf({ lines: Array.from({ length: 5000 }, (_, i) => tool(i)) });
    const v = terminalLines(run, 500);
    expect(v.lines.length).toBeLessThanOrEqual(500);
    expect(v.hidden).toBeGreaterThan(0);
    expect(v.lines.at(-1)!.kind).toBe('status');

    await setup();
    const fixture = TestBed.createComponent(AgentTerminal);
    fixture.componentRef.setInput('run', run);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.at-line').length).toBeLessThanOrEqual(500);
    const more = [...el.querySelectorAll('button')].find((b) => /Hiện \d+ dòng trước/.test(b.textContent!));
    expect(more).toBeTruthy();
    more!.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.at-line').length).toBeGreaterThan(500);
  });

  it('terminal_stops_following_when_scrolled_up', async () => {
    await setup();
    const fixture = TestBed.createComponent(AgentTerminal);
    fixture.componentRef.setInput('run', runOf({ lines: [tool(1)] }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const screen = el.querySelector('.at-screen') as HTMLElement;
    let height = 1000;
    Object.defineProperty(screen, 'scrollHeight', { get: () => height, configurable: true });
    Object.defineProperty(screen, 'clientHeight', { get: () => 200, configurable: true });
    const add = async (n: number) => {
      height += 50;
      fixture.componentRef.setInput('run', runOf({ lines: [tool(1), ...Array.from({ length: n }, (_, i) => tool(i + 2))] }));
      fixture.detectChanges();
      await fixture.whenStable();
    };
    // At the bottom: new lines pull it down.
    screen.scrollTop = 800;
    screen.dispatchEvent(new Event('scroll'));
    await add(1);
    expect(screen.scrollTop).toBe(height);
    expect(el.textContent).not.toContain('↓ Dòng mới');
    // Scrolled up: it stays and offers the way down.
    screen.scrollTop = 100;
    screen.dispatchEvent(new Event('scroll'));
    await add(2);
    expect(screen.scrollTop).toBe(100);
    fixture.detectChanges();
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent!.includes('↓ Dòng mới'))!;
    expect(btn).toBeTruthy();
    btn.click();
    fixture.detectChanges();
    expect(screen.scrollTop).toBe(height);
    expect(el.textContent).not.toContain('↓ Dòng mới');
  });

  it('finished_child_collapses', async () => {
    const { runs, send } = await setup();
    send({ kind: 'started', line: 'Claude' });
    send({ runId: 'a', agent: 'codex', kind: 'started', line: 'Codex', data: { parent: 'p' } });
    send({ runId: 'b', agent: 'codex', kind: 'started', line: 'Codex', data: { parent: 'p' } });
    const fixture = TestBed.createComponent(Delegations);
    fixture.componentRef.setInput('parent', runs.runs().find((r) => r.id === 'p')!);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const toggles = () => [...el.querySelectorAll<HTMLButtonElement>('.dlg-toggle')];
    toggles()[0].click();
    fixture.detectChanges();
    expect(el.querySelectorAll('tg-agent-terminal').length).toBe(1);
    // Opening another folds the first.
    toggles()[0].click(); // A is open, so its row is gone and this one is B
    fixture.detectChanges();
    expect(el.querySelectorAll('tg-agent-terminal').length).toBe(1);
    expect(toggles().length).toBe(1);
    // It finishes while open: folds back to its summary row.
    send({ runId: 'a', agent: 'codex', kind: 'exit', code: 0, data: { status: 'done' } });
    send({ runId: 'b', agent: 'codex', kind: 'exit', code: 0, data: { status: 'done' } });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelectorAll('tg-agent-terminal').length).toBe(0);
    expect(el.querySelectorAll('.dlg-head').length).toBe(2);
    expect(el.textContent).toContain('Xong');
  });

  it('dm_hidden_for_single_turn_child', async () => {
    const { backend } = await setup();
    expect(canMessage(runOf({ parent: 'p', status: 'running' }))).toBe(false);
    expect(canMessage(runOf({ parent: 'p', status: 'idle' }))).toBe(false);
    expect(canMessage(runOf({ parent: null, agent: 'claude', status: 'idle' }))).toBe(true);
    expect(canMessage(runOf({ parent: null, agent: 'claude', status: 'idle', restored: true }))).toBe(false);
    expect(canMessage(runOf({ parent: null, agent: 'codex', status: 'running' }))).toBe(false);

    const child = TestBed.createComponent(AgentTerminal);
    child.componentRef.setInput('run', runOf());
    child.detectChanges();
    expect((child.nativeElement as HTMLElement).querySelector('.at-input')).toBeNull();

    const fixture = TestBed.createComponent(AgentTerminal);
    fixture.componentRef.setInput('run', runOf({ id: 'k', agent: 'claude', parent: null, status: 'idle' }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector<HTMLInputElement>('.at-input')!;
    expect(input.placeholder).toContain('Nhắn riêng');
    input.value = 'làm tiếp đi';
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();
    expect(backend.sent).toEqual([['k', 'làm tiếp đi']]);
  });

  it('idle_run_clock_stops', () => {
    expect(runEnd(runOf({ status: 'running', endedAt: null }), 9000)).toBe(9000);
    expect(runEnd(runOf({ status: 'idle', endedAt: 4000 }), 9000)).toBe(4000);
    expect(runEnd(runOf({ status: 'idle', endedAt: null, turnAt: 3000 }), 9000)).toBe(3000);
  });

  it('one_child_open_per_parent_across_markers', async () => {
    const { runs, send } = await setup();
    send({ kind: 'started', line: 'Claude' });
    send({ runId: 'a', agent: 'codex', kind: 'started', line: 'Codex', data: { parent: 'p' } });
    send({ runId: 'b', agent: 'codex', kind: 'started', line: 'Codex', data: { parent: 'p' } });
    const parent = runs.runs().find((r) => r.id === 'p')!;
    // Two markers in one message, each with its own tg-delegations.
    const make = (only: number) => {
      const f = TestBed.createComponent(Delegations);
      f.componentRef.setInput('parent', parent);
      f.componentRef.setInput('only', [only]);
      f.detectChanges();
      return f;
    };
    const first = make(0);
    const second = make(1);
    const open = () => [first, second].reduce((n, f) => (f.detectChanges(), n + f.nativeElement.querySelectorAll('tg-agent-terminal').length), 0);
    (first.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.dlg-toggle')!.click();
    expect(open()).toBe(1);
    (second.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.dlg-toggle')!.click();
    expect(open()).toBe(1);
    expect(second.nativeElement.querySelectorAll('tg-agent-terminal').length).toBe(1);
  });

  it('opens the big window', async () => {
    await setup();
    const fixture = TestBed.createComponent(AgentTerminal);
    fixture.componentRef.setInput('run', runOf());
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[aria-label="Mở to"]')!.click();
    expect(TestBed.inject(UiService).agentWindow()).toBe('c');
  });
});

describe('Đánh bóng terminal', () => {
  it('hiện tin nhắn dưới dạng chữ thường', () => {
    expect(terminalLines(runOf({ lines: [{ tone: 'text', text: '**Xong** `a.ts`' }] }), 10).lines).toContainEqual({ kind: 'text', text: 'Xong a.ts' });
  });
  it('ẩn đồng hồ dưới một giây và không để ngoặc rỗng', () => {
    for (const ms of [-1, 0, 999]) expect(clock(ms)).toBe('');
    expect(clock(1000)).toBe('0:01');
    expect(terminalLines(runOf({ startedAt: 1000 }), 10, 1500).lines.at(-1)?.text).toBe('đang suy nghĩ…');
  });
  it('giữ avatar, bỏ mèo và thời lượng ngắn ở header', async () => {
    await setup();
    const f = TestBed.createComponent(AgentTerminal);
    f.componentRef.setInput('run', runOf({ status: 'done', startedAt: 1000, endedAt: 1500 }));
    f.detectChanges();
    expect(f.nativeElement.querySelector('.at-head tg-mascot')).toBeNull();
    expect(f.nativeElement.querySelector('.at-head tg-agent-avatar')).toBeTruthy();
    expect(f.nativeElement.querySelector('.at-meta').textContent).not.toContain('0:00');
  });
});
