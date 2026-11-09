import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../core/backend';
import { MockBackend } from '../core/mock-backend';
import { Project } from '../core/protocol';
import { WorkspaceService } from './workspace.service';

const KEY = 'tg.repo';
const ready = (root: string): Project => ({ root, name: root.split('/').pop()!, branch: 'main', git: 'ready', adjusted: null, uncommitted: 0, gitUser: true });

class FakeBackend extends MockBackend {
  open: (path: string) => Promise<Project> = async (path) => ready(path);
  picked: string | null = null;
  override openProject(path: string) {
    return this.open(path);
  }
  override async pickFolder() {
    return this.picked;
  }
  list: (root: string) => Promise<string[]> = async () => [];
  override listProjectFiles(root: string) {
    return this.list(root);
  }
}

async function setup(saved: string | null, configure: (b: FakeBackend) => void = () => {}) {
  if (saved === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, saved);
  const backend = new FakeBackend();
  configure(backend);
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  const service = TestBed.inject(WorkspaceService);
  await service.ready;
  return { backend, service };
}

describe('WorkspaceService folders', () => {
  afterEach(() => localStorage.removeItem(KEY));

  it('starts with no folder when nothing was saved', async () => {
    const { service } = await setup(null);
    expect(service.folder()).toBe('');
    expect(service.folderError()).toBeNull();
  });

  it('forgets a saved folder that no longer exists, without showing an error', async () => {
    const { service } = await setup('/gone', (b) => (b.open = async () => { throw new Error('Thư mục không tồn tại: /gone'); }));
    expect(service.folder()).toBe('');
    expect(service.folderError()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('keeps the current project and the saved value when a new path fails', async () => {
    const { backend, service } = await setup('/good');
    backend.open = async () => { throw new Error('Thư mục không tồn tại: /missing'); };
    expect(await service.setFolder('/missing')).toBe(false);
    expect(service.folderError()).toContain('không tồn tại');
    expect(service.folder()).toBe('/good');
    expect(service.repo()?.root).toBe('/good');
    expect(localStorage.getItem(KEY)).toBe('/good');
  });

  it('clears the error after a later success', async () => {
    const { backend, service } = await setup(null);
    backend.open = async () => { throw new Error('lỗi'); };
    await service.setFolder('/bad');
    backend.open = async (p) => ready(p);
    expect(await service.setFolder('/ok')).toBe(true);
    expect(service.folderError()).toBeNull();
  });

  it('saves the root the core resolved, not what was typed', async () => {
    const { backend, service } = await setup(null);
    backend.open = async () => ({ ...ready('/repo'), adjusted: 'subfolder' });
    await service.setFolder('  ~/repo/src  ');
    expect(service.folder()).toBe('/repo');
    expect(localStorage.getItem(KEY)).toBe('/repo');
  });

  it('has no repo for a plain folder, and a repo for one without commits', async () => {
    const { backend, service } = await setup(null);
    backend.open = async (root) => ({ ...ready(root), branch: null, git: 'none' });
    await service.setFolder('/plain');
    expect(service.folder()).toBe('/plain');
    expect(service.repo()).toBeNull();
    backend.open = async (root) => ({ ...ready(root), git: 'no_commits' });
    await service.setFolder('/empty');
    expect(service.repo()?.root).toBe('/empty');
    expect(service.project()?.git).toBe('no_commits');
  });

  it('lets the later of two overlapping opens win', async () => {
    const { backend, service } = await setup(null);
    let finishFirst!: (p: Project) => void;
    backend.open = (path) => (path === '/first' ? new Promise((r) => (finishFirst = r)) : Promise.resolve(ready(path)));
    const first = service.setFolder('/first');
    await service.setFolder('/second');
    finishFirst(ready('/first'));
    await first;
    expect(service.folder()).toBe('/second');
  });

  it('changes nothing when the folder dialog is cancelled', async () => {
    const { backend, service } = await setup('/good');
    backend.picked = null;
    await service.pickFolder();
    expect(service.folder()).toBe('/good');
    expect(service.folderError()).toBeNull();
  });

  it('opens the folder picked in the dialog', async () => {
    const { backend, service } = await setup(null);
    backend.picked = '/picked';
    await service.pickFolder();
    expect(service.folder()).toBe('/picked');
  });
});

describe('WorkspaceService source files', () => {
  afterEach(() => localStorage.removeItem(KEY));

  it('lists the files of the opened project', async () => {
    const { backend, service } = await setup(null);
    backend.list = async (root) => [`${root.slice(1)}.ts`];
    await service.setFolder('/demo');
    await service.filesLoaded;
    expect(service.projectFiles()).toEqual(['demo.ts']);
    expect(service.projectFilesError()).toBeNull();
  });

  it('shows why the list failed and keeps the project open', async () => {
    const { backend, service } = await setup(null);
    backend.list = async () => { throw new Error('không đọc được'); };
    await service.setFolder('/demo');
    await service.filesLoaded;
    expect(service.folder()).toBe('/demo');
    expect(service.projectFiles()).toEqual([]);
    expect(service.projectFilesError()).toContain('không đọc được');
  });

  it('ignores the list of a project that is no longer open', async () => {
    const { backend, service } = await setup(null);
    let finish!: (files: string[]) => void;
    backend.list = (root) => (root === '/old' ? new Promise((r) => (finish = r)) : Promise.resolve(['new.ts']));
    await service.setFolder('/old');
    const stale = service.filesLoaded;
    await service.setFolder('/new');
    await service.filesLoaded;
    finish(['old.ts']);
    await stale;
    expect(service.projectFiles()).toEqual(['new.ts']);
  });

  it('opens a source tab once and activates it', async () => {
    const { service } = await setup('/demo');
    service.openSource('src/a.ts');
    service.openSource('src/a.ts');
    expect(service.tabs()).toEqual([{ kind: 'source', root: '/demo', path: 'src/a.ts' }]);
    expect(service.active()).toEqual({ kind: 'source', root: '/demo', path: 'src/a.ts' });
  });
});

describe('MockBackend.openProject', () => {
  const backend = new MockBackend();
  it('imitates each state, so the UI can be tried in a browser', async () => {
    await expect(backend.openProject('/x/missing')).rejects.toThrow('không tồn tại');
    expect((await backend.openProject('/x/nogit')).git).toBe('none');
    expect((await backend.openProject('/x/nocommit')).git).toBe('no_commits');
    expect((await backend.openProject('/x/demo')).git).toBe('ready');
  });
});

describe('WorkspaceService preview tabs', () => {
  afterEach(() => localStorage.removeItem(KEY));

  it('replaces the preview tab with the next preview and keeps pinned tabs', async () => {
    const { service } = await setup('/repo');
    const keys = () => service.tabs().map((t) => (t.kind === 'source' ? t.path : t.kind));
    service.openSource('a.ts', true);
    service.openSource('b.ts', true);
    expect(keys()).toEqual(['b.ts']);
    expect(service.previewKey()).toBe('source:/repo:b.ts');

    service.openSource('b.ts');
    expect(service.previewKey()).toBeNull();
    service.openSource('c.ts', true);
    service.openSource('d.ts', true);
    expect(keys()).toEqual(['b.ts', 'd.ts']);
    expect(service.activeKey()).toBe('source:/repo:d.ts');
  });

  it('activates an open tab instead of previewing it again', async () => {
    const { service } = await setup('/repo');
    service.openSource('a.ts');
    service.openSource('b.ts', true);
    service.openSource('a.ts', true);
    expect(service.tabs()).toHaveLength(2);
    expect(service.activeKey()).toBe('source:/repo:a.ts');
    expect(service.previewKey()).toBe('source:/repo:b.ts');
  });

  it('forgets the preview when it is closed or pinned', async () => {
    const { service } = await setup('/repo');
    service.openSource('a.ts');
    service.openSource('b.ts', true);
    service.pin('source:/repo:b.ts');
    service.openSource('c.ts', true);
    expect(service.tabs()).toHaveLength(3);
    service.close('source:/repo:c.ts');
    expect(service.previewKey()).toBeNull();
  });
});

describe('WorkspaceService refresh', () => {
  it('keeps the last good files and changes when a reload fails, and says why', async () => {
    const { backend, service } = await setup(null);
    const diff = { path: 'a.ts', status: 'M', binary: false, patchHeader: '', hunks: [] };
    backend.listFiles = async () => ['a.ts'];
    backend.getDiff = async () => [diff];
    await service.refresh('r');
    backend.getDiff = () => Promise.reject(new Error('Lệnh Git thất bại: index.lock'));
    await service.refresh('r');
    expect(service.files()['r']).toEqual(['a.ts']);
    expect(service.diffs()['r']).toEqual([diff]);
    expect(service.refreshErrors()['r']).toContain('index.lock');
    backend.getDiff = async () => [];
    await service.refresh('r');
    expect(service.refreshErrors()['r']).toBeUndefined();
  });
});
