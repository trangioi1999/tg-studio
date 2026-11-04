import { vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TauriBackend } from './backend';
import { MockBackend } from './mock-backend';
import { AgentEvent } from './protocol';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('Tauri task commands', () => {
  it('forwards task arguments using the native camelCase contract', async () => {
    const backend = new TauriBackend();
    vi.mocked(invoke).mockResolvedValue('result');
    expect(await backend.startTask('codex', 'change', '/repo')).toBe('result');
    expect(invoke).toHaveBeenLastCalledWith('start_task', { agent: 'codex', prompt: 'change', repo: '/repo', group: null });
    await backend.startTask('claude', 'change', '/repo', 'g-1');
    expect(invoke).toHaveBeenLastCalledWith('start_task', { agent: 'claude', prompt: 'change', repo: '/repo', group: 'g-1' });
    await backend.respondPermission('run', 'request', 'allow', true);
    expect(invoke).toHaveBeenLastCalledWith('respond_permission', { runId: 'run', requestId: 'request', optionId: 'allow', always: true });
    await backend.getDiff('run');
    expect(invoke).toHaveBeenLastCalledWith('get_diff', { runId: 'run' });
    await backend.acceptHunk('run', 'file', 'hunk');
    expect(invoke).toHaveBeenLastCalledWith('accept_hunk', { runId: 'run', path: 'file', hunkId: 'hunk' });
    await backend.acceptAll('run');
    expect(invoke).toHaveBeenLastCalledWith('accept_all', { runId: 'run' });
    await backend.listFiles('run');
    expect(invoke).toHaveBeenLastCalledWith('list_worktree_files', { runId: 'run' });
    await backend.readFile('run', 'a b.ts');
    expect(invoke).toHaveBeenLastCalledWith('read_worktree_file', { runId: 'run', path: 'a b.ts' });
    await backend.writeFile('run', 'a b.ts', 'x');
    expect(invoke).toHaveBeenLastCalledWith('write_worktree_file', { runId: 'run', path: 'a b.ts', content: 'x' });
    await backend.rejectHunk('run', 'file', 'hunk');
    expect(invoke).toHaveBeenLastCalledWith('reject_hunk', { runId: 'run', path: 'file', hunkId: 'hunk' });
    expect(await backend.commitAccepted('run', 'commit')).toBe('result');
    expect(invoke).toHaveBeenLastCalledWith('commit_accepted', { runId: 'run', message: 'commit' });
    await backend.accountLimits();
    expect(invoke).toHaveBeenLastCalledWith('account_limits');
    await backend.discardWorktree('run');
    expect(invoke).toHaveBeenLastCalledWith('discard_worktree', { runId: 'run' });
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
