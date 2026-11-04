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
  lastStart: { agent: AgentId; prompt: string; reuse: string | null; recap: string | null } | null = null;
  startResult: (() => Promise<string>) | null = null;
  override startTask(agent: AgentId, prompt: string, repo: string, group: string | null = null, reuse: string | null = null, singleTurn = false, recap: string | null = null) {
    this.starts += 1;
    this.lastStart = { agent, prompt, reuse, recap };
    return this.startResult ? this.startResult() : super.startTask(agent, prompt, repo, group, reuse, singleTurn);
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
    expect(backend.starts).toBe(1);
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
    panel.prompt.set('sửa');
    await panel.send();
    expect(backend.starts).toBe(0);
    expect(panel.dirtyWarning()).toBe(3);
    expect(panel.prompt()).toBe('sửa');
    await panel.sendAnyway();
    expect(backend.starts).toBe(1);
    expect(panel.dirtyWarning()).toBeNull();
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
