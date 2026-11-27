import { Run, canSwitchLive } from './run';

const run = (over: Partial<Run>): Run => ({ id: 'r', agent: 'claude', prompt: '', cwd: '/d', startedAt: 0, endedAt: null, status: 'idle', lines: [], usage: null, exitCode: null, restored: false, task: true, permissions: [], perm: 'read', ...over }) as Run;

describe('canSwitchLive', () => {
  it('lets Claude change between every mode in the open session', () => {
    expect(canSwitchLive(run({}), 'ask')).toBe(true);
    expect(canSwitchLive(run({ perm: 'auto' }), 'deny')).toBe(true);
  });
  it('keeps Chỉ hỏi apart for the other agents', () => {
    expect(canSwitchLive(run({ agent: 'codex' }), 'ask')).toBe(false);
    expect(canSwitchLive(run({ agent: 'gemini', perm: 'ask' }), 'deny')).toBe(false);
    expect(canSwitchLive(run({ agent: 'codex', perm: 'ask' }), 'auto')).toBe(true);
  });
  it('needs a live session', () => {
    expect(canSwitchLive(run({ restored: true }), 'ask')).toBe(false);
    expect(canSwitchLive(run({ status: 'done' }), 'ask')).toBe(false);
  });
});
