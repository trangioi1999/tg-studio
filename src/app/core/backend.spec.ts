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
    expect(invoke).toHaveBeenLastCalledWith('start_task', { agent: 'codex', prompt: 'change', repo: '/repo' });
    await backend.respondPermission('run', 'request', 'allow', true);
    expect(invoke).toHaveBeenLastCalledWith('respond_permission', { runId: 'run', requestId: 'request', optionId: 'allow', always: true });
    await backend.getDiff('run');
    expect(invoke).toHaveBeenLastCalledWith('get_diff', { runId: 'run' });
    await backend.acceptHunk('run', 'file', 'hunk');
    expect(invoke).toHaveBeenLastCalledWith('accept_hunk', { runId: 'run', path: 'file', hunkId: 'hunk' });
    await backend.rejectHunk('run', 'file', 'hunk');
    expect(invoke).toHaveBeenLastCalledWith('reject_hunk', { runId: 'run', path: 'file', hunkId: 'hunk' });
    expect(await backend.commitAccepted('run', 'commit')).toBe('result');
    expect(invoke).toHaveBeenLastCalledWith('commit_accepted', { runId: 'run', message: 'commit' });
    await backend.discardWorktree('run');
    expect(invoke).toHaveBeenLastCalledWith('discard_worktree', { runId: 'run' });
  });
});
