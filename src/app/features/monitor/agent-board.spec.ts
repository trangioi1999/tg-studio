import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../../core/backend';
import { MockBackend } from '../../core/mock/mock-backend';
import { PermissionRequest } from '../../core/protocol';
import { RunsService } from '../../services/runs/runs.service';
import { Run } from '../../services/runs/run';
import { UiService } from '../../services/app/ui.service';
import { ThreadList } from '../../layout/thread-list';
import { AgentBoard } from './agent-board';

const permission: PermissionRequest = { requestId: 'p', toolCall: { title: 'Chạy kiểm tra' }, rule: null,
  options: [{ kind: 'allow_always', optionId: 'unsafe', name: 'Luôn cho phép' },
    { kind: 'allow_once', optionId: 'yes', name: 'Cho phép' }, { kind: 'reject_once', optionId: 'no', name: 'Từ chối' }] };
const run = (over: Partial<Run> = {}): Run => ({ id: 'r', agent: 'claude', prompt: 'Viết kiểm tra', cwd: '/repo', project: '/repo', thread: 'r',
  startedAt: Date.now() - 10_000, endedAt: null, status: 'running', lines: [], usage: null, exitCode: null, restored: false,
  task: true, permissions: [], lastMessage: '', group: null, scope: null, waits: [], plan: [], progress: null, ...over });
async function setup(list: Run[] = []) {
  const backend = new MockBackend();
  vi.spyOn(backend, 'listRuns').mockResolvedValue([]);
  vi.spyOn(backend, 'onEvent').mockResolvedValue(() => {});
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  const runs = TestBed.inject(RunsService);
  await new Promise(r => setTimeout(r));
  runs.runs.set(list);
  const respond = vi.spyOn(runs, 'respondPermission').mockResolvedValue();
  const open = vi.spyOn(TestBed.inject(UiService), 'openAgentWindow');
  const fixture = TestBed.createComponent(AgentBoard);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { runs, respond, open, fixture, el };
}
function button(el: HTMLElement, label: string): HTMLButtonElement {
  return [...el.querySelectorAll('button')].find(b => b.textContent?.includes(label))!;
}

describe('Bảng agent', () => {
  it('empty_board_shows_sleeping_cat', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('Chưa có agent nào chạy hôm nay.');
    expect(el.querySelector('img[src="mascot/sleep.webp"]')).toBeTruthy();
  });
  it('opens the real card button and returns focus to it', async () => {
    const { el, open } = await setup([run()]);
    const card = el.querySelector<HTMLButtonElement>('button.ab-open')!;
    card.click();
    expect(open).toHaveBeenCalledWith('r', card);
  });
  it('answers once using the supplied option without opening the window', async () => {
    const { el, respond, open } = await setup([run({ permissions: [permission] })]);
    const allow = button(el, 'Cho phép lần này');
    allow.click(); allow.click();
    expect(respond).toHaveBeenCalledExactlyOnceWith('r', 'p', 'yes', false);
    expect(open).not.toHaveBeenCalled();
    expect(allow.closest('button button')).toBeNull();
  });
  it('rejects with the supplied rejection option', async () => {
    const { el, respond, open } = await setup([run({ permissions: [permission] })]);
    button(el, 'Từ chối').click();
    expect(respond).toHaveBeenCalledWith('r', 'p', 'no', false);
    expect(open).not.toHaveBeenCalled();
  });
  it('card_approval_disappears_when_answered', async () => {
    const { el, fixture, runs, respond } = await setup([run({ permissions: [permission] })]);
    const stale = button(el, 'Cho phép lần này');
    runs.runs.update(rs => rs.map(r => ({ ...r, permissions: [] })));
    stale.click(); // Signal changed, DOM has not caught up yet.
    expect(respond).not.toHaveBeenCalled();
    fixture.detectChanges();
    expect(button(el, 'Cho phép lần này')).toBeUndefined();
    expect(el.querySelector('.ab-card .pill')?.textContent).toContain('Đang chạy');
  });
  it('shows the filtered empty state and resets to all', async () => {
    const { el, fixture } = await setup([run()]);
    button(el, 'Cần bạn').click(); fixture.detectChanges();
    expect(el.textContent).toContain('Không có agent nào cần bạn.');
    expect(el.querySelector('.ab-card')).toBeNull();
    button(el, 'Xem tất cả').click(); fixture.detectChanges();
    expect(el.querySelectorAll('.ab-card')).toHaveLength(1);
    expect(el.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Tất cả');
  });
  it('preserves session KPIs including grouped pending reviews, tokens and cost', async () => {
    const { el, fixture, runs } = await setup([run({ permissions: [permission], usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, costUsd: 0.5, source: 'reported', cumulative: true } })]);
    vi.spyOn(runs, 'getDiff').mockResolvedValue([{ path: 'a' }] as never);
    runs.runs.update(rs => [...rs, run({ id: 'a', thread: 'a', group: 'g', status: 'done', endedAt: Date.now() }), run({ id: 'b', thread: 'b', group: 'g', status: 'done', endedAt: Date.now() })]);
    fixture.detectChanges();
    await vi.waitFor(() => { fixture.detectChanges(); expect(el.querySelector('.ab-stats')?.textContent).toContain('Chờ xem'); });
    const stats = [...el.querySelectorAll('.ab-stats > div')].map(d => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]);
    expect(Object.fromEntries(stats)).toMatchObject({ 'Đang chạy': '1', 'Chờ duyệt': '1', 'Chờ xem': '1', 'Lượt chạy': '3', 'Token': '120' });
    expect(Object.fromEntries(stats)['Chi phí']).toContain('0.50');
  });
  it('shows approval errors and allows retry without choosing allow_always', async () => {
    const { el, fixture, respond } = await setup([run({ permissions: [permission] })]);
    respond.mockRejectedValueOnce(new Error('offline'));
    button(el, 'Cho phép lần này').click();
    await vi.waitFor(() => { fixture.detectChanges(); expect(el.querySelector('[role="alert"]')?.textContent).toContain('Không gửi được'); });
    button(el, 'Cho phép lần này').click();
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenLastCalledWith('r', 'p', 'yes', false);
  });
  it('renders child identity, CLI tail, zero context and failure status', async () => {
    const { el } = await setup([run(), run({ id: 'child', parent: 'r', agent: 'codex', status: 'failed', endedAt: Date.now(),
      context: { used: 0, size: 100, percent: 0, source: 'acp' }, lines: [{ tone: 'text', text: 'Một\nHai\nBa\nBốn' }] })]);
    const cards = [...el.querySelectorAll('.ab-card')];
    expect(cards[0].textContent).toContain('Chưa có số liệu ngữ cảnh');
    expect(cards[0].querySelector('.ab-meter')).toBeNull();
    expect(cards[1].textContent).toContain('↳ của Viết kiểm tra');
    expect(cards[1].querySelector('.ab-tail')?.textContent).toBe('Hai\nBa\nBốn');
    expect(cards[1].querySelector('.pill')?.getAttribute('data-status')).toBe('failed');
    expect(cards[1].querySelector('.ab-context')?.textContent).toContain('0%');
  });
  it('moves filter tabs with arrows and wraps', async () => {
    const { el, fixture } = await setup([run()]);
    const all = button(el, 'Tất cả');
    all.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); fixture.detectChanges();
    expect(el.querySelector('[aria-selected="true"]')?.textContent).toContain('Đang ngủ');
    button(el, 'Đang ngủ').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); fixture.detectChanges();
    expect(el.querySelector('[aria-selected="true"]')?.textContent).toContain('Tất cả');
  });
  it('labels the sidebar Bảng agent', async () => {
    await setup();
    const fixture = TestBed.createComponent(ThreadList); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Bảng agent');
    expect(fixture.nativeElement.textContent).not.toContain('Giám sát');
  });
});
