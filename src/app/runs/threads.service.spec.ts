import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../core/backend';
import { MockBackend } from '../core/mock-backend';
import { RunsService } from './runs.service';
import { Run } from './run';
import { ThreadsService, buildThreads, groupByProject } from './threads.service';
import { WorkspaceService } from '../workspace/workspace.service';

const run = (over: Partial<Run>): Run => ({
  id: 'r', agent: 'claude', prompt: 'p', cwd: '/a', startedAt: 1, endedAt: 2, status: 'done', lines: [], usage: null, exitCode: 0, restored: false,
  task: true, permissions: [], lastMessage: '', group: null, thread: 't', project: '/a', scope: null, waits: [], plan: [], progress: null, ...over,
});

describe('buildThreads', () => {
  it('joins the runs of a conversation, titled by its first and continued by its newest', () => {
    const [t] = buildThreads([run({ id: 'b', agent: 'codex', prompt: 'sau', startedAt: 5, endedAt: 9 }), run({ id: 'a', prompt: 'đầu' })]);
    expect(t).toMatchObject({ id: 't', title: 'đầu', agents: ['claude', 'codex'], updatedAt: 9 });
    expect(t.latest.id).toBe('b');
  });

  it('puts what needs the user first, then what runs, then the newest', () => {
    const list = buildThreads([
      run({ id: '1', thread: 'cu', endedAt: 1 }),
      run({ id: '2', thread: 'moi', endedAt: 50 }),
      run({ id: '3', thread: 'chay', status: 'running' }),
      run({ id: '4', thread: 'duyet', status: 'running', permissions: [{}] as Run['permissions'] }),
      run({ id: '5', thread: 'cho', status: 'idle' }),
      run({ id: '6', thread: 'loi', status: 'failed' }),
    ]);
    expect(list.map((t) => t.id)).toEqual(['duyet', 'chay', 'loi', 'cho', 'moi', 'cu']);
    expect(list.map((t) => t.status)).toEqual(['needs_you', 'running', 'failed', 'waiting', 'ended', 'ended']);
  });

  it('continues with the agent the user talked to, not one it delegated to', () => {
    const [t] = buildThreads([
      run({ id: 'p', status: 'idle', startedAt: 1 }),
      run({ id: 'c', agent: 'codex', parent: 'p', status: 'running', startedAt: 5 }),
      run({ id: 'p~1', parent: 'p', status: 'done', startedAt: 6, prompt: 'Tìm cấu hình' }),
    ]);
    expect(t.latest.id).toBe('p');
    expect(t.agents).toEqual(['claude']);
    expect(t.status).toBe('running'); // a child still working keeps the conversation busy
    expect(t.title).toBe('p');
  });

  it('cuts a long title', () => {
    expect(buildThreads([run({ prompt: 'x'.repeat(200) })])[0].title.length).toBe(80);
  });
});

describe('groupByProject', () => {
  it('lists the open folder first, then projects with conversations, then recent ones', () => {
    const threads = buildThreads([run({ thread: 'a', project: '/du-an/api' }), run({ id: 'x', thread: 'b', project: '/du-an/web' })]);
    const groups = groupByProject(threads, '/du-an/web', ['/cu', '/du-an/api']);
    expect(groups.map((g) => g.root)).toEqual(['/du-an/web', '/du-an/api', '/cu']);
    expect(groups.map((g) => g.name)).toEqual(['web', 'api', 'cu']);
    expect(groups[2].threads).toEqual([]);
  });

  it('adds a subfolder level only where a conversation uses one', () => {
    const threads = buildThreads([
      run({ id: '1', thread: 'ca-du-an', project: '/repo' }),
      run({ id: '2', thread: 'api', project: '/repo', scope: 'goi/api' }),
      run({ id: '3', thread: 'nho', project: '/nho' }),
    ]);
    const [repo, small] = groupByProject(threads, '/repo', []);
    expect(repo.threads.map((t) => t.id)).toEqual(['ca-du-an']);
    expect(repo.scopes).toEqual([{ scope: 'goi/api', threads: [expect.objectContaining({ id: 'api' })] }]);
    expect(small.scopes).toEqual([]);
  });

  it('handles Windows paths', () => {
    expect(groupByProject([], String.raw`C:\du an\web`, [])[0].name).toBe('web');
  });
});

describe('ThreadsService', () => {
  beforeEach(() => {
    localStorage.removeItem('tg.recent');
    localStorage.removeItem('tg.repo');
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useClass: MockBackend }] });
  });

  it('opens the project of the selected conversation', async () => {
    const threads = TestBed.inject(ThreadsService);
    const workspace = TestBed.inject(WorkspaceService);
    await workspace.setFolder('/mot');
    await threads.select(buildThreads([run({ id: 'r9', project: '/hai' })])[0]);
    expect(workspace.folder()).toBe('/hai');
    expect(TestBed.inject(RunsService).selectedId()).toBe('r9');
  });

  it('remembers opened folders, newest first, and can forget one', async () => {
    const threads = TestBed.inject(ThreadsService);
    const workspace = TestBed.inject(WorkspaceService);
    await workspace.setFolder('/mot');
    TestBed.tick();
    await workspace.setFolder('/hai');
    TestBed.tick();
    expect(threads.recent()).toEqual(['/hai', '/mot']);
    threads.forget('/mot');
    expect(JSON.parse(localStorage.getItem('tg.recent')!)).toEqual(['/hai']);
  });

  it('deletes every run of a conversation and ignores the late exit of its session', async () => {
    const backend = TestBed.inject(AgentBackend);
    const deleted: string[][] = [];
    backend.deleteRuns = async (ids: string[]) => { deleted.push(ids); };
    let emit!: (e: never) => void;
    backend.onEvent = async (cb: (e: never) => void) => { emit = cb; return () => {}; };
    const runs = TestBed.inject(RunsService);
    runs.runs.set([run({ id: 'a', thread: 't1' }), run({ id: 'b', thread: 't1' }), run({ id: 'c', thread: 't2' })]);
    runs.selectedId.set('b');
    await TestBed.inject(ThreadsService).remove('t1');
    expect(deleted).toEqual([['a', 'b']]);
    expect(runs.runs().map((r) => r.id)).toEqual(['c']);
    expect(runs.selectedId()).toBeNull();
    emit({ runId: 'a', agent: 'claude', kind: 'exit', line: null, usage: null, code: null, data: null, atMs: 9 } as never);
    expect(runs.runs().map((r) => r.id)).toEqual(['c']);
  });

  it('keeps a conversation when its agent is still busy', async () => {
    const backend = TestBed.inject(AgentBackend);
    backend.deleteRuns = async () => { throw new Error('Hãy dừng agent trước khi xoá cuộc trò chuyện.'); };
    const runs = TestBed.inject(RunsService);
    runs.runs.set([run({ id: 'a', thread: 't1' })]);
    await expect(TestBed.inject(ThreadsService).remove('t1')).rejects.toThrow('Hãy dừng agent');
    expect(runs.runs().map((r) => r.id)).toEqual(['a']);
  });

  it('remembers the subfolder of a new chat', async () => {
    const threads = TestBed.inject(ThreadsService);
    await threads.newChat('/ba', 'goi/api');
    expect(threads.draftScope()).toBe('goi/api');
    await threads.newChat('/ba');
    expect(threads.draftScope()).toBeNull();
  });

  it('starts a new chat in a given project with nothing selected', async () => {
    const threads = TestBed.inject(ThreadsService);
    TestBed.inject(RunsService).selectedId.set('x');
    await threads.newChat('/ba');
    expect(TestBed.inject(RunsService).selectedId()).toBeNull();
    expect(TestBed.inject(WorkspaceService).folder()).toBe('/ba');
  });
});
