import { TestBed } from '@angular/core/testing';
import { AgentBackend } from './backend';
import { BudgetService, parseBudgets } from './budget.service';
import { MockBackend } from './mock-backend';
import { PRICE_HISTORY, costOf, estimateCost, priceAt } from './pricing';
import { RunsService } from './runs.service';
import { niceMax, toCsv } from '../shell/usage-screen';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000, costUsd: null, source: 'tokens' as const, cumulative: true };

describe('pricing history', () => {
  afterEach(() => PRICE_HISTORY.set([]));

  it('prices a run at what applied when it started', () => {
    PRICE_HISTORY.set([
      { agent: 'codex', fromMs: 100, input: 1, cachedInput: 0.1, output: 4 },
      { agent: 'codex', fromMs: 200, input: 2, cachedInput: 0.2, output: 8 },
      { agent: 'codex', fromMs: 300, input: null, cachedInput: null, output: null },
    ]);
    expect(estimateCost('codex', usage, 50)).toBeNull();
    expect(estimateCost('codex', usage, 150)).toBe(5);
    expect(estimateCost('codex', usage, 250)).toBe(10);
    expect(estimateCost('codex', usage, 350)).toBeNull();
    expect(priceAt('gemini', 250)).toBeNull();
    expect(costOf('codex', { ...usage, costUsd: 0.3 }, 150)).toEqual({ usd: 0.3, source: 'reported' });
    expect(costOf('codex', usage, 150)).toEqual({ usd: 5, source: 'estimated' });
    expect(costOf('codex', usage, 350)).toEqual({ usd: null, source: 'unpriced' });
    expect(costOf('codex', null, 150)).toEqual({ usd: null, source: 'none' });
  });
});

describe('BudgetService', () => {
  it('stops a run over the per-task budget and blocks work past the daily one', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useClass: MockBackend }] });
    const runs = TestBed.inject(RunsService);
    const budget = TestBed.inject(BudgetService);
    await budget.load();
    await budget.saveBudgets({ perTask: 0.01, daily: null });
    // Mock Claude reports $0.04 for the task, before it ends.
    await runs.startTask('claude', 'đắt', '/repo');
    await wait(300);
    const r = runs.selected()!;
    await runs.respondPermission(r.id, r.permissions[0].requestId, 'allow', false);
    await wait(800);
    expect(runs.selected()!.status).toBe('stopped');
    expect(budget.notices().join()).toContain('ngân sách mỗi task');
    expect(budget.blockReason()).toBeNull();
    await budget.saveBudgets({ perTask: null, daily: 0.01 });
    expect(budget.dailyLevel()).toBe('over');
    expect(budget.blockReason()).toContain('ngân sách ngày');
    await budget.saveBudgets({ perTask: -1, daily: 0 });
    expect(budget.budgets()).toEqual({ perTask: null, daily: null });
  });

  it('backfills only the unpriced past', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useClass: MockBackend }] });
    const budget = TestBed.inject(BudgetService);
    await budget.load();
    await budget.setPrice({ agent: 'codex', input: 1, cachedInput: 0, output: 1 }, true);
    expect(estimateCost('codex', usage, 1)).toBe(2);
    // A later backfill must not rewrite the period that already had a price.
    await budget.setPrice({ agent: 'codex', input: 5, cachedInput: 0, output: 5 }, true);
    expect(estimateCost('codex', usage, 1)).toBe(2);
    expect(estimateCost('codex', usage, Date.now() + 1)).toBe(10);
    PRICE_HISTORY.set([]);
  });

  it('parses saved budgets defensively', () => {
    expect(parseBudgets('{"perTask":2,"daily":"x"}')).toEqual({ perTask: 2, daily: null });
    expect(parseBudgets('not json')).toEqual({ perTask: null, daily: null });
  });
});

describe('usage screen helpers', () => {
  it('rounds the axis to 1, 2 or 5 × 10ⁿ', () => {
    expect([0, 0.03, 0.4, 7, 12, 260].map(niceMax)).toEqual([0, 0.05, 0.5, 10, 20, 500]);
  });

  it('writes CSV with escaping and the cost source', () => {
    const csv = toCsv([{ id: 'a', agent: 'claude', prompt: 'Sửa "lỗi", rồi\nchạy', startedAt: Date.UTC(2026, 10, 4), endedAt: null, status: 'done', group: null,
      usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, costUsd: 0.5, source: 'reported', cumulative: true } }]);
    const [head, line] = csv.split('\r\n');
    expect(head).toBe('started_at,agent,status,prompt,input_tokens,cached_input_tokens,output_tokens,cost_usd,cost_source');
    expect(line).toBe('2026-11-04T00:00:00.000Z,claude,done,"Sửa ""lỗi"", rồi\nchạy",1,2,3,0.500000,reported');
  });
});
