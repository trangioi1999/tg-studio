import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AgentBackend } from '../../core/backend';
import { BudgetService } from '../budget.service';
import { fmtTokens, fmtUsd } from '../../shared/format';
import { PRICE_HISTORY, costOf, priceAt } from '../pricing';
import { AgentId, UsageRow } from '../../core/protocol';
import { AGENT_IDS, AGENT_META } from '../../agents/agent-meta';
import { RunsService } from '../../runs/runs.service';
import { UiService } from '../../shell/ui.service';
import {
  DayBucket, Measure, SortKey, agentShares, changePct, dailyBuckets, filterRows, niceMax, sortRows, sparkPath, startOfDay, tokensOf, totalsOf, toCsv,
} from '../usage-report';
import { errorText } from '../../shared/errors';

const PAGE = 15;
const RING = 2 * Math.PI * 15;

/** Usage ledger: KPIs against the previous period, a daily chart, spend per agent, plan limits and every run. */
/** What the Usage screen's parts share: the ledger of the range, filters, chart, prices and budgets. Provided by UsageScreen. */
@Injectable()
export class UsageState {
  private readonly backend = inject(AgentBackend);
  private readonly runs = inject(RunsService);
  private readonly ui = inject(UiService);
  readonly budget = inject(BudgetService);
  readonly meta = AGENT_META;
  readonly agentIds = AGENT_IDS;
  readonly ranges = [7, 30, 90];
    readonly tok = fmtTokens;
  readonly usd = fmtUsd;
  readonly tokens = tokensOf;
  readonly round = Math.round;
  readonly min = Math.min;
  readonly sourceLabel = { reported: 'CLI báo', estimated: 'Ước tính theo bảng giá', unpriced: 'Chưa có giá', none: 'Không có số liệu' };

  readonly days = signal(30);
  readonly measure = signal<Measure>('cost');
  /** Runs of the range and of the period before it, so the KPIs can compare. */
  private readonly loaded = signal<UsageRow[]>([]);
  readonly hover = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  readonly saved = signal<string | null>(null);
  readonly busy = signal(false);
  readonly sheet = signal(false);
  readonly backfill = signal(false);
  readonly draftTask = signal<string | null>(null);
  readonly draftDaily = signal<string | null>(null);
  readonly drafts = signal<Partial<Record<AgentId, { input?: string; cachedInput?: string; output?: string }>>>({});
  readonly agent = signal<AgentId | null>(null);
  readonly day = signal<number | null>(null);
  readonly query = signal('');
  readonly sort = signal<SortKey>('time');

  /** Moves at midnight, so "today" stays right on a screen left open overnight. */
  readonly today = signal(startOfDay(Date.now()));
  private readonly rangeStart = computed(() => this.dayAgo(this.days() - 1));

  readonly rows = computed(() => this.loaded().filter((r) => r.startedAt >= this.rangeStart()));
  private readonly prevRows = computed(() => {
    const from = this.dayAgo(2 * this.days() - 1);
    return this.loaded().filter((r) => r.startedAt >= from && r.startedAt < this.rangeStart());
  });

  readonly totals = computed(() => (PRICE_HISTORY(), totalsOf(this.rows())));
  readonly costChange = computed(() => {
    PRICE_HISTORY();
    const prev = totalsOf(this.prevRows()).cost;
    const pct = changePct(this.totals().cost, prev);
    return pct === null ? null : { pct, prev };
  });
  readonly cachePct = computed(() => {
    const t = this.totals();
    return t.tokens ? Math.round((t.cached / t.tokens) * 100) : 0;
  });
  private readonly costDays = computed(() => (PRICE_HISTORY(), this.today(), dailyBuckets(this.rows(), this.days(), 'cost')));
  readonly costSpark = computed(() => sparkPath(this.costDays().map((d) => d.total), 200, 26));
  readonly runSpark = computed(() => sparkPath(this.costDays().map((d) => d.runs), 200, 26));

  readonly shares = computed(() => (PRICE_HISTORY(), agentShares(this.rows())));
  readonly unpricedBy = computed(() => {
    PRICE_HISTORY();
    const out: Partial<Record<AgentId, number>> = {};
    for (const r of this.loaded()) if (r.usage && costOf(r.agent, r.usage, r.startedAt).usd === null) out[r.agent] = (out[r.agent] ?? 0) + 1;
    return out;
  });

  readonly filtered = computed(() => {
    PRICE_HISTORY();
    return sortRows(filterRows(this.rows(), { agent: this.agent(), day: this.day(), query: this.query() }), this.sort());
  });
  readonly shown = signal(PAGE);
  readonly tableRows = computed(() => this.filtered().slice(0, this.shown()));
  /** The three most expensive runs get a highlight, once there are enough to tell apart. */
  private readonly topIds = computed(() => {
    PRICE_HISTORY();
    if (this.filtered().length <= 3) return new Set<string>();
    return new Set(sortRows(this.filtered(), 'cost').slice(0, 3).filter((r) => (costOf(r.agent, r.usage, r.startedAt).usd ?? 0) > 0).map((r) => r.id));
  });
  /** Runs still in the conversation list; deleted ones keep their cost but cannot be opened. */
  readonly openable = computed(() => new Set(this.runs.runs().map((r) => r.id)));
  readonly labelEvery = computed(() => Math.max(1, Math.ceil(this.days() / 8)));

  readonly chart = computed(() => {
    PRICE_HISTORY();
    this.today();
    const measure = this.measure();
    const agent = this.agent();
    const days = dailyBuckets(agent ? this.rows().filter((r) => r.agent === agent) : this.rows(), this.days(), measure);
    const limit = measure === 'cost' && !agent ? this.budget.budgets().daily : null;
    const peak = Math.max(0, ...days.map((d) => d.total));
    // Show the budget line only when it sits near the bars, not far above a flat chart.
    const showBudget = limit !== null && limit > 0 && peak >= limit * 0.3;
    const max = niceMax(Math.max(peak, showBudget ? limit : 0));
    const ticks = max ? [0.5, 1].map((f) => ({ value: max * f, pct: f * 100, label: measure === 'cost' ? fmtUsd(max * f) : fmtTokens(max * f) })) : [];
    return { days, max, ticks, budget: showBudget && max ? { value: limit, pct: (limit / max) * 100 } : null };
  });

  readonly chartLabel = computed(() => {
    const peak = [...this.chart().days].sort((a, b) => b.total - a.total)[0];
    return `${this.measure() === 'cost' ? 'Chi phí' : 'Token'} theo ngày trong ${this.days()} ngày${peak?.total ? `; cao nhất ${peak.label}: ${this.fmt(peak.total)}` : ''}. Số liệu đầy đủ ở bảng bên dưới.`;
  });

  readonly budgetSummary = computed(() => {
    const { daily, perTask } = this.budget.budgets();
    if (daily === null && perTask === null) return 'Không giới hạn';
    return [daily !== null ? `${fmtUsd(daily)} / ngày` : null, perTask !== null ? `${fmtUsd(perTask)} / task` : null].filter(Boolean).join(' · ');
  });

  constructor() {
    // Reload when the range changes and whenever a run ends.
    effect(() => {
      const days = this.days();
      this.today();
      this.runs.runs().filter((r) => r.status !== 'running').length;
      untracked(() => void this.load(days));
    });
    const timer = setInterval(() => {
      const now = startOfDay(Date.now());
      if (now !== this.today()) this.today.set(now);
    }, 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private dayAgo(n: number): number {
    const d = new Date(this.today());
    d.setDate(d.getDate() - n);
    return d.getTime();
  }

  private loads = 0;

  private async load(days: number): Promise<void> {
    // Switching the range quickly: only the latest request may fill the screen.
    const ticket = ++this.loads;
    try {
      const since = new Date(this.today());
      since.setDate(since.getDate() - (2 * days - 1));
      const rows = await this.backend.usageReport(since.getTime());
      if (ticket !== this.loads) return;
      this.loaded.set(rows);
      this.error.set(null);
    } catch (e) {
      if (ticket !== this.loads) return;
      this.error.set(errorText(e));
    }
  }

  setDays(d: number): void {
    this.days.set(d);
    if (this.day() !== null && this.day()! < this.dayAgo(d - 1)) this.day.set(null);
  }

  toggleDay(start: number): void {
    this.day.update((d) => (d === start ? null : start));
  }

  toggleAgent(a: AgentId): void {
    this.agent.update((x) => (x === a ? null : a));
  }

  open(r: UsageRow): void {
    if (this.openable().has(r.id)) this.ui.openRun(r.id);
  }

  isTop(r: UsageRow): boolean {
    return this.topIds().has(r.id);
  }

  fmt(v: number): string {
    return this.measure() === 'cost' ? fmtUsd(v) : `${fmtTokens(v)} tok`;
  }

  pctText(p: number): string {
    const a = Math.abs(p);
    return `${a < 10 ? a.toFixed(1).replace(/\.0$/, '') : Math.round(a)}%`;
  }

  ringDash(limit: number): string {
    const used = Math.min(1, limit > 0 ? this.budget.todayCost() / limit : 0);
    return `${(used * RING).toFixed(1)} ${RING.toFixed(1)}`;
  }

  todayLeft(limit: number): string {
    const spent = this.budget.todayCost();
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
    return spent >= limit ? `vượt ${fmtUsd(spent - limit)} · ${pct}%` : `còn ${fmtUsd(limit - spent)} · ${pct}%`;
  }

  dayLabel(d: DayBucket): string {
    return `${d.label}: ${d.segments.map((s) => `${AGENT_META[s.agent].name} ${this.fmt(s.value)}`).join(', ') || 'không có'}. Bấm để lọc bảng.`;
  }

  dayText(ms: number): string {
    const d = new Date(ms);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }

  costRow(r: UsageRow) {
    PRICE_HISTORY();
    return costOf(r.agent, r.usage, r.startedAt);
  }

  current(agent: AgentId) {
    PRICE_HISTORY();
    const p = priceAt(agent, Date.now());
    return p && (p.input !== null || p.cachedInput !== null || p.output !== null) ? p : null;
  }

  priceText(v: number | null): string {
    return v === null ? '—' : `$${v}`;
  }

  when(ms: number): string {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(ms);
  }

  date(ms: number): string {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(ms);
  }

  shortDate(ms: number): string {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit' }).format(ms);
  }

  draft(agent: AgentId, field: 'input' | 'cachedInput' | 'output', value: string): void {
    this.drafts.update((d) => ({ ...d, [agent]: { ...d[agent], [field]: value } }));
  }

  async savePrice(agent: AgentId): Promise<void> {
    const d = this.drafts()[agent] ?? {};
    const now = this.current(agent);
    const pick = (f: 'input' | 'cachedInput' | 'output') => {
      const raw = d[f] ?? (now?.[f] ?? '').toString();
      return raw.trim() === '' ? null : Number(raw);
    };
    await this.guard(async () => {
      await this.budget.setPrice({ agent, input: pick('input'), cachedInput: pick('cachedInput'), output: pick('output') }, this.backfill());
      this.drafts.update(({ [agent]: _, ...rest }) => rest);
    });
  }

  async saveBudgets(): Promise<void> {
    const parse = (raw: string | null, fallback: number | null) => (raw === null ? fallback : raw.trim() === '' ? null : Number(raw));
    await this.guard(() => this.budget.saveBudgets({
      perTask: parse(this.draftTask(), this.budget.budgets().perTask),
      daily: parse(this.draftDaily(), this.budget.budgets().daily),
    }));
  }

  async exportCsv(): Promise<void> {
    await this.guard(async () => {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      this.saved.set(await this.backend.saveExport(`tg-studio-usage-${stamp}.csv`, toCsv(this.rows())));
    });
  }

  private async guard(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }}
