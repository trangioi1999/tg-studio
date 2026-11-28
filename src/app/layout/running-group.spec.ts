import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Run } from '../services/runs/run';
import { RunsService } from '../services/runs/runs.service';
import { Thread, ThreadsService } from '../services/runs/threads.service';
import { UiService } from '../services/app/ui.service';
import { WorkspaceService } from '../services/workspace.service';
import { runningRows } from './running-group';
import { ThreadList } from './thread-list';

const run = (id: string, over: Partial<Run> = {}): Run => ({
  id, agent: 'claude', prompt: 'Sửa giao diện', cwd: '/a', startedAt: 1, endedAt: null,
  status: 'running', lines: [], usage: null, exitCode: null, restored: false,
  task: true, permissions: [], lastMessage: '', group: null, thread: id, project: '/a',
  scope: null, waits: [], plan: [], progress: null, ...over,
});

describe('runningRows', () => {
  it('running_group_nests_children_and_caps', () => {
    const input = [run('A'), run('B', { project: '/b' }), run('A~1'),
      run('A-child', { parent: 'A', agent: 'codex', prompt: 'Kiểm tra' }), run('idle', { status: 'idle' })];
    const { rows, more } = runningRows(input);
    expect(rows.map((r) => r.id)).toEqual(['A', 'A~1', 'A-child', 'B']);
    expect(rows.map((r) => r.child)).toEqual([false, true, true, false]);
    expect(rows[2].title).toBe('↳ Codex · Kiểm tra');
    expect(rows.map((r) => r.open)).toEqual(['A', 'A', 'A', 'B']);
    expect(rows[3].project).toBe('/b');
    expect(more).toBe(0);
    const many = Array.from({ length: 12 }, (_, i) => run(`${i}`));
    expect(runningRows(many, 8).rows).toHaveLength(8);
    expect(runningRows(many, 8).more).toBe(4);
    expect(runningRows(many).more).toBe(4);
    expect(input.map((r) => r.id)).toEqual(['A', 'B', 'A~1', 'A-child', 'idle']);
  });

  it('hiện con không thụt khi cha đã nghỉ hoặc không có trong danh sách', () => {
    const { rows } = runningRows([run('A~1'), run('A', { status: 'idle' }),
      run('con', { parent: 'vắng', agent: 'codex' })]);
    expect(rows.map((r) => r.id)).toEqual(['A~1', 'con']);
    expect(rows.map((r) => r.open)).toEqual(['A', 'con']);
    expect(rows.every((r) => !r.child)).toBe(true);
    expect(rows[1].title).toBe('↳ Codex · Sửa giao diện');
  });

  it('ưu tiên chờ duyệt, rút gọn tiêu đề và bỏ các lượt đã kết thúc', () => {
    const { rows } = runningRows([run('duyệt', { status: 'idle', permissions: [{}] as Run['permissions'] }),
      run('dài', { prompt: 'a'.repeat(200) }), run('xong', { status: 'done' }),
      run('lỗi', { status: 'failed' }), run('dừng', { status: 'stopped' })]);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('needs_you');
    expect(rows[1].title.length).toBeLessThanOrEqual(80);
    expect(runningRows([])).toEqual({ rows: [], more: 0 });
  });
});

describe('ThreadList · Đang chạy', () => {
  function render(initial: Run[]) {
    const runs = signal(initial);
    const openRun = vi.fn();
    TestBed.configureTestingModule({ providers: [
      { provide: RunsService, useValue: { runs } },
      { provide: ThreadsService, useValue: { projects: signal([]), selectedId: signal(null) } },
      { provide: WorkspaceService, useValue: { folder: signal('/a') } },
      { provide: UiService, useValue: { sidebarCollapsed: signal(false), screen: signal('chat'), openRun } },
    ] });
    const fixture = TestBed.createComponent(ThreadList);
    fixture.detectChanges();
    return { fixture, runs, openRun, el: fixture.nativeElement as HTMLElement };
  }

  it('hiện nhóm trên dự án và mở lượt chạy khi bấm', () => {
    const { el, openRun } = render([run('A')]);
    expect(el.textContent).toContain('Đang chạy · 1');
    expect(el.textContent!.indexOf('Đang chạy')).toBeLessThan(el.textContent!.indexOf('Dự án'));
    const row = el.querySelector<HTMLButtonElement>('.rn-row')!;
    expect(row.querySelector('tg-agent-avatar')).not.toBeNull();
    expect(row.querySelector('.rn-dot')?.getAttribute('data-status')).toBe('running');
    row.click();
    expect(openRun).toHaveBeenCalledWith('A');
  });

  it('đếm cả phần còn lại, cập nhật chờ duyệt và ẩn khi rỗng', () => {
    const { el, fixture, runs } = render(Array.from({ length: 12 }, (_, i) => run(`${i}`)));
    expect(el.textContent).toContain('Đang chạy · 12');
    expect(el.querySelectorAll('.rn-row')).toHaveLength(8);
    expect(el.textContent).toContain('+4 nữa');
    runs.set([run('duyệt', { permissions: [{}] as Run['permissions'] })]);
    fixture.detectChanges();
    expect(el.querySelector('.rn-dot')?.getAttribute('data-status')).toBe('needs_you');
    runs.set([run('nghỉ', { status: 'idle' })]);
    fixture.detectChanges();
    expect(el.querySelector('.rn-group')).toBeNull();
  });
});

describe('ThreadList · trạng thái cuộc trò chuyện', () => {
  const thread = (id: string, status: Thread['status']): Thread => ({
    id, project: '/a', scope: null, title: id, agents: ['claude'], status, updatedAt: 1, latest: run(id),
  });

  it('đang chạy là chấm, chờ duyệt là chấm kèm chữ, không spinner', () => {
    TestBed.configureTestingModule({ providers: [
      { provide: RunsService, useValue: { runs: signal([]) } },
      { provide: ThreadsService, useValue: { selectedId: signal(null), projects: signal([{ root: '/a', name: 'a', scopes: [],
        threads: [thread('chạy', 'running'), thread('duyệt', 'needs_you'), thread('xong', 'waiting')] }]) } },
      { provide: WorkspaceService, useValue: { folder: signal('/a') } },
      { provide: UiService, useValue: { sidebarCollapsed: signal(false), screen: signal('chat'), openRun: vi.fn() } },
    ] });
    const fixture = TestBed.createComponent(ThreadList);
    fixture.detectChanges();
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.tl-thread')];
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.querySelector('.spin'))).toBe(false);
    expect(rows[0].querySelector('.pill')).toBeNull();
    expect(rows[0].querySelector('.tl-dot')?.getAttribute('aria-label')).toBe('Đang chạy');
    expect(rows[0].title).toContain('Đang chạy');
    expect(rows[1].querySelector('.pill')).toBeNull();
    expect(rows[1].querySelector('.tl-status')?.textContent?.trim()).toBe('Chờ duyệt');
    expect(rows[1].querySelector('.tl-dot')?.getAttribute('data-status')).toBe('needs_you');
    expect(rows[2].querySelector('.pill')?.textContent).toContain('Xong');
  });
});
