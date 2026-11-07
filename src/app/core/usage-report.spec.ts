import { describe, expect, it } from 'vitest';
import { AgentId, UsageRow } from './protocol';
import { agentShares, changePct, dailyBuckets, filterRows, sortRows, sparkPath, startOfDay, totalsOf } from './usage-report';

const NOW = new Date(2026, 10, 7, 15, 0).getTime();
const at = (daysAgo: number, hour = 10) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

function row(id: string, agent: AgentId, startedAt: number, cost: number | null, tokens = 100, prompt = 'việc ' + id): UsageRow {
  return {
    id, agent, prompt, startedAt, endedAt: null, status: 'done', group: null,
    usage: { inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, costUsd: cost, source: cost === null ? 'tokens' : 'reported', cumulative: true },
  };
}

describe('usage report', () => {
  const rows = [
    row('a', 'claude', at(0), 2, 500, 'Sửa lỗi PATH'),
    row('b', 'codex', at(0, 11), 1, 300),
    row('c', 'claude', at(2), 1, 200),
    row('d', 'kiro', at(1), null, 50),
  ];

  it('totals cost, tokens and unpriced runs', () => {
    expect(totalsOf(rows)).toEqual({ cost: 4, tokens: 1050, cached: 0, runs: 4, unpriced: 1 });
  });

  it('buckets by day ending today, agents in fixed order', () => {
    const days = dailyBuckets(rows, 3, 'cost', NOW);
    expect(days.map((d) => d.total)).toEqual([1, 0, 3]);
    expect(days.map((d) => d.runs)).toEqual([1, 1, 2]);
    expect(days[2].start).toBe(startOfDay(NOW));
    expect(days[2].segments.map((s) => [s.agent, Math.round(s.pct)])).toEqual([['claude', 67], ['codex', 33]]);
  });

  it('shares by cost, or by tokens when nothing is priced', () => {
    expect(agentShares(rows).map((a) => [a.agent, Math.round(a.share), a.runs])).toEqual([['claude', 75, 2], ['codex', 25, 1], ['kiro', 0, 1]]);
    expect(agentShares([rows[3]])[0].share).toBe(100);
  });

  it('filters by agent, day and prompt text', () => {
    expect(filterRows(rows, { agent: 'claude', day: null, query: '' }).map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterRows(rows, { agent: null, day: startOfDay(NOW), query: '' }).map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterRows(rows, { agent: null, day: null, query: 'path' }).map((r) => r.id)).toEqual(['a']);
  });

  it('sorts by cost with unpriced last', () => {
    expect(sortRows(rows, 'cost').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortRows(rows, 'time').map((r) => r.id)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('compares with the previous period', () => {
    expect(changePct(12, 10)).toBe(20);
    expect(changePct(5, 0)).toBeNull();
  });

  it('draws a sparkline inside the box', () => {
    expect(sparkPath([0, 5, 10], 100, 20)).toBe('M0 19 L50 10 L100 1');
    expect(sparkPath([0, 0], 10, 20)).toBe('M0 19 L10 19');
    expect(sparkPath([3], 10, 20)).toBe('');
  });
});
