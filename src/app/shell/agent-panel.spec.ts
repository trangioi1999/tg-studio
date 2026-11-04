import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../core/backend';
import { AgentsService } from '../core/agents.service';
import { MockBackend } from '../core/mock-backend';
import { AgentId } from '../core/protocol';
import { WorkspaceService } from '../core/workspace.service';
import { AgentPanel } from './agent-panel';

class FakeBackend extends MockBackend {
  starts = 0;
  startResult: () => Promise<string> = () => Promise.resolve('run');
  override startTask(_agent: AgentId, _prompt: string, _repo: string) {
    this.starts += 1;
    return this.startResult();
  }
}

/** The protected members the composer is driven through. */
interface Composer {
  mode: { set(m: string): void };
  prompt: { (): string; set(p: string): void };
  error(): string | null;
  canRun(): boolean;
  send(): Promise<void>;
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
    panel.prompt.set('việc khác');
    expect(panel.canRun()).toBe(true);
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
