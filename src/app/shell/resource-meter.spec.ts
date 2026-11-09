import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../core/backend';
import { MockBackend } from '../core/mock-backend';
import { ResourceReport, UsageGroup } from '../core/protocol';
import { RunsService } from '../runs/runs.service';
import { ResourceMeter } from './resource-meter';

const mb = 1024 * 1024;
const proc = (pid: number, parent: number | null, name: string) => ({ pid, parent, name, cpu: 1, memory: 100 * mb });

class FakeBackend extends MockBackend {
  killed: number[] = [];
  report: ResourceReport = { at: 1, cpu: 3, memory: 400 * mb, cores: 8, webview: false, groups: [] };
  override async resourceUsage() { return this.report; }
  override async killProcess(pid: number) { this.killed.push(pid); }
}

async function render(groups: UsageGroup[]) {
  const backend = new FakeBackend();
  backend.report = { ...backend.report, groups };
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  const fixture = TestBed.createComponent(ResourceMeter);
  await new Promise((r) => setTimeout(r));
  fixture.detectChanges();
  const meter = fixture.componentInstance as unknown as { rows(): { key: string; label: string; stop: boolean; group: UsageGroup }[]; stop(g: UsageGroup): Promise<void> };
  return { backend, fixture, meter, el: fixture.nativeElement as HTMLElement };
}

describe('ResourceMeter', () => {
  it('shows the total in the status bar', async () => {
    const { el } = await render([{ kind: 'app', runId: null, cpu: 3, memory: 400 * mb, processes: [proc(1, null, 'tg-studio')] }]);
    expect(el.textContent).toContain('TG · 400 MB · 3%');
  });

  it('stops a conversation through its run, and leftovers by their top process', async () => {
    const other: UsageGroup = { kind: 'other', runId: null, cpu: 0, memory: 0, processes: [proc(10, 1, 'probe'), proc(11, 10, 'node')] };
    const { backend, meter } = await render([{ kind: 'app', runId: null, cpu: 0, memory: 0, processes: [] }, other]);
    const runs = TestBed.inject(RunsService);
    let stopped = '';
    runs.stop = async (id: string) => { stopped = id; };
    await meter.stop({ kind: 'run', runId: 'r1', cpu: 0, memory: 0, processes: [] });
    expect(stopped).toBe('r1');
    await meter.stop(other);
    expect(backend.killed).toEqual([10]);
  });

  it('labels a run by its conversation and offers Dừng only while it lives', async () => {
    const { meter } = await render([{ kind: 'run', runId: 'gone', cpu: 0, memory: 0, processes: [proc(5, 1, 'claude')] }]);
    expect(meter.rows()[0].label).toBe('Cuộc trò chuyện đã đóng');
    expect(meter.rows()[0].stop).toBe(false);
  });
});
