import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AgentBackend, SettingKey } from '../core/backend';
import { AgentsService } from './agents.service';
import { MockBackend } from '../core/mock-backend';
import { DetectedAgent } from '../core/protocol';

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

describe('AgentsService model picks', () => {
  let service: AgentsService;
  let backend: MockBackend;

  beforeEach(() => {
    localStorage.removeItem('tg.prefs');
    backend = new MockBackend();
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
    service = TestBed.inject(AgentsService);
  });

  it('asks each agent once and names the picked model', async () => {
    const spy = vi.spyOn(backend, 'agentOptions');
    await service.loadOptions('claude', '/repo');
    await service.loadOptions('claude', '/repo');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(service.prefsFor('claude')).toBeNull();
    expect(service.modelLabel('claude')).toBeNull();
    service.setPref('claude', { model: 'claude-opus-4-6' });
    expect(service.prefsFor('claude')).toEqual({ model: 'claude-opus-4-6', effort: null });
    expect(service.modelLabel('claude')).toBe('Opus 4.6');
    expect(JSON.parse(localStorage.getItem('tg.prefs')!)).toEqual({ claude: { model: 'claude-opus-4-6', effort: null } });
  });

  it('can retry after the agent did not answer', async () => {
    const spy = vi.spyOn(backend, 'agentOptions').mockRejectedValueOnce(new Error('timeout'));
    await service.loadOptions('codex', null);
    expect(service.options()['codex']).toBe('error');
    await service.loadOptions('codex', null);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(typeof service.options()['codex']).toBe('object');
  });
});
