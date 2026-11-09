import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { RunsService } from '../runs/runs.service';
import { AgentBackend } from '../core/backend';
import { AgentsService } from '../agents/agents.service';
import { MockBackend } from '../core/mock-backend';
import { AgentId } from '../core/protocol';
import { WorkspaceService } from '../workspace/workspace.service';
import { AgentPanel } from './agent-panel';
import { ChatState } from './chat.state';

class FakeBackend extends MockBackend {
  starts = 0;
  lastStart: { agent: AgentId; prompt: string; reuse: string | null; recap: string | null; thread?: string | null; place?: string | null; base?: string | null; approval?: string | null } | null = null;
  startResult: (() => Promise<string>) | null = null;
  warms: [AgentId, string, string | null][] = [];
  override warmTask(agent: AgentId, repo: string, scope: string | null) {
    this.warms.push([agent, repo, scope]);
    return Promise.resolve();
  }
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
  pending(): { text: string } | null;
}

async function setup() {
  localStorage.removeItem('tg.pipeline');
  const backend = new FakeBackend();
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  await TestBed.inject(AgentsService).refresh();
  await TestBed.inject(WorkspaceService).setFolder('/demo');
  // The composer's state lives in ChatState, provided by the panel.
  const panel = TestBed.createComponent(AgentPanel).debugElement.injector.get(ChatState) as unknown as Composer;
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

  it('opens the session while the first message is typed, once per agent and folder', async () => {
    const { backend, panel } = await setup();
    const folder = TestBed.inject(WorkspaceService).folder();
    panel.prompt.set('s');
    TestBed.tick();
    panel.prompt.set('sửa lỗi');
    TestBed.tick();
    expect(backend.warms).toEqual([['claude', folder, null]]);
    panel.prompt.set('@codex sửa lỗi');
    TestBed.tick();
    expect(backend.warms.at(-1)).toEqual(['codex', folder, null]);
  });

  it('does not open a session ahead for a draft, a question or an open conversation', async () => {
    const { backend, panel } = await setup();
    (panel as unknown as { setPlace(p: string): void }).setPlace('draft');
    panel.prompt.set('sửa');
    TestBed.tick();
    (panel as unknown as { setPlace(p: string): void }).setPlace('direct');
    panel.mode.set('read');
    TestBed.tick();
    expect(backend.warms).toEqual([]);
  });

  it('does not open a session ahead when the conversation has one', async () => {
    const { backend, panel } = await withOpenSession();
    backend.warms = [];
    panel.prompt.set('câu hai');
    TestBed.tick();
    expect(backend.warms).toEqual([]);
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
    // Claude's Chỉ hỏi process stays open (idle); a code task still starts its own session.
    await vi.waitFor(() => expect(runs.selected()?.status).toBe('idle'), { timeout: 4000 });
    p.setPerm('ask');
    p.prompt.set('giờ sửa đi');
    await p.send();
    expect(backend.lastStart?.thread).toBe(question.thread);
    expect(backend.lastStart?.recap).toContain('giải thích dự án');
    expect(runs.selected()?.thread).toBe(question.thread);
  });

  it('keeps the agent and permission the user just picked while the run streams', async () => {
    const { panel } = await setup();
    const p = panel as unknown as Composer & { pickAgent(a: string): void; setPerm(p: string): void; chosen(): string; approval(): string };
    const runs = TestBed.inject(RunsService);
    p.prompt.set('sửa lỗi');
    await p.send();
    await vi.waitFor(() => expect(runs.selected()?.status).toBe('running'));
    TestBed.tick(); // the composer has followed the new run
    const before = runs.selected()!.lines.length;
    p.pickAgent('codex');
    p.setPerm('auto');
    await vi.waitFor(() => expect(runs.selected()!.lines.length).toBeGreaterThan(before));
    TestBed.tick();
    expect([p.chosen(), p.approval()]).toEqual(['codex', 'auto']);
  });

  it('carries out a Chỉ hỏi plan in the same conversation once the user says yes', async () => {
    const { backend, panel } = await setup();
    const p = panel as unknown as Composer & { setPerm(p: string): void; perm(): string; actOnProposal(r: unknown): Promise<void> };
    const runs = TestBed.inject(RunsService);
    p.setPerm('read');
    p.prompt.set('đổi a.txt thành xin chào');
    await p.send();
    const question = runs.selected()!;
    await vi.waitFor(() => expect(runs.selected()?.status).toBe('idle'), { timeout: 4000 });
    runs.runs.update((list) => list.map((r) => (r.id === question.id ? { ...r, proposal: '# Đổi a.txt\n- Ghi đè thành xin chào' } : r)));
    await p.actOnProposal(runs.runs().find((r) => r.id === question.id));
    expect(p.perm()).toBe('ask');
    expect(backend.lastStart?.approval).toBe('ask');
    expect(backend.lastStart?.thread).toBe(question.thread);
    expect(backend.lastStart?.prompt).toContain('Ghi đè thành xin chào');
  });

  it('continues a Codex question in its conversation, resuming the CLI session', async () => {
    const { backend, panel } = await setup();
    const calls: { thread: string | null | undefined; resumeFrom: string | null | undefined }[] = [];
    const start = backend.start.bind(backend);
    backend.start = (agent, prompt, cwd, thread, resumeFrom) => {
      calls.push({ thread, resumeFrom });
      return start(agent, prompt, cwd);
    };
    panel.mode.set('read');
    panel.prompt.set('@codex câu một');
    await panel.send();
    const runs = TestBed.inject(RunsService);
    const first = runs.selected()!;
    await vi.waitFor(() => expect(runs.selected()?.status).toBe('done'), { timeout: 4000 });
    TestBed.tick();
    panel.prompt.set('@codex câu hai');
    await panel.send();
    expect(calls[1]).toEqual({ thread: first.thread, resumeFrom: first.id });
    expect(runs.selected()!.thread).toBe(first.thread);
    TestBed.tick();
    expect(panel.threadRuns().map((r) => r.prompt)).toEqual(['câu một', 'câu hai']);
  });

  it('asks Claude the next question in its open process', async () => {
    const { backend, panel } = await setup();
    let starts = 0;
    const start = backend.start.bind(backend);
    backend.start = (...args) => { starts += 1; return start(...args); };
    panel.mode.set('read');
    panel.prompt.set('câu một');
    await panel.send();
    const runs = TestBed.inject(RunsService);
    const first = runs.selected()!;
    await vi.waitFor(() => expect(runs.selected()?.status).toBe('idle'), { timeout: 4000 });
    TestBed.tick();
    panel.prompt.set('câu hai');
    await panel.send();
    expect(starts).toBe(1);
    expect(runs.selected()!.id).toBe(first.id);
    await vi.waitFor(() => expect(runs.selected()!.lines.some((l) => l.tone === 'user' && l.text === 'câu hai')).toBe(true));
  });

  it('resumes the CLI session when the open Claude process has just closed', async () => {
    const { backend, panel } = await setup();
    const calls: (string | null | undefined)[] = [];
    const start = backend.start.bind(backend);
    backend.start = (agent, prompt, cwd, thread, resumeFrom) => { calls.push(resumeFrom); return start(agent, prompt, cwd); };
    panel.mode.set('read');
    panel.prompt.set('câu một');
    await panel.send();
    const runs = TestBed.inject(RunsService);
    const first = runs.selected()!;
    await vi.waitFor(() => expect(runs.selected()?.status).toBe('idle'), { timeout: 4000 });
    TestBed.tick();
    backend.sendMessage = () => Promise.reject(new Error('Phiên này đã đóng.'));
    panel.prompt.set('câu hai');
    await panel.send();
    expect(calls).toEqual([null, first.id]);
    expect(panel.error()).toBeNull();
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

  it('shows the message and clears the box before the agent has started', async () => {
    const { backend, panel } = await setup();
    let finish!: (id: string) => void;
    backend.startResult = () => new Promise((resolve) => (finish = resolve));
    panel.prompt.set('sửa lỗi đăng nhập');
    const sending = panel.send();
    await vi.waitFor(() => expect(backend.starts).toBe(1));
    expect(panel.prompt()).toBe('');
    expect(panel.pending()?.text).toBe('sửa lỗi đăng nhập');
    finish('run');
    await sending;
  });

  it('gives the words back when the agent cannot start', async () => {
    const { backend, panel } = await setup();
    backend.startResult = () => Promise.reject(new Error('adapter không chạy'));
    panel.prompt.set('sửa lỗi đăng nhập');
    await panel.send();
    expect(panel.error()).toContain('adapter không chạy');
    expect(panel.prompt()).toBe('sửa lỗi đăng nhập');
    expect(panel.pending()).toBeNull();
  });

  it('offers the agent skills after "/" and inserts the picked one instead of sending', async () => {
    const { backend, panel } = await setup();
    const p = panel as unknown as Composer & {
      onInput(box: { value: string; selectionStart: number }): void;
      onKeyDown(e: KeyboardEvent): void;
      cmdMenu(): { loading: boolean; groups: { group: string; items: { name: string }[] }[] } | null;
    };
    p.onInput({ value: '/rel', selectionStart: 4 });
    expect(p.cmdMenu()?.loading).toBe(true);
    await vi.waitFor(() => expect(p.cmdMenu()?.loading).toBe(false));
    expect(p.cmdMenu()?.groups.map((g) => g.group)).toEqual(['project']);
    p.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(p.prompt()).toBe('/release-notes ');
    expect(backend.starts).toBe(0);
    expect(p.cmdMenu()).toBeNull();
  });

  it('closes the skill list with Esc without sending', async () => {
    const { backend, panel } = await setup();
    const p = panel as unknown as Composer & { onInput(box: { value: string; selectionStart: number }): void; onKeyDown(e: KeyboardEvent): void; cmdMenu(): unknown };
    p.onInput({ value: '/', selectionStart: 1 });
    expect(p.cmdMenu()).not.toBeNull();
    p.onKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(p.cmdMenu()).toBeNull();
    expect(backend.starts).toBe(0);
  });

  it('keeps the skill list current from a live session', async () => {
    const { panel } = await setup();
    const agents = TestBed.inject(AgentsService);
    agents.setCommands('claude', '/demo', [{ name: 'moi', description: 'Skill vừa thêm', kind: 'skill', source: 'project', plugin: null, hint: null, insert: '/moi ' }]);
    const p = panel as unknown as Composer & { onInput(box: { value: string; selectionStart: number }): void; cmdMenu(): { groups: { items: { name: string }[] }[] } | null };
    p.onInput({ value: '/mo', selectionStart: 3 });
    expect(p.cmdMenu()?.groups.flatMap((g) => g.items.map((i) => i.name))).toEqual(['moi']);
  });
});
