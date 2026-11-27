import { Run } from '../../../services/runs/run';
import { CHEER_MS, mascotPose, NAP_MS } from './dock-mascot';

const run = (over: Partial<Run> = {}) => ({ status: 'running', permissions: [], lines: [], startedAt: 1000, endedAt: null, restored: false, ...over }) as Run;

describe('mascotPose', () => {
  it('thinks before the agent does anything, codes once it works or writes', () => {
    expect(mascotPose(run(), { now: 2000, lastEvent: 1500 }).pose).toBe('thinking');
    expect(mascotPose(run({ lines: [{ text: '› Đọc src/app.ts', tone: 'tool' }] }), { now: 2000, lastEvent: 1500 }).pose).toBe('coding');
    expect(mascotPose(run({ lines: [{ text: 'Đây là kết quả', tone: 'text' }] }), { now: 2000, lastEvent: 1500 }).pose).toBe('coding');
    // A new question: back to thinking.
    expect(mascotPose(run({ lines: [{ text: 'xong', tone: 'text' }, { text: 'thêm test', tone: 'user' }] }), { now: 2000 }).pose).toBe('thinking');
  });

  it('thinks while waiting for an approval or gone quiet', () => {
    const working = { lines: [{ text: '› Sửa a.ts', tone: 'tool' as const }] };
    expect(mascotPose(run({ ...working, permissions: [{}] as Run['permissions'] }), { now: 2000, lastEvent: 1500 }).pose).toBe('thinking');
    expect(mascotPose(run(working), { now: 40_000, lastEvent: 1500 }).pose).toBe('thinking');
  });

  it('cheers only for a turn it saw finish, then stands by, then sleeps', () => {
    const r = run({ status: 'idle' });
    expect(mascotPose(r, { now: 5000, lastEvent: 4000, finishedAt: 4000 })).toEqual({ pose: 'success', next: 4000 + CHEER_MS });
    expect(mascotPose(r, { now: 4000 + CHEER_MS, lastEvent: 4000, finishedAt: 4000 })).toEqual({ pose: 'idle', next: 4000 + NAP_MS });
    expect(mascotPose(r, { now: 4000 + NAP_MS, lastEvent: 4000, finishedAt: 4000 }).pose).toBe('sleep');
    // Opened already idle: no cheering.
    expect(mascotPose(r, { now: 5000, lastEvent: 4000 }).pose).toBe('idle');
  });

  it('is upset when the run failed, asleep for a closed session from history', () => {
    expect(mascotPose(run({ status: 'failed' }), { now: 5000 }).pose).toBe('oops');
    expect(mascotPose(run({ status: 'stopped' }), { now: 5000 }).pose).toBe('idle');
    expect(mascotPose(run({ status: 'done', restored: true }), { now: 5000 }).pose).toBe('sleep');
  });
});
