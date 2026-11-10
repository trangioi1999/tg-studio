import { Injectable, computed, effect, inject, signal, untracked, DestroyRef } from '@angular/core';
import { AgentBackend } from '../../core/backend';
import { fmtUsd } from '../../shared/utils/format';
import { PRICE_HISTORY, costOf } from './pricing';
import { PriceRow, UsageRow } from '../../core/protocol';
import { RunsService } from '../runs/runs.service';
import { turnStart } from '../runs/run';
import { startOfDay } from './usage-report';

export interface Budgets {
  /** USD per run; a run that goes over is stopped. */
  perTask: number | null;
  /** USD per calendar day across all runs; reaching it stops runs and blocks new ones. */
  daily: number | null;
}

const WARN_AT = 0.8;

/**
 * Prices and budgets. Spending is only known when an agent reports usage, and many
 * report it at the end of a run, so a per-task stop can only act once numbers arrive.
 */
@Injectable({ providedIn: 'root' })
export class BudgetService {
  private readonly backend = inject(AgentBackend);
  private readonly runs = inject(RunsService);

  readonly budgets = signal<Budgets>({ perTask: null, daily: null });
  readonly notices = signal<string[]>([]);
  /** Today's runs from history, so spending survives an app restart. */
  private readonly todayRows = signal<UsageRow[]>([]);
  /** Turns already stopped for the budget (`run:turnAt`): each later turn of an open
   * session is checked again, and a stop that failed is retried. */
  private readonly stoppedForBudget = new Set<string>();

  /** Start of the current day; moves at midnight even when nothing is running. */
  private readonly dayStart = signal(startOfDay(Date.now()));
  /** Runs that have ended. Log lines of a running agent must not reload history. */
  private readonly endedRuns = computed(() => this.runs.runs().filter((r) => r.status !== 'running').length);

  readonly todayCost = computed(() => {
    const since = this.dayStart();
    const live = new Map(this.runs.runs().filter((r) => r.startedAt >= since).map((r) => [r.id, r]));
    let total = 0;
    for (const row of this.todayRows()) if (row.startedAt >= since && !live.has(row.id)) total += costOf(row.agent, row.usage, row.startedAt).usd ?? 0;
    for (const r of live.values()) total += costOf(r.agent, r.usage, r.startedAt).usd ?? 0;
    return total;
  });

  readonly dailyLevel = computed<'none' | 'ok' | 'warn' | 'over'>(() => {
    const limit = this.budgets().daily;
    if (limit === null) return 'none';
    const spent = this.todayCost();
    return spent >= limit ? 'over' : spent >= limit * WARN_AT ? 'warn' : 'ok';
  });

  /** Why new work is refused, if it is. */
  readonly blockReason = computed(() => {
    const limit = this.budgets().daily;
    return this.dailyLevel() === 'over' && limit !== null
      ? `Đã chạm ngân sách ngày (${fmtUsd(this.todayCost())} / ${fmtUsd(limit)}). Tăng ngân sách ở màn Usage hoặc đợi sang ngày mới.`
      : null;
  });

  constructor() {
    void this.load();
    // Refresh today's history whenever a run ends.
    effect(() => {
      this.endedRuns();
      this.dayStart();
      untracked(() => void this.loadToday());
    });
    const timer = setInterval(() => this.dayStart.set(startOfDay(Date.now())), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect(() => {
      const { perTask } = this.budgets();
      const over = this.dailyLevel() === 'over';
      const running = this.runs.running();
      untracked(() => {
        for (const r of running) {
          const turn = `${r.id}:${turnStart(r)}`;
          if (this.stoppedForBudget.has(turn)) continue;
          const spent = costOf(r.agent, r.usage, r.startedAt).usd;
          const taskOver = perTask !== null && spent !== null && spent >= perTask;
          if (!taskOver && !over) continue;
          this.stoppedForBudget.add(turn);
          this.runs.stop(r.id).catch(() => this.stoppedForBudget.delete(turn));
          this.notice(taskOver
            ? `Đã dừng "${r.prompt || r.agent}" vì vượt ngân sách mỗi task (${fmtUsd(spent)} / ${fmtUsd(perTask)}).`
            : `Đã dừng "${r.prompt || r.agent}" vì đã chạm ngân sách ngày.`);
        }
      });
    });
  }

  async load(): Promise<void> {
    try {
      PRICE_HISTORY.set(await this.backend.listPrices());
      const raw = await this.backend.getSetting('budgets');
      if (raw) this.budgets.set(parseBudgets(raw));
    } catch (e) {
      console.warn('Không đọc được bảng giá hoặc ngân sách', e);
    }
    await this.loadToday();
  }

  private async loadToday(): Promise<void> {
    try {
      this.todayRows.set(await this.backend.usageReport(startOfDay(Date.now())));
    } catch {
      /* history is optional */
    }
  }

  async saveBudgets(b: Budgets): Promise<void> {
    const clean = { perTask: positive(b.perTask), daily: positive(b.daily) };
    await this.backend.setSetting('budgets', JSON.stringify(clean));
    this.budgets.set(clean);
  }

  /**
   * A new price applies from now; earlier runs keep theirs. With `backfill` it also
   * covers runs before the first price this agent ever had, never a priced period.
   */
  async setPrice(price: Omit<PriceRow, 'fromMs'>, backfill = false): Promise<void> {
    const first = PRICE_HISTORY().filter((p) => p.agent === price.agent).reduce((m, p) => Math.min(m, p.fromMs), Infinity);
    if (backfill && first > 0) await this.backend.addPrice({ ...price, fromMs: 0 });
    await this.backend.addPrice({ ...price, fromMs: Date.now() });
    PRICE_HISTORY.set(await this.backend.listPrices());
  }

  dismiss(i: number): void {
    this.notices.update((n) => n.filter((_, j) => j !== i));
  }

  private notice(text: string): void {
    this.notices.update((n) => [...n.slice(-4), text]);
  }
}

function positive(v: number | null): number | null {
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

export function parseBudgets(raw: string): Budgets {
  try {
    const v = JSON.parse(raw) as Partial<Budgets>;
    return { perTask: positive(typeof v.perTask === 'number' ? v.perTask : null), daily: positive(typeof v.daily === 'number' ? v.daily : null) };
  } catch {
    return { perTask: null, daily: null };
  }
}
