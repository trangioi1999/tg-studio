import { TestBed } from '@angular/core/testing';
import { AgentBackend, SettingKey } from './backend';
import { AgentsService } from './agents.service';
import { MockBackend } from './mock-backend';
import { DetectedAgent } from './protocol';

const agent = (over: Partial<DetectedAgent> = {}): DetectedAgent => ({ id: 'claude', name: 'Claude Code', binary: 'claude', path: '/bin/claude', version: '1', headless: true, auth: 'ok', ...over });

class FakeBackend extends MockBackend {
  stored: string | null = null;
  finish!: (agents: DetectedAgent[]) => void;
  override detectAgents() {
    return new Promise<DetectedAgent[]>((resolve) => (this.finish = resolve));
  }
  override async getSetting(_key: SettingKey) {
    return this.stored;
  }
  override async setSetting(_key: SettingKey, value: string) {
    this.stored = value;
  }
}

function setup(stored: string | null) {
  const backend = new FakeBackend();
  backend.stored = stored;
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  return { backend, service: TestBed.inject(AgentsService) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('AgentsService', () => {
  it('shows the last result at once while it checks again', async () => {
    const { backend, service } = setup(JSON.stringify([agent({ version: 'cũ' })]));
    const done = service.refresh();
    await flush();
    expect(service.agents()[0].version).toBe('cũ');
    expect(service.loading()).toBe(false);
    expect(service.checking()).toBe(true);
    backend.finish([agent({ version: 'mới' })]);
    await done;
    expect(service.agents()[0].version).toBe('mới');
    expect(service.checking()).toBe(false);
    expect(JSON.parse(backend.stored!)[0].version).toBe('mới');
  });

  it('shows loading only when there is nothing to show', async () => {
    const { backend, service } = setup(null);
    const done = service.refresh();
    await flush();
    expect(service.loading()).toBe(true);
    backend.finish([agent()]);
    await done;
    expect(service.loading()).toBe(false);
  });

  it('ignores a broken cache', async () => {
    const { backend, service } = setup('{not json');
    const done = service.refresh();
    await flush();
    expect(service.agents()).toEqual([]);
    backend.finish([]);
    await done;
  });

  it('reads an old cache without login state', async () => {
    const { id, name, binary, path, version, headless } = agent();
    const { backend, service } = setup(JSON.stringify([{ id, name, binary, path, version, headless }]));
    const done = service.refresh();
    await flush();
    expect(service.agents()[0].auth).toBe('unknown');
    backend.finish([]);
    await done;
  });

  it('does not run two detections at once', async () => {
    const { backend, service } = setup(null);
    let calls = 0;
    const detect = backend.detectAgents.bind(backend);
    backend.detectAgents = () => { calls += 1; return detect(); };
    const first = service.refresh();
    await service.refresh();
    await flush();
    expect(calls).toBe(1);
    backend.finish([]);
    await first;
  });
});
