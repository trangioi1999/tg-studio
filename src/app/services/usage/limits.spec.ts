import { limitView, limitsTitle } from './limits';
import { AccountLimits, LimitWindow } from '../../core/protocol';

const NOW = new Date(2026, 10, 5, 12, 0).getTime();
const w = (over: Partial<LimitWindow> = {}): LimitWindow => ({ id: 'five_hour', utilization: 0.234, resetsAt: NOW + 3600000, status: null, ...over });

describe('limitView', () => {
  it('names the windows and rounds the percent', () => {
    expect(limitView(w(), NOW)).toMatchObject({ name: '5 giờ', percent: 23, level: 'ok', reset: false });
    expect(limitView(w({ id: 'seven_day' }), NOW).name).toBe('7 ngày');
    expect(limitView(w({ id: '60_minutes' }), NOW).name).toBe('60 phút');
  });

  it('warns from 80 % and marks 100 % as over', () => {
    expect(limitView(w({ utilization: 0.8 }), NOW).level).toBe('warn');
    expect(limitView(w({ utilization: 1.2 }), NOW)).toMatchObject({ level: 'over', percent: 120 });
  });

  it('does not show an old percent after the window has reset', () => {
    expect(limitView(w({ utilization: 0.99, resetsAt: NOW - 1 }), NOW)).toMatchObject({ percent: 0, reset: true, level: 'ok' });
  });

  it('keeps the percent when no reset time is known', () => {
    expect(limitView(w({ resetsAt: null }), NOW)).toMatchObject({ percent: 23, reset: false });
  });
});

describe('limitsTitle', () => {
  const limits = (over: Partial<AccountLimits> = {}): AccountLimits => ({ agent: 'claude', windows: [w()], at: NOW - 5 * 60000, ...over });

  it('says how old the numbers are and when the window resets', () => {
    const title = limitsTitle(limits(), NOW);
    expect(title).toContain('đã dùng 23%');
    expect(title).toContain('reset lúc');
    expect(title).toContain('5 phút trước');
  });

  it('says a window has passed its reset', () => {
    expect(limitsTitle(limits({ windows: [w({ resetsAt: NOW - 1 })] }), NOW)).toContain('đã qua kỳ reset');
  });
});
