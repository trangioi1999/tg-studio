import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AgentBackend } from '../../../core/backend';
import { MockBackend } from '../../../core/mock/mock-backend';
import { ContextUsage } from '../../../core/protocol';
import { Run } from '../../../services/runs/run';
import { RunsService } from '../../../services/runs/runs.service';
import { AgentsService } from '../../../services/agents/agents.service';
import { WorkspaceService } from '../../../services/workspace.service';
import { AgentPanel } from '../agent-panel';

const run = (over: Partial<Run> = {}): Run => ({
  id: 'r1', agent: 'claude', prompt: 'p', cwd: '/demo', startedAt: 1, endedAt: null, status: 'idle', lines: [], usage: null, exitCode: null, restored: false,
  task: true, permissions: [], lastMessage: '', group: null, thread: 't', project: '/demo', scope: null, waits: [], plan: [], progress: null, ...over,
});
const context = (percent: number): ContextUsage => ({
  used: percent * 10_000, size: 1_000_000, percent, source: 'claude',
  categories: [{ id: 'messages', name: 'Messages', tokens: 99_300, kind: 'used' }, { id: 'free_space', name: 'Free space', tokens: 782_300, kind: 'free' }],
});

async function setup(r: Run) {
  const backend = new MockBackend();
  const refresh = vi.spyOn(backend, 'refreshContext').mockResolvedValue();
  const send = vi.spyOn(backend, 'sendMessage').mockResolvedValue();
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  await TestBed.inject(AgentsService).refresh();
  await TestBed.inject(WorkspaceService).setFolder('/demo');
  const runs = TestBed.inject(RunsService);
  runs.runs.set([r]);
  runs.selectedId.set(r.id);
  const fixture = TestBed.createComponent(AgentPanel);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, refresh, send };
}

describe('context chip', () => {
  afterEach(() => localStorage.removeItem('tg.repo'));

  it('chip_hidden_without_context', async () => {
    const { el } = await setup(run({ restored: true, status: 'done' }));
    expect(el.querySelector('.ctx-chip')).toBeNull();
  });

  it('opening_panel_refreshes_context', async () => {
    const { fixture, el, refresh } = await setup(run({ context: context(18) }));
    const chip = el.querySelector<HTMLButtonElement>('.ctx-chip')!;
    expect(chip.textContent).toContain('18%');
    chip.click();
    fixture.detectChanges();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('r1');
    expect(el.querySelector('.ctx-panel')?.textContent).toContain('Tin nhắn');
  });
});

describe('context alert', () => {
  afterEach(() => localStorage.removeItem('tg.repo'));

  const button = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLButtonElement>('.ctx-alert button')).find((b) => b.textContent?.trim() === 'Thu gọn');

  it('offers_compact_from_85_percent', async () => {
    const { fixture, el, send } = await setup(run({ context: context(86) }));
    expect(el.querySelector('.ctx-alert')?.textContent).toContain('Context đã dùng 86%');
    button(el)!.click();
    fixture.detectChanges();
    expect(send).toHaveBeenCalledWith('r1', '/compact');
  });

  it('stays_quiet_below_85_percent', async () => {
    const { el } = await setup(run({ context: context(84) }));
    expect(button(el)).toBeUndefined();
  });
});
