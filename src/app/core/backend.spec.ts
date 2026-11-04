import { vi } from 'vitest';
import { TauriBackend } from './backend';
import { MockBackend } from './mock-backend';
import { AgentEvent } from './protocol';

// The real `invoke` forwards to this bridge. Faking the bridge, not the module, keeps the
// test independent of how the test builder bundles shared modules.
const bridge = { invoke: vi.fn() };
const lastCall = () => bridge.invoke.mock.lastCall?.slice(0, 2);

describe('Tauri task commands', () => {
  afterAll(() => delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

  it('forwards task arguments using the native camelCase contract', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = bridge;
    bridge.invoke.mockResolvedValue('result');
    const backend = new TauriBackend();
    expect(await backend.startTask('codex', 'change', '/repo')).toBe('result');
    expect(lastCall()).toEqual(['start_task', { agent: 'codex', prompt: 'change', repo: '/repo', group: null, reuse: null, singleTurn: false, recap: null }]);
    await backend.startTask('claude', 'change', '/repo', 'g-1');
    expect(lastCall()).toEqual(['start_task', { agent: 'claude', prompt: 'change', repo: '/repo', group: 'g-1', reuse: null, singleTurn: false, recap: null }]);
    await backend.startTask('gemini', 'review', '/repo', null, 'run-1');
    expect(lastCall()).toEqual(['start_task', { agent: 'gemini', prompt: 'review', repo: '/repo', group: null, reuse: 'run-1', singleTurn: false, recap: null }]);
    await backend.respondPermission('run', 'request', 'allow', true);
    expect(lastCall()).toEqual(['respond_permission', { runId: 'run', requestId: 'request', optionId: 'allow', always: true }]);
    await backend.getDiff('run');
    expect(lastCall()).toEqual(['get_diff', { runId: 'run' }]);
    await backend.acceptHunk('run', 'file', 'hunk');
    expect(lastCall()).toEqual(['accept_hunk', { runId: 'run', path: 'file', hunkId: 'hunk' }]);
    await backend.acceptAll('run');
    expect(lastCall()).toEqual(['accept_all', { runId: 'run' }]);
    await backend.listFiles('run');
    expect(lastCall()).toEqual(['list_worktree_files', { runId: 'run' }]);
    await backend.readFile('run', 'a b.ts');
    expect(lastCall()).toEqual(['read_worktree_file', { runId: 'run', path: 'a b.ts' }]);
    await backend.writeFile('run', 'a b.ts', 'x');
    expect(lastCall()).toEqual(['write_worktree_file', { runId: 'run', path: 'a b.ts', content: 'x' }]);
    await backend.rejectHunk('run', 'file', 'hunk');
    expect(lastCall()).toEqual(['reject_hunk', { runId: 'run', path: 'file', hunkId: 'hunk' }]);
    expect(await backend.commitAccepted('run', 'commit')).toBe('result');
    expect(lastCall()).toEqual(['commit_accepted', { runId: 'run', message: 'commit' }]);
    await backend.bridgeNotes('run');
    expect(lastCall()).toEqual(['bridge_notes', { runId: 'run' }]);
    await backend.diagnostics();
    expect(lastCall()).toEqual(['diagnostics', {}]);
    await backend.accountLimits();
    expect(lastCall()).toEqual(['account_limits', {}]);
    await backend.discardWorktree('run');
    expect(lastCall()).toEqual(['discard_worktree', { runId: 'run' }]);
  });
});

describe('Mock task contract', () => {
  afterEach(() => vi.useRealTimers());

  it('cancels scheduled events and preserves agent identity on stop', async () => {
    vi.useFakeTimers();
    const backend = new MockBackend();
    const events: AgentEvent[] = [];
    await backend.onEvent(e => events.push(e));
    const id = await backend.startTask('kiro', 'change', '/repo');
    await backend.stop(id);
    await vi.runAllTimersAsync();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: id, agent: 'kiro', kind: 'exit', code: null, data: null });
  });
});
