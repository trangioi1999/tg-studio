import { canCompact, categoryName, contextLabel, contextTone } from './context';

describe('contextTone', () => {
  it('is calm below 50, warns up to 80, then fails', () => {
    expect(contextTone(49.9)).toBe('run');
    expect(contextTone(50)).toBe('wait');
    expect(contextTone(80)).toBe('wait');
    expect(contextTone(80.1)).toBe('fail');
    expect(contextTone(null)).toBeNull();
  });
});

describe('contextLabel', () => {
  it('shows what is known', () => {
    expect(contextLabel({ used: 184000, size: 1000000, percent: 18.4, source: 'claude' })).toBe('18% · 184k/1M');
    expect(contextLabel({ used: null, size: null, percent: 7, source: 'kiro' })).toBe('7%');
    expect(contextLabel({ used: 184000, size: null, percent: null, source: 'acp' })).toBe('184k token');
  });
});

describe('fmtTokens', () => {
  it('drops only a trailing .0', () => {
    expect(contextLabel({ used: 100_000, size: 1_000_000, percent: 10, source: 'claude' })).toBe('10% · 100k/1M');
    expect(contextLabel({ used: 1_050_000, size: 2_000_000, percent: 52, source: 'claude' })).toBe('52% · 1.1M/2M');
    expect(contextLabel({ used: 20_000, size: 40_000, percent: 50, source: 'claude' })).toBe('50% · 20k/40k');
  });
});

describe('canCompact', () => {
  it('is always true for Claude, for others only with a compact command', () => {
    expect(canCompact('codex', [])).toBe(false);
    expect(canCompact('claude', [])).toBe(true);
    expect(canCompact('codex', [{ name: 'compact' } as never])).toBe(true);
  });
});

describe('categoryName', () => {
  it('translates known ids and keeps the original name otherwise', () => {
    expect(categoryName({ id: 'messages', name: 'Messages', tokens: 1 })).toBe('Tin nhắn');
    expect(categoryName({ id: 'x', name: 'Khác', tokens: 1 })).toBe('Khác');
  });
});
