import { TestBed } from '@angular/core/testing';
import { AgentBackend, Unlisten } from '../../core/backend';
import { MockBackend } from '../../core/mock/mock-backend';
import { AgentEvent, DetectedAgent } from '../../core/protocol';
import { UiService } from '../../services/app/ui.service';
import { RunsService } from '../../services/runs/runs.service';
import { Run } from '../../services/runs/run';
import { Terminal } from './terminal';

class FakeBackend extends MockBackend {
  override detectAgents(): Promise<DetectedAgent[]> { return Promise.resolve([]); }
  override listRuns() { return Promise.resolve([]); }
  override onEvent(_: (e: AgentEvent) => void): Promise<Unlisten> { return Promise.resolve(() => {}); }
}

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r)); };
const run = (over: Partial<Run>): Run => ({
  id: 'r', agent: 'claude', prompt: '', cwd: '/a', startedAt: 1, endedAt: null, status: 'done', lines: [], usage: null, exitCode: null, restored: false,
  task: true, permissions: [], lastMessage: '', group: null, thread: 't', project: '/a', scope: null, waits: [], plan: [], progress: null, ...over,
}) as Run;

describe('Bottom panel log', () => {
  it('shows only the run pinned from the agent window, until cleared', async () => {
    try { localStorage.removeItem('tg.bottom'); } catch { /* none */ }
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: new FakeBackend() }] });
    const runs = TestBed.inject(RunsService);
    await flush();
    runs.runs.set([
      run({ id: 'p', startedAt: 1, lines: [{ text: 'cha làm', tone: 'text' }] }),
      run({ id: 'c', agent: 'codex', parent: 'p', prompt: 'Review', startedAt: 2, lines: [{ text: 'con làm', tone: 'text' }] }),
    ]);
    runs.selectedId.set('p');
    const fixture = TestBed.createComponent(Terminal);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.lg-body')).toBeNull();

    TestBed.inject(UiService).logRun.set('c');
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect(el.querySelectorAll('.lg-sec').length).toBe(1);
    expect(el.querySelector('.lg-body')!.textContent).toContain('con làm');
    const chip = el.querySelector<HTMLButtonElement>('[aria-label="Bỏ lọc theo agent này"]')!;
    expect(chip.textContent).toContain('Codex');
    chip.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.lg-sec').length).toBe(2);
    expect(TestBed.inject(UiService).logRun()).toBeNull();
  });

  it('reopens the Log when the same run is pinned again', async () => {
    try { localStorage.removeItem('tg.bottom'); } catch { /* none */ }
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: new FakeBackend() }] });
    const runs = TestBed.inject(RunsService);
    await flush();
    runs.runs.set([run({ id: 'p' }), run({ id: 'c', agent: 'codex', parent: 'p', startedAt: 2 })]);
    runs.selectedId.set('p');
    const ui = TestBed.inject(UiService);
    const fixture = TestBed.createComponent(Terminal);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    ui.pinLog('c');
    fixture.detectChanges();
    expect(el.querySelector('.lg-body')).toBeTruthy();
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.trim() === 'Thu gọn')!.click();
    fixture.detectChanges();
    expect(el.querySelector('.lg-body')).toBeNull();
    ui.pinLog('c');
    fixture.detectChanges();
    expect(el.querySelector('.lg-body')).toBeTruthy();
  });
});
