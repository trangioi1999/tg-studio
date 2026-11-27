import { TestBed } from '@angular/core/testing';
import { AgentBackend, Unlisten } from '../../../core/backend';
import { MockBackend } from '../../../core/mock/mock-backend';
import { AgentEvent, DetectedAgent } from '../../../core/protocol';
import { UiService } from '../../../services/app/ui.service';
import { RunsService } from '../../../services/runs/runs.service';
import { Run } from '../../../services/runs/run';
import { WorkspaceService } from '../../../services/workspace.service';
import { AgentWindow } from './agent-window';

class FakeBackend extends MockBackend {
  sent: [string, string][] = [];
  override detectAgents(): Promise<DetectedAgent[]> { return Promise.resolve([]); }
  override listRuns() { return Promise.resolve([]); }
  override onEvent(_: (e: AgentEvent) => void): Promise<Unlisten> { return Promise.resolve(() => {}); }
  override async sendMessage(runId: string, text: string): Promise<void> { this.sent.push([runId, text]); }
}

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r)); };

function runOf(over: Partial<Run> = {}): Run {
  return { id: 'c', agent: 'codex', prompt: 'Review thay đổi', cwd: '/r', startedAt: 2, endedAt: null, status: 'running', lines: [], usage: null, exitCode: null, restored: false,
    task: false, permissions: [], lastMessage: '', group: null, thread: 't', project: '/r', scope: null, waits: [], plan: [], progress: null, parent: 'p', ...over } as Run;
}

const parent = runOf({ id: 'p', agent: 'claude', prompt: 'Đổi nhãn', parent: null, startedAt: 1, status: 'idle' });
const child = runOf({ id: 'c' });
const second = runOf({ id: 'd', agent: 'gemini', prompt: 'Viết test', startedAt: 3 });

async function setup(list: Run[] = [parent, child, second]) {
  const backend = new FakeBackend();
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  const runs = TestBed.inject(RunsService);
  await flush();
  runs.runs.set(list);
  const ui = TestBed.inject(UiService);
  const fixture = TestBed.createComponent(AgentWindow);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const render = () => { fixture.detectChanges(); return el; };
  return { backend, runs, ui, fixture, el, render };
}

const key = (target: Element, k: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('Agent window', () => {
  it('lists the conversation, moves with arrows, Esc closes and gives focus back', async () => {
    const { ui, el, render } = await setup();
    const from = document.createElement('button');
    document.body.appendChild(from);
    ui.openAgentWindow('c', from);
    render();
    const dialog = el.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    const rows = [...el.querySelectorAll('.aw-row')];
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Claude'), expect.stringContaining('Codex'), expect.stringContaining('Gemini')]);
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
    expect(rows[1].classList.contains('nested')).toBe(true);
    expect(el.querySelector('.aw-head')!.textContent).toContain('việc con của Claude');
    expect(el.querySelector('tg-agent-terminal')).toBeTruthy();

    key(dialog, 'ArrowDown');
    render();
    expect(ui.agentWindow()).toBe('d');
    key(dialog, 'ArrowUp');
    key(dialog, 'ArrowUp');
    render();
    expect(ui.agentWindow()).toBe('p');

    key(dialog, 'Escape');
    render();
    expect(ui.agentWindow()).toBeNull();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(from);
    from.remove();
  });

  it('Esc in the window does not reach the chat (which would stop the agent)', async () => {
    const { ui, el, render } = await setup();
    ui.openAgentWindow('c');
    render();
    let reached = false;
    const spy = () => (reached = true);
    window.addEventListener('keydown', spy);
    key(el.querySelector('[role="dialog"]')!, 'Escape');
    window.removeEventListener('keydown', spy);
    expect(reached).toBe(false);
  });

  it('window_closes_when_run_disappears', async () => {
    const { ui, runs, render } = await setup();
    ui.openAgentWindow('c');
    render();
    runs.runs.set([parent]);
    render();
    await flush();
    expect(ui.agentWindow()).toBeNull();
  });

  it('stays open when the run finishes and shows Xong', async () => {
    const { ui, runs, el, render } = await setup();
    ui.openAgentWindow('c');
    render();
    expect(el.querySelector('.aw-head .pill')!.textContent).toContain('Đang chạy');
    expect(el.querySelector('.aw-head [aria-label^="Dừng"]')).toBeTruthy();
    runs.runs.set([parent, { ...child, status: 'done', endedAt: 5000 }, second]);
    render();
    await flush();
    expect(ui.agentWindow()).toBe('c');
    expect(el.querySelector('.aw-head .pill')!.textContent).toContain('Xong');
    expect(el.querySelector('.aw-head [aria-label^="Dừng"]')).toBeNull();
  });

  it('pins the run to the bottom log and closes', async () => {
    const { ui, runs, el, render } = await setup();
    runs.selectedId.set(null);
    ui.openAgentWindow('c');
    render();
    el.querySelector<HTMLButtonElement>('[aria-label="Ghim xuống khung dưới"]')!.click();
    render();
    expect(ui.agentWindow()).toBeNull();
    expect(ui.logRun()).toBe('c');
    expect(ui.sideOpen()).toBe(true);
    // The log shows the selected conversation: pick the child's.
    expect(runs.selectedId()).toBe('p');
  });

  it('shows the task and the changed files; a file opens the run’s changes', async () => {
    const { ui, el, render } = await setup([parent, { ...child, task: true, prompt: 'Review thay đổi\n\nchi tiết dài' }]);
    const ws = TestBed.inject(WorkspaceService);
    ui.openAgentWindow('c');
    render();
    ws.diffs.set({ c: [{ path: 'src/a.ts', status: 'modified', binary: false, patchHeader: '', hunks: [] }] });
    render();
    const tabs = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent!.trim())).toEqual(['Trực tiếp', 'Thay đổi · 1', 'Việc được giao']);
    tabs[2].click();
    render();
    expect(el.querySelector('.aw-prompt')!.textContent).toContain('chi tiết dài');
    tabs[1].click();
    render();
    const file = [...el.querySelectorAll<HTMLButtonElement>('.aw-file')];
    expect(file.map((f) => f.textContent)).toEqual([expect.stringContaining('src/a.ts')]);
    file[0].click();
    expect(ws.tabs().some((t) => t.kind === 'changes' && t.runId === 'c')).toBe(true);
    expect(ui.sideOpen()).toBe(true);
    expect(ui.agentWindow()).toBeNull();
  });

  it('messages an agent that takes one, Enter focuses the box', async () => {
    const idle = runOf({ id: 'k', agent: 'claude', parent: null, status: 'idle', thread: 'u' });
    const { backend, ui, el, render } = await setup([idle]);
    ui.openAgentWindow('k');
    render();
    const input = el.querySelector<HTMLInputElement>('.aw-input')!;
    expect(input).toBeTruthy();
    key(el.querySelector('.aw-row')!, 'Enter');
    expect(document.activeElement).toBe(input);
    input.value = 'làm tiếp';
    el.querySelector('.aw-dm')!.dispatchEvent(new Event('submit'));
    await flush();
    expect(backend.sent).toEqual([['k', 'làm tiếp']]);
  });

  it('has no message box for a one-shot child', async () => {
    const { ui, el, render } = await setup();
    ui.openAgentWindow('c');
    render();
    expect(el.querySelector('.aw-input')).toBeNull();
  });
});
