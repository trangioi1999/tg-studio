import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../../core/backend';
import { MockBackend } from '../../core/mock/mock-backend';
import { FileDiff, OwnChanges, Project, SyncStatus } from '../../core/protocol';
import { WorkspaceService } from '../../services/workspace.service';
import { DiffViewer } from './diff-viewer';

const file = (path: string, status = 'M', added = 2, removed = 1): FileDiff => ({
  path, status, binary: false, patchHeader: '',
  hunks: [{ id: `${path}-h`, header: '@@ -1,1 +1,2 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [], added, removed }],
});

class FakeBackend extends MockBackend {
  files: FileDiff[] = [file('src/a.ts'), file('src/new.ts', 'A', 5, 0)];
  own: OwnChanges = { direct: true, files: [{ path: 'notes.md', status: 'M' }] };
  calls: unknown[][] = [];
  override async getDiff() { return this.files; }
  override async ownChanges() { return this.own; }
  override async revertFiles(runId: string, paths: string[]) {
    this.calls.push(['revert', paths]);
    this.files = this.files.filter((f) => !paths.includes(f.path));
  }
  override async commitFiles(runId: string, paths: string[], message: string) {
    this.calls.push(['commit', paths, message]);
    this.files = this.files.filter((f) => !paths.includes(f.path));
    this.own = { ...this.own, files: this.own.files.filter((f) => !paths.includes(f.path)) };
    return 'abcdef0123';
  }
  sync: SyncStatus = { branch: 'feat', upstream: 'origin/feat', ahead: 2, behind: 0, remote: 'origin', github: true, gh: true, defaultBranch: 'main', prUrl: null };
  syncRoots: string[] = [];
  override async syncStatus(root: string) { this.syncRoots.push(root); return this.sync; }
  override async push(root: string) {
    this.calls.push(['push', root]);
    this.sync = { ...this.sync, ahead: 0 };
    return this.sync;
  }
  override async createPr(root: string, title: string, body: string) {
    this.calls.push(['pr', root, title, body]);
    this.sync = { ...this.sync, ahead: 0, prUrl: 'https://github.com/o/r/pull/7' };
    return this.sync.prUrl!;
  }
  override async openUrl(url: string) { this.calls.push(['open', url]); }
  override async acceptAll() {
    this.calls.push(['apply']);
    const n = this.files.length;
    this.files = [];
    return n;
  }
}

async function setup(own?: OwnChanges, sync?: Partial<SyncStatus>) {
  const backend = new FakeBackend();
  if (own) backend.own = own;
  if (sync) backend.sync = { ...backend.sync, ...sync };
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  TestBed.inject(WorkspaceService).project.set({ root: '/repo', name: 'repo' } as Project);
  const fixture = TestBed.createComponent(DiffViewer);
  fixture.componentRef.setInput('runId', 'r1');
  fixture.componentRef.setInput('agent', 'claude');
  fixture.componentRef.setInput('suggestion', 'Thêm export CSV');
  const settle = async () => {
    for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r)); fixture.detectChanges(); }
  };
  fixture.detectChanges();
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const button = (text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent!.trim().startsWith(text)) as HTMLButtonElement;
  return { backend, fixture, el, button, settle };
}

describe('DiffViewer (changes as git sees them)', () => {
  it('lists files with totals, the agent files picked for the commit and the user\'s own not', async () => {
    const { el, button } = await setup();
    expect(el.querySelector('.review-bar')!.textContent).toContain('2 tệp · +7 −1');
    const boxes = [...el.querySelectorAll<HTMLInputElement>('.chg-row input[type=checkbox]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false]);
    expect(el.textContent).toContain('Bạn tự sửa');
    expect(button('Commit').textContent).toContain('Commit 2 tệp');
    expect(el.querySelector('textarea')!.value).toBe('Thêm export CSV');
  });

  it('commits exactly the picked files, the user\'s own only when ticked', async () => {
    const { backend, el, button, settle } = await setup();
    const boxes = [...el.querySelectorAll<HTMLInputElement>('.chg-row input[type=checkbox]')];
    boxes[1].click(); // untick src/new.ts
    boxes[2].click(); // tick notes.md
    await settle();
    button('Commit').click();
    await settle();
    expect(backend.calls).toEqual([['commit', ['src/a.ts', 'notes.md'], 'Thêm export CSV']]);
    expect(el.textContent).toContain('Đã commit abcdef0');
    expect([...el.querySelectorAll('.chg-name')].map((n) => n.textContent)).toEqual(['new.ts']);
  });

  it('reverts one file, or all after a confirmation', async () => {
    const { backend, el, button, settle } = await setup();
    (el.querySelector('[aria-label="Hoàn tác src/a.ts"]') as HTMLButtonElement).click();
    await settle();
    expect(backend.calls).toEqual([]); // the first click only asks
    (el.querySelector('[aria-label="Xác nhận hoàn tác src/a.ts"]') as HTMLButtonElement).click();
    await settle();
    expect(backend.calls).toEqual([['revert', ['src/a.ts']]]);
    button('Hoàn tác tất cả').click();
    await settle();
    expect(backend.calls.length).toBe(1);
    button('Xác nhận hoàn tác').click();
    await settle();
    expect(backend.calls[1]).toEqual(['revert', ['src/new.ts']]);
    expect(el.querySelector('.review-bar')!.textContent).toContain('không còn thay đổi');
  });

  it('locks commit and revert while the agent is editing', async () => {
    const { fixture, el, button, settle } = await setup();
    fixture.componentRef.setInput('running', true);
    await settle();
    expect(el.textContent).toContain('đang sửa');
    expect(button('Commit').disabled).toBe(true);
    expect((el.querySelector('[aria-label="Hoàn tác src/a.ts"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('applies a draft to the folder in one go, then commits what was applied', async () => {
    const { backend, el, button, settle } = await setup({ direct: false, files: [] });
    expect(el.querySelector('.chg-row input')).toBeNull();
    expect(el.querySelector('.commit-box')).toBeNull();
    button('Áp vào thư mục').click();
    await settle();
    expect(el.textContent).toContain('Đã đưa 2 tệp vào thư mục');
    button('Commit').click();
    await settle();
    expect(backend.calls).toEqual([['apply'], ['commit', ['src/a.ts', 'src/new.ts'], 'Thêm export CSV']]);
  });

  it('still commits the applied draft after the Changes tab was closed and reopened', async () => {
    const { backend, fixture, button, settle } = await setup({ direct: false, files: [] });
    button('Áp vào thư mục').click();
    await settle();
    fixture.destroy();
    const again = TestBed.createComponent(DiffViewer);
    again.componentRef.setInput('runId', 'r1');
    again.componentRef.setInput('agent', 'claude');
    again.componentRef.setInput('suggestion', 'Thêm export CSV');
    for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r)); again.detectChanges(); }
    const el = again.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Đã đưa 2 tệp vào thư mục');
    ([...el.querySelectorAll('button')].find((b) => b.textContent!.trim().startsWith('Commit')) as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r)); again.detectChanges(); }
    expect(backend.calls.at(-1)).toEqual(['commit', ['src/a.ts', 'src/new.ts'], 'Thêm export CSV']);
  });

  it('commits every file applied from a draft, over several applies', async () => {
    const { backend, fixture, button, settle } = await setup({ direct: false, files: [] });
    backend.files = [file('a.ts')];
    fixture.componentRef.setInput('running', true);
    await settle();
    fixture.componentRef.setInput('running', false);
    await settle();
    button('Áp vào thư mục').click();
    await settle();
    // The session goes on and the agent changes another file; the tab reloads when it is done.
    backend.files = [file('b.ts')];
    fixture.componentRef.setInput('running', true);
    await settle();
    fixture.componentRef.setInput('running', false);
    await settle();
    button('Áp vào thư mục')?.click();
    await settle();
    button('Commit').click();
    await settle();
    expect(backend.calls.at(-1)).toEqual(['commit', ['a.ts', 'b.ts'], 'Thêm export CSV']);
  });

  describe('sync with the remote', () => {
    const pushes = (calls: unknown[][]) => calls.filter((c) => c[0] !== 'sync');

    it('shows the branch and the commits not pushed yet', async () => {
      const { el, backend } = await setup();
      expect(backend.syncRoots[0]).toBe('/repo');
      expect(el.querySelector('.sc-sync')!.textContent).toContain('feat');
      expect(el.querySelector('.sc-sync')!.textContent).toContain('↑2');
    });

    it('pushes the project folder and shows the new status', async () => {
      const { el, backend, button, settle } = await setup();
      button('Push').click();
      await settle();
      expect(pushes(backend.calls)).toEqual([['push', '/repo']]);
      expect(el.querySelector('.sc-sync')!.textContent).toContain('↑0');
      expect(button('Push').disabled).toBe(true);
    });

    it('hides push without a remote or on a detached head', async () => {
      const { el, button } = await setup(undefined, { remote: null, upstream: null, github: false });
      expect(button('Push')).toBeUndefined();
      expect(el.querySelector('.sc-sync')!.textContent).toContain('chưa có remote');
    });

    it('offers a PR only off the default branch with gh on GitHub', async () => {
      expect((await setup()).button('Tạo PR')).toBeDefined();
      TestBed.resetTestingModule();
      expect((await setup(undefined, { branch: 'main' })).button('Tạo PR')).toBeUndefined();
      TestBed.resetTestingModule();
      expect((await setup(undefined, { gh: false })).button('Tạo PR')).toBeUndefined();
    });

    it('creates the PR from the form and opens its link', async () => {
      const { el, backend, button, settle } = await setup();
      button('Tạo PR').click();
      await settle();
      const title = el.querySelector<HTMLInputElement>('.sc-pr input')!;
      expect(title.value).toBe('Thêm export CSV');
      title.value = 'Xuất CSV';
      title.dispatchEvent(new Event('input'));
      el.querySelector<HTMLTextAreaElement>('.sc-pr textarea')!.value = 'Chi tiết';
      el.querySelector<HTMLTextAreaElement>('.sc-pr textarea')!.dispatchEvent(new Event('input'));
      await settle();
      ([...el.querySelectorAll<HTMLButtonElement>('.sc-pr button')].find((b) => b.textContent!.includes('Tạo PR')))!.click();
      await settle();
      expect(pushes(backend.calls)).toEqual([['pr', '/repo', 'Xuất CSV', 'Chi tiết'], ['open', 'https://github.com/o/r/pull/7']]);
      expect(el.querySelector('.sc-sync')!.textContent).toContain('PR');
    });

    it('shows the existing PR link instead of the button', async () => {
      const { backend, button, settle } = await setup(undefined, { prUrl: 'https://github.com/o/r/pull/3' });
      expect(button('Tạo PR')).toBeUndefined();
      button('Mở PR').click();
      await settle();
      expect(pushes(backend.calls)).toEqual([['open', 'https://github.com/o/r/pull/3']]);
    });

    it('disables push while the agent runs', async () => {
      const { fixture, button, settle } = await setup();
      fixture.componentRef.setInput('running', true);
      await settle();
      expect(button('Push').disabled).toBe(true);
    });
  });
});
