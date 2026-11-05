import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { RunsService } from '../core/runs.service';
import { AgentBackend } from '../core/backend';
import { AgentsService } from '../core/agents.service';
import { MockBackend } from '../core/mock-backend';
import { AgentId } from '../core/protocol';
import { WorkspaceService } from '../core/workspace.service';
import { AgentPanel } from './agent-panel';

class FakeBackend extends MockBackend {
  starts = 0;
  lastStart: { agent: AgentId; prompt: string; reuse: string | null; recap: string | null; thread?: string | null; place?: string | null; base?: string | null; approval?: string | null } | null = null;
  startResult: (() => Promise<string>) | null = null;
  override startTask(agent: AgentId, prompt: string, repo: string, group: string | null = null, reuse: string | null = null, singleTurn = false, recap: string | null = null,
    thread: string | null = null, scope: string | null = null, prefs: unknown = null, place: string | null = null, base: string | null = null, approval: string | null = null) {
    this.starts += 1;
    this.lastStart = { agent, prompt, reuse, recap, thread, place, base, approval };
    return this.startResult ? this.startResult() : super.startTask(agent, prompt, repo, group, reuse, singleTurn, recap, thread, scope, prefs, place, base, approval);
  }
}

/** The protected members the composer is driven through. */
interface Composer {
  mode: { set(m: string): void };
  prompt: { (): string; set(p: string): void };
  error(): string | null;
  canRun(): boolean;
  sending(): boolean;
  send(): Promise<void>;
  onEnter(e: KeyboardEvent): void;
  threadRuns(): { prompt: string }[];
  dirtyWarning(): number | null;
  sendAnyway(): Promise<void>;
  needsGit(): string | null;
  blocked(): string | null;
  gitPlan(): { ignore: string[] } | null;
  planGit(): Promise<void>;
  prepareGit(): Promise<void>;
}

async function setup() {
  localStorage.removeItem('tg.pipeline');
  const backend = new FakeBackend();
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  await TestBed.inject(AgentsService).refresh();
  await TestBed.inject(WorkspaceService).setFolder('/demo');
  const panel = TestBed.createComponent(AgentPanel).componentInstance as unknown as Composer;
  return { backend, panel };
}

describe('AgentPanel composer', () => {
  afterEach(() => localStorage.removeItem('tg.repo'));

  it('does not start twice while sending', async () => {
    const { backend, panel } = await setup();
    let finish!: (id: string) => void;
    backend.startResult = () => new Promise((resolve) => (finish = resolve));
    panel.prompt.set('sửa lỗi');
    const first = panel.send();
    expect(panel.canRun()).toBe(false);
    await panel.send();
    await vi.waitFor(() => expect(backend.starts).toBe(1));
    finish('run');
    await first;
    expect(panel.prompt()).toBe('');
    expect(panel.sending()).toBe(false);
  });

  async function withOpenSession() {
    const context = await setup();
    await TestBed.inject(RunsService).startTask('claude', 'câu đầu', '/demo');
    const run = TestBed.inject(RunsService).selected()!;
    await context.backend.respondPermission(run.id, `perm-${run.id}`, 'allow', false);
    await vi.waitFor(() => expect(TestBed.inject(RunsService).selected()?.status).toBe('idle'), { timeout: 3000 });
    TestBed.tick();
    return { ...context, run };
  }

  it('sends the next message into the open session without starting an agent', async () => {
    const { backend, panel, run } = await withOpenSession();
    backend.starts = 0;
    panel.prompt.set('câu hai');
    await panel.send();
    expect(backend.starts).toBe(0);
    await vi.waitFor(() => expect(TestBed.inject(RunsService).selected()?.lines.some((l) => l.tone === 'user' && l.text === 'câu hai')).toBe(true));
    expect(TestBed.inject(RunsService).selected()?.id).toBe(run.id);
  });

  it('starts a new session in the same draft when handing over to another agent', async () => {
    const { backend, panel, run } = await withOpenSession();
    backend.starts = 0;
    panel.prompt.set('@codex làm tiếp');
    await panel.send();
    expect(backend.starts).toBe(1);
    expect(backend.lastStart).toMatchObject({ agent: 'codex', prompt: 'làm tiếp', reuse: run.id });
    expect(backend.lastStart?.recap).toContain('câu đầu');
  });

  it('does not send on Enter while an input method is composing, or on Shift+Enter', async () => {
    const { backend, panel } = await setup();
    panel.prompt.set('xin chào');
    panel.onEnter(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    panel.onEnter(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    expect(backend.starts).toBe(0);
    panel.onEnter(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => expect(backend.starts).toBe(1));
  });

  it('warns once about uncommitted files before a new draft, then goes on', async () => {
    const { backend, panel } = await setup();
    await TestBed.inject(WorkspaceService).setFolder('/x/dirty');
    (panel as unknown as { setPlace(p: string): void }).setPlace('draft');
    panel.prompt.set('sửa');
    await panel.send();
    expect(backend.starts).toBe(0);
    expect(panel.dirtyWarning()).toBe(3);
    expect(panel.prompt()).toBe('sửa');
    await panel.sendAnyway();
    expect(backend.starts).toBe(1);
    expect(panel.dirtyWarning()).toBeNull();
  });

  it('does not warn about uncommitted files when the agent works in the folder itself', async () => {
    const { backend, panel } = await setup();
    await TestBed.inject(WorkspaceService).setFolder('/x/dirty');
    panel.prompt.set('sửa');
    await panel.send();
    expect(panel.dirtyWarning()).toBeNull();
    expect(backend.lastStart?.place).toBe('direct');
  });

  it('makes a plain folder ready for code tasks after showing the plan', async () => {
    const { panel } = await setup();
    const workspace = TestBed.inject(WorkspaceService);
    await workspace.setFolder('/x/nogit');
    expect(panel.needsGit()).toBe('Khởi tạo Git…');
    expect(panel.blocked()).toContain('Khởi tạo Git');
    await panel.planGit();
    expect(panel.gitPlan()?.ignore).toContain('.env');
    expect(workspace.project()?.git).toBe('none');
    await panel.prepareGit();
    expect(workspace.project()?.git).toBe('ready');
    expect(panel.needsGit()).toBeNull();
    expect(panel.gitPlan()).toBeNull();
  });

  it('shows why Git could not be prepared', async () => {
    const { panel } = await setup();
    await TestBed.inject(WorkspaceService).setFolder('/x/nogit-noname');
    await panel.planGit();
    await panel.prepareGit();
    expect(panel.error()).toContain('tên và email');
    expect(panel.gitPlan()).not.toBeNull();
  });

  it('lets every agent take every permission; a question to Kiro runs in a throwaway draft', async () => {
    const { backend, panel } = await setup();
    const p = panel as unknown as Composer & { mode(): string; agent(): string; pickAgent(id: string): void; setPerm(p: string): void; readViaAcp(): boolean };
    p.setPerm('read');
    p.pickAgent('kiro');
    expect(p.mode()).toBe('read');
    expect(p.agent()).toBe('kiro');
    expect(p.readViaAcp()).toBe(true);
    p.prompt.set('dự án dùng gì?');
    await p.send();
    expect(backend.lastStart).toMatchObject({ agent: 'kiro', approval: 'deny', reuse: null });
    expect(TestBed.inject(RunsService).selected()?.perm).toBe('read');
  });

  it('starts code tasks in the current folder by default, or in a draft from the chosen branch', async () => {
    const { backend, panel } = await setup();
    const p = panel as unknown as Composer & { setPerm(p: string): void; setPlace(place: string, base?: string | null): void; sendAnyway(): Promise<void> };
    p.setPerm('auto');
    p.prompt.set('sửa tiêu đề');
    await p.send();
    expect(backend.lastStart).toMatchObject({ approval: 'auto', place: 'direct', base: null });
    TestBed.inject(RunsService).selectedId.set(null);
    p.setPlace('draft', 'develop');
    p.prompt.set('sửa footer');
    await p.send();
    if (p.dirtyWarning()) await p.sendAnyway();
    expect(backend.lastStart).toMatchObject({ approval: 'auto', place: 'draft', base: 'develop' });
  });

  it('keeps the conversation when the permission changes mid-way', async () => {
    const { backend, panel } = await setup();
    const p = panel as unknown as Composer & { setPerm(p: string): void };
    const runs = TestBed.inject(RunsService);
    p.setPerm('read');
    p.prompt.set('giải thích dự án');
    await p.send();
    const question = runs.selected()!;
    await vi.waitFor(() => expect(runs.selected()?.status).toBe('done'), { timeout: 4000 });
    p.setPerm('ask');
    p.prompt.set('giờ sửa đi');
    await p.send();
    expect(backend.lastStart?.thread).toBe(question.thread);
    expect(backend.lastStart?.recap).toContain('giải thích dự án');
    expect(runs.selected()?.thread).toBe(question.thread);
  });

  it('continues a question in its conversation, resuming the CLI session', async () => {
    const { backend, panel } = await setup();
    const calls: { thread: string | null | undefined; resumeFrom: string | null | undefined }[] = [];
    const start = backend.start.bind(backend);
    backend.start = (agent, prompt, cwd, thread, resumeFrom) => {
      calls.push({ thread, resumeFrom });
      return start(agent, prompt, cwd);
    };
    panel.mode.set('read');
    panel.prompt.set('câu một');
    await panel.send();
    const runs = TestBed.inject(RunsService);
    const first = runs.selected()!;
    await vi.waitFor(() => expect(runs.selected()?.status).toBe('done'), { timeout: 4000 });
    TestBed.tick();
    panel.prompt.set('câu hai');
    await panel.send();
    expect(calls[1]).toEqual({ thread: first.thread, resumeFrom: first.id });
    expect(runs.selected()!.thread).toBe(first.thread);
    TestBed.tick();
    expect(panel.threadRuns().map((r) => r.prompt)).toEqual(['câu một', 'câu hai']);
  });

  it('keeps the prompt and shows why when a pipeline cannot start', async () => {
    const { backend, panel } = await setup();
    backend.startResult = () => Promise.reject(new Error('không tạo được worktree'));
    panel.mode.set('pipeline');
    panel.prompt.set('việc lớn');
    await panel.send();
    expect(panel.error()).toContain('không tạo được worktree');
    expect(panel.prompt()).toBe('việc lớn');
  });
});
