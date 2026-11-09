import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { AgentBackend } from '../core/backend';
import { BudgetService } from './budget.service';
import { fmtTokens, fmtUsd } from '../shared/format';
import { PRICE_HISTORY, costOf, priceAt } from './pricing';
import { AgentId, UsageRow } from '../core/protocol';
import { AGENT_IDS, AGENT_META } from '../agents/agent-meta';
import { RunsService } from '../runs/runs.service';
import { UiService } from '../shell/ui.service';
import {
  DayBucket, Measure, SortKey, agentShares, changePct, dailyBuckets, filterRows, niceMax, sortRows, sparkPath, startOfDay, tokensOf, totalsOf, toCsv,
} from './usage-report';
import { AgentAvatar } from '../shared/agent-avatar';
import { UsagePanel } from './usage-panel';
import { errorText } from '../shared/errors';

export { niceMax, toCsv } from './usage-report';

const PAGE = 15;
const RING = 2 * Math.PI * 15;

/** Usage ledger: KPIs against the previous period, a daily chart, spend per agent, plan limits and every run. */
@Component({
  selector: 'tg-usage-screen',
  imports: [AgentAvatar, UsagePanel],
  host: { '(document:keydown.escape)': 'sheet.set(false)' },
  template: `
    <div class="cost-page">
      <header class="pg-head">
        <div><h1>Chi phí</h1><p>Token và tiền đã dùng cho mọi agent, tính theo giá lúc lượt chạy bắt đầu.</p></div>
        <span class="spacer"></span>
        <div class="segmented" role="group" aria-label="Khoảng thời gian">
          @for (d of ranges; track d) {
            <button [class.active]="days() === d" [attr.aria-pressed]="days() === d" (click)="setDays(d)">{{ d }} ngày</button>
          }
        </div>
        <button class="btn sm" (click)="sheet.set(true)">Giá &amp; ngân sách</button>
        <button class="btn sm" [disabled]="!rows().length" (click)="exportCsv()">Xuất CSV</button>
      </header>
      @if (error()) { <p class="error-text" role="alert">{{ error() }}</p> }
      @if (saved()) { <p class="dim cost-saved ellipsis" role="status">Đã lưu {{ saved() }}</p> }

      <section class="cost-kpis" aria-label="Tổng quan">
        <div class="pg-card cost-kpi cost-hero">
          <span class="cost-k">Tổng chi phí · {{ days() }} ngày</span>
          <strong class="cost-v">{{ usd(totals().cost) }}</strong>
          @if (costChange(); as c) {
            <span class="cost-delta" [attr.data-dir]="c.pct >= 0 ? 'up' : 'down'">{{ c.pct >= 0 ? '▲' : '▼' }} {{ pctText(c.pct) }} so với {{ days() }} ngày trước <span class="faint">({{ usd(c.prev) }})</span></span>
          } @else if (totals().unpriced) {
            <span class="dim cost-delta">{{ totals().unpriced }} lượt chưa có giá</span>
          } @else {
            <span class="dim cost-delta">Chưa có kỳ trước để so</span>
          }
          <svg class="cost-spark" viewBox="0 0 200 26" preserveAspectRatio="none" aria-hidden="true">
            <path [attr.d]="costSpark() + (costSpark() ? ' L200 26 L0 26 Z' : '')" class="area" />
            <path [attr.d]="costSpark()" class="line" />
          </svg>
        </div>
        <div class="pg-card cost-kpi">
          <span class="cost-k">Token</span>
          <strong class="cost-v">{{ tok(totals().tokens) }}</strong>
          <span class="dim cost-delta">{{ cachePct() }}% đọc từ cache</span>
          <div class="cost-track" aria-hidden="true"><i [style.width.%]="cachePct()"></i></div>
        </div>
        <div class="pg-card cost-kpi">
          <span class="cost-k">Lượt chạy</span>
          <strong class="cost-v">{{ rows().length }}</strong>
          <span class="dim cost-delta">TB {{ usd(totals().runs ? totals().cost / totals().runs : null) }} / lượt</span>
          <svg class="cost-spark" viewBox="0 0 200 26" preserveAspectRatio="none" aria-hidden="true"><path [attr.d]="runSpark()" class="line dim-line" /></svg>
        </div>
        <div class="pg-card cost-kpi" [attr.data-level]="budget.dailyLevel()">
          <span class="cost-k">Hôm nay</span>
          @if (budget.budgets().daily; as limit) {
            <div class="cost-ring-wrap">
              <svg class="cost-ring" viewBox="0 0 36 36" role="meter" aria-label="Chi phí hôm nay so với ngân sách ngày" aria-valuemin="0" [attr.aria-valuemax]="limit" [attr.aria-valuenow]="budget.todayCost()">
                <circle cx="18" cy="18" r="15" class="ring-bg" />
                <circle cx="18" cy="18" r="15" class="ring-fg" [attr.stroke-dasharray]="ringDash(limit)" transform="rotate(-90 18 18)" />
              </svg>
              <div>
                <strong class="cost-v sm">{{ usd(budget.todayCost()) }}</strong>
                <div class="dim cost-delta">/ {{ usd(limit) }} ngân sách ngày</div>
                <div class="cost-left">{{ todayLeft(limit) }}</div>
              </div>
            </div>
          } @else {
            <strong class="cost-v">{{ usd(budget.todayCost()) }}</strong>
            <button class="link cost-delta" (click)="sheet.set(true)">Đặt ngân sách ngày</button>
          }
        </div>
      </section>

      <div class="cost-grid">
        <section class="pg-card cost-chart-card" aria-label="Biểu đồ theo ngày">
          <div class="pg-card-head">
            <h2>Theo ngày</h2>
            @if (agent(); as a) { <span class="dim">chỉ {{ meta[a].name }}</span> }
            @if (day() !== null) { <span class="dim">bấm cột lần nữa để bỏ lọc</span> }
            <span class="spacer"></span>
            <div class="segmented" role="group" aria-label="Đơn vị">
              <button [class.active]="measure() === 'cost'" [attr.aria-pressed]="measure() === 'cost'" (click)="measure.set('cost')">Chi phí</button>
              <button [class.active]="measure() === 'tokens'" [attr.aria-pressed]="measure() === 'tokens'" (click)="measure.set('tokens')">Token</button>
            </div>
          </div>
          @if (chart().max > 0) {
            <div class="chart cost-chart" role="img" [attr.aria-label]="chartLabel()">
              <div class="chart-grid" aria-hidden="true">
                @for (t of chart().ticks; track t.value) {
                  <div class="tick" [style.bottom.%]="t.pct"><span class="mono">{{ t.label }}</span></div>
                }
                @if (chart().budget; as b) {
                  <div class="cost-budget-line" [style.bottom.%]="b.pct"><span>ngân sách ngày {{ usd(b.value) }}</span></div>
                }
              </div>
              <div class="bars">
                @for (d of chart().days; track d.start; let i = $index) {
                  <div class="day" tabindex="0" role="button" [class.today]="d.start === today()" [class.sel]="d.start === day()"
                       [attr.aria-pressed]="d.start === day()" [attr.aria-label]="dayLabel(d)"
                       (mouseenter)="hover.set(i)" (mouseleave)="hover.set(null)" (focus)="hover.set(i)" (blur)="hover.set(null)"
                       (click)="toggleDay(d.start)" (keydown.enter)="toggleDay(d.start)" (keydown.space)="$event.preventDefault(); toggleDay(d.start)">
                    <div class="stack" [style.height.%]="(d.total / chart().max) * 100">
                      @for (s of d.segments; track s.agent) {
                        <span class="seg" [style.flex-grow]="s.pct" [style.background]="meta[s.agent].chart"></span>
                      }
                    </div>
                    @if (hover() === i) {
                      <div class="tip" role="tooltip" [class.flip]="i > chart().days.length * 0.66">
                        <strong>{{ d.label }} <span class="dim">· {{ d.runs }} lượt</span></strong>
                        @for (s of d.segments; track s.agent) {
                          <div class="tip-row"><i [style.background]="meta[s.agent].chart"></i>{{ meta[s.agent].name }}<span class="spacer"></span><span class="mono">{{ fmt(s.value) }}</span></div>
                        }
                        <div class="tip-row tip-total">Tổng<span class="spacer"></span><span class="mono">{{ fmt(d.total) }}</span></div>
                        <span class="faint cost-tip-hint">Bấm để lọc bảng theo ngày này</span>
                      </div>
                    }
                  </div>
                }
              </div>
              <div class="x-labels" aria-hidden="true">
                @for (d of chart().days; track d.start; let i = $index) {
                  <span [class.cost-x-today]="d.start === today()">{{ i % labelEvery() === 0 || i === chart().days.length - 1 ? d.label : '' }}</span>
                }
              </div>
            </div>
          } @else {
            <p class="dim pad">{{ measure() === 'cost' ? 'Chưa có chi phí trong khoảng này. Chuyển sang Token, hoặc điền bảng giá để ước tính.' : 'Chưa có lượt chạy nào trong khoảng này.' }}</p>
          }
        </section>

        <div class="cost-side">
          <section class="pg-card" aria-label="Theo agent">
            <div class="pg-card-head"><h2>Theo agent</h2><span class="spacer"></span><span class="dim">bấm để lọc</span></div>
            <div class="cost-split">
              @for (a of shares(); track a.agent) {
                <button class="cost-split-row" [class.on]="agent() === a.agent" [attr.aria-pressed]="agent() === a.agent" (click)="toggleAgent(a.agent)">
                  <tg-agent-avatar [agent]="a.agent" [size]="22" />
                  <span class="cost-split-main">
                    <span class="cost-split-name"><span class="ellipsis">{{ meta[a.agent].name }}</span><span class="dim">{{ round(a.share) }}%</span></span>
                    <span class="cost-track"><i [style.width.%]="a.share" [style.background]="meta[a.agent].chart"></i></span>
                  </span>
                  <span class="cost-split-amt mono">{{ usd(a.cost) }}<small>{{ tok(a.tokens) }} tok · {{ a.runs }} lượt</small></span>
                </button>
              } @empty {
                <p class="dim">Chưa có lượt chạy nào trong khoảng này.</p>
              }
            </div>
          </section>
          <tg-usage-panel />
        </div>
      </div>

      <section class="pg-card" aria-label="Các lượt chạy">
        <div class="cost-table-tools">
          <h2>Các lượt chạy</h2>
          <span class="dim">{{ filtered().length === rows().length ? rows().length : filtered().length + ' / ' + rows().length }}</span>
          @if (agent(); as a) {
            <button class="fchip on" (click)="agent.set(null)" [attr.aria-label]="'Bỏ lọc ' + meta[a].name"><tg-agent-avatar [agent]="a" [size]="14" />{{ meta[a].name }} <span class="x">×</span></button>
          }
          @if (day() !== null) {
            <button class="fchip on" (click)="day.set(null)" aria-label="Bỏ lọc theo ngày">{{ dayText(day()!) }} <span class="x">×</span></button>
          }
          <span class="spacer"></span>
          <input class="cost-search" type="search" placeholder="Tìm theo yêu cầu…" aria-label="Tìm theo yêu cầu" [value]="query()" (input)="query.set($any($event.target).value)" />
        </div>
        <div class="table-wrap">
          <table class="runs-table cost-table">
            <thead><tr>
              <th><button class="cost-sort" [class.on]="sort() === 'time'" (click)="sort.set('time')">Thời gian{{ sort() === 'time' ? ' ↓' : '' }}</button></th>
              <th>Agent</th><th>Yêu cầu</th>
              <th class="num"><button class="cost-sort" [class.on]="sort() === 'tokens'" (click)="sort.set('tokens')">Token{{ sort() === 'tokens' ? ' ↓' : '' }}</button></th>
              <th class="num">Input</th><th class="num">Cache</th><th class="num">Output</th>
              <th class="num"><button class="cost-sort" [class.on]="sort() === 'cost'" (click)="sort.set('cost')">Chi phí{{ sort() === 'cost' ? ' ↓' : '' }}</button></th>
            </tr></thead>
            <tbody>
              @for (r of tableRows(); track r.id) {
                <tr [class.cost-open]="openable().has(r.id)" [attr.tabindex]="openable().has(r.id) ? 0 : null"
                    [attr.title]="openable().has(r.id) ? 'Mở cuộc trò chuyện' : null"
                    (click)="open(r)" (keydown.enter)="open(r)">
                  <td class="mono dim">{{ when(r.startedAt) }}</td>
                  <td><span class="cell-agent" [title]="meta[r.agent].name"><tg-agent-avatar [agent]="r.agent" [size]="16" /></span></td>
                  <td class="ellipsis prompt-cell" [title]="r.prompt">{{ r.prompt }}</td>
                  <td class="num mono">{{ tok(tokens(r)) }}</td>
                  <td class="num mono dim">{{ tok(r.usage?.inputTokens ?? 0) }}</td>
                  <td class="num mono dim">{{ tok(r.usage?.cachedInputTokens ?? 0) }}</td>
                  <td class="num mono dim">{{ tok(r.usage?.outputTokens ?? 0) }}</td>
                  <td class="num mono" [class.cost-hi]="isTop(r)">{{ usd(costRow(r).usd) }}<span class="cost-src" [attr.data-src]="costRow(r).source" [title]="sourceLabel[costRow(r).source]"></span></td>
                </tr>
              } @empty {
                <tr><td colspan="8" class="dim">{{ rows().length ? 'Không có lượt nào khớp bộ lọc.' : 'Chưa có lượt chạy nào trong khoảng này.' }}</td></tr>
              }
            </tbody>
          </table>
          @if (filtered().length > shown()) {
            <div class="cost-more"><button class="btn sm" (click)="shown.set(shown() + 50)">Xem thêm {{ min(50, filtered().length - shown()) }} lượt</button><span class="dim">còn {{ filtered().length - shown() }} lượt · CSV có đủ</span></div>
          }
        </div>
        <div class="cost-legend">
          <span><span class="cost-src" data-src="reported"></span>CLI báo</span>
          <span><span class="cost-src" data-src="estimated"></span>Ước tính theo bảng giá</span>
          <span><span class="cost-src" data-src="unpriced"></span>Chưa có giá</span>
          <span class="spacer"></span>
          <span>Bấm một dòng để mở cuộc trò chuyện</span>
        </div>
      </section>

      <button class="pg-card cost-settings" (click)="sheet.set(true)" aria-label="Mở giá và ngân sách">
        <span class="pg-card-head"><h2>Giá &amp; ngân sách</h2><span class="dim">bấm để chỉnh</span></span>
        <span class="cost-minis">
          <span class="cost-mini"><span class="faint">Ngân sách</span>{{ budgetSummary() }}</span>
          @for (a of agentIds; track a) {
            <span class="cost-mini">
              <span class="faint">{{ meta[a].name }}@if (current(a); as p) { · từ {{ shortDate(p.fromMs) }} }</span>
              @if (current(a); as p) { <span class="mono">{{ priceText(p.input) }} · {{ priceText(p.cachedInput) }} · {{ priceText(p.output) }}</span> }
              @else if (a === 'claude') { CLI tự báo chi phí }
              @else if (unpricedBy()[a]; as n) { <span class="cost-warn">Chưa có giá · {{ n }} lượt</span> }
              @else { <span class="dim">Chưa có giá</span> }
            </span>
          }
        </span>
      </button>
    </div>

    @if (sheet()) {
      <div class="sheet-backdrop" (click)="sheet.set(false)">
        <aside class="sheet cost-sheet" role="dialog" aria-modal="true" aria-label="Giá và ngân sách" (click)="$event.stopPropagation()">
          <div class="sheet-head"><h3>Giá &amp; ngân sách</h3><span class="spacer"></span><button class="icon-btn" aria-label="Đóng" (click)="sheet.set(false)">✕</button></div>
          @if (error()) { <p class="error-text" role="alert">{{ error() }}</p> }

          <h4 class="cost-sheet-h">Ngân sách</h4>
          <div class="cost-two">
            <label class="field"><span>Mỗi task (USD)</span><input type="number" min="0" step="0.5" [value]="budget.budgets().perTask ?? ''" (input)="draftTask.set($any($event.target).value)" placeholder="không giới hạn" /></label>
            <label class="field"><span>Mỗi ngày (USD)</span><input type="number" min="0" step="1" [value]="budget.budgets().daily ?? ''" (input)="draftDaily.set($any($event.target).value)" placeholder="không giới hạn" /></label>
          </div>
          <div class="row-end"><button class="btn primary sm" [disabled]="busy()" (click)="saveBudgets()">Lưu ngân sách</button></div>
          <p class="dim form-note">Vượt mức mỗi task thì run đó bị dừng; chạm mức ngày thì mọi run dừng và không giao việc mới được. Agent thường báo chi phí khi xong, nên việc dừng chỉ xảy ra khi đã có số.</p>

          <h4 class="cost-sheet-h">Bảng giá · USD / 1M token</h4>
          @for (a of agentIds; track a) {
            <div class="price-row">
              <div class="price-title"><tg-agent-avatar [agent]="a" [size]="14" />{{ meta[a].name }}
                <span class="spacer"></span>
                @if (current(a); as p) { <span class="dim">từ {{ date(p.fromMs) }}</span> }
              </div>
              @if (a === 'claude') { <p class="dim form-note">Claude Code tự báo chi phí; bảng giá chỉ dùng khi không có số báo.</p> }
              <div class="price-inputs">
                <label class="field"><span>Input</span><input type="number" min="0" step="0.01" [value]="current(a)?.input ?? ''" (input)="draft(a, 'input', $any($event.target).value)" /></label>
                <label class="field"><span>Cache</span><input type="number" min="0" step="0.01" [value]="current(a)?.cachedInput ?? ''" (input)="draft(a, 'cachedInput', $any($event.target).value)" /></label>
                <label class="field"><span>Output</span><input type="number" min="0" step="0.01" [value]="current(a)?.output ?? ''" (input)="draft(a, 'output', $any($event.target).value)" /></label>
                <button class="btn ghost sm" [disabled]="busy() || !drafts()[a]" (click)="savePrice(a)">Áp dụng</button>
              </div>
            </div>
          }
          <label class="check-line"><input type="checkbox" [checked]="backfill()" (change)="backfill.set($any($event.target).checked)" /> Áp dụng cho cả các lượt trước (chỉ những lượt chưa có giá nào)</label>
          <p class="dim form-note">Mặc định giá mới áp dụng từ lúc bấm; các lượt cũ giữ giá lúc chúng chạy. Để trống cả ba ô rồi Áp dụng để bỏ giá.</p>
        </aside>
      </div>
    }
  `,
})
export class UsageScreen {
  private readonly backend = inject(AgentBackend);
  private readonly runs = inject(RunsService);
  private readonly ui = inject(UiService);
  protected readonly budget = inject(BudgetService);
  protected readonly meta = AGENT_META;
  protected readonly agentIds = AGENT_IDS;
  protected readonly ranges = [7, 30, 90];
    protected readonly tok = fmtTokens;
  protected readonly usd = fmtUsd;
  protected readonly tokens = tokensOf;
  protected readonly round = Math.round;
  protected readonly min = Math.min;
  protected readonly sourceLabel = { reported: 'CLI báo', estimated: 'Ước tính theo bảng giá', unpriced: 'Chưa có giá', none: 'Không có số liệu' };

  protected readonly days = signal(30);
  protected readonly measure = signal<Measure>('cost');
  /** Runs of the range and of the period before it, so the KPIs can compare. */
  private readonly loaded = signal<UsageRow[]>([]);
  protected readonly hover = signal<number | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly sheet = signal(false);
  protected readonly backfill = signal(false);
  protected readonly draftTask = signal<string | null>(null);
  protected readonly draftDaily = signal<string | null>(null);
  protected readonly drafts = signal<Partial<Record<AgentId, { input?: string; cachedInput?: string; output?: string }>>>({});
  protected readonly agent = signal<AgentId | null>(null);
  protected readonly day = signal<number | null>(null);
  protected readonly query = signal('');
  protected readonly sort = signal<SortKey>('time');

  /** Moves at midnight, so "today" stays right on a screen left open overnight. */
  protected readonly today = signal(startOfDay(Date.now()));
  private readonly rangeStart = computed(() => this.dayAgo(this.days() - 1));

  protected readonly rows = computed(() => this.loaded().filter((r) => r.startedAt >= this.rangeStart()));
  private readonly prevRows = computed(() => {
    const from = this.dayAgo(2 * this.days() - 1);
    return this.loaded().filter((r) => r.startedAt >= from && r.startedAt < this.rangeStart());
  });

  protected readonly totals = computed(() => (PRICE_HISTORY(), totalsOf(this.rows())));
  protected readonly costChange = computed(() => {
    PRICE_HISTORY();
    const prev = totalsOf(this.prevRows()).cost;
    const pct = changePct(this.totals().cost, prev);
    return pct === null ? null : { pct, prev };
  });
  protected readonly cachePct = computed(() => {
    const t = this.totals();
    return t.tokens ? Math.round((t.cached / t.tokens) * 100) : 0;
  });
  private readonly costDays = computed(() => (PRICE_HISTORY(), this.today(), dailyBuckets(this.rows(), this.days(), 'cost')));
  protected readonly costSpark = computed(() => sparkPath(this.costDays().map((d) => d.total), 200, 26));
  protected readonly runSpark = computed(() => sparkPath(this.costDays().map((d) => d.runs), 200, 26));

  protected readonly shares = computed(() => (PRICE_HISTORY(), agentShares(this.rows())));
  protected readonly unpricedBy = computed(() => {
    PRICE_HISTORY();
    const out: Partial<Record<AgentId, number>> = {};
    for (const r of this.loaded()) if (r.usage && costOf(r.agent, r.usage, r.startedAt).usd === null) out[r.agent] = (out[r.agent] ?? 0) + 1;
    return out;
  });

  protected readonly filtered = computed(() => {
    PRICE_HISTORY();
    return sortRows(filterRows(this.rows(), { agent: this.agent(), day: this.day(), query: this.query() }), this.sort());
  });
  protected readonly shown = signal(PAGE);
  protected readonly tableRows = computed(() => this.filtered().slice(0, this.shown()));
  /** The three most expensive runs get a highlight, once there are enough to tell apart. */
  private readonly topIds = computed(() => {
    PRICE_HISTORY();
    if (this.filtered().length <= 3) return new Set<string>();
    return new Set(sortRows(this.filtered(), 'cost').slice(0, 3).filter((r) => (costOf(r.agent, r.usage, r.startedAt).usd ?? 0) > 0).map((r) => r.id));
  });
  /** Runs still in the conversation list; deleted ones keep their cost but cannot be opened. */
  protected readonly openable = computed(() => new Set(this.runs.runs().map((r) => r.id)));
  protected readonly labelEvery = computed(() => Math.max(1, Math.ceil(this.days() / 8)));

  protected readonly chart = computed(() => {
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

  protected readonly chartLabel = computed(() => {
    const peak = [...this.chart().days].sort((a, b) => b.total - a.total)[0];
    return `${this.measure() === 'cost' ? 'Chi phí' : 'Token'} theo ngày trong ${this.days()} ngày${peak?.total ? `; cao nhất ${peak.label}: ${this.fmt(peak.total)}` : ''}. Số liệu đầy đủ ở bảng bên dưới.`;
  });

  protected readonly budgetSummary = computed(() => {
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

  protected setDays(d: number): void {
    this.days.set(d);
    if (this.day() !== null && this.day()! < this.dayAgo(d - 1)) this.day.set(null);
  }

  protected toggleDay(start: number): void {
    this.day.update((d) => (d === start ? null : start));
  }

  protected toggleAgent(a: AgentId): void {
    this.agent.update((x) => (x === a ? null : a));
  }

  protected open(r: UsageRow): void {
    if (this.openable().has(r.id)) this.ui.openRun(r.id);
  }

  protected isTop(r: UsageRow): boolean {
    return this.topIds().has(r.id);
  }

  protected fmt(v: number): string {
    return this.measure() === 'cost' ? fmtUsd(v) : `${fmtTokens(v)} tok`;
  }

  protected pctText(p: number): string {
    const a = Math.abs(p);
    return `${a < 10 ? a.toFixed(1).replace(/\.0$/, '') : Math.round(a)}%`;
  }

  protected ringDash(limit: number): string {
    const used = Math.min(1, limit > 0 ? this.budget.todayCost() / limit : 0);
    return `${(used * RING).toFixed(1)} ${RING.toFixed(1)}`;
  }

  protected todayLeft(limit: number): string {
    const spent = this.budget.todayCost();
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
    return spent >= limit ? `vượt ${fmtUsd(spent - limit)} · ${pct}%` : `còn ${fmtUsd(limit - spent)} · ${pct}%`;
  }

  protected dayLabel(d: DayBucket): string {
    return `${d.label}: ${d.segments.map((s) => `${AGENT_META[s.agent].name} ${this.fmt(s.value)}`).join(', ') || 'không có'}. Bấm để lọc bảng.`;
  }

  protected dayText(ms: number): string {
    const d = new Date(ms);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }

  protected costRow(r: UsageRow) {
    PRICE_HISTORY();
    return costOf(r.agent, r.usage, r.startedAt);
  }

  protected current(agent: AgentId) {
    PRICE_HISTORY();
    const p = priceAt(agent, Date.now());
    return p && (p.input !== null || p.cachedInput !== null || p.output !== null) ? p : null;
  }

  protected priceText(v: number | null): string {
    return v === null ? '—' : `$${v}`;
  }

  protected when(ms: number): string {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(ms);
  }

  protected date(ms: number): string {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(ms);
  }

  protected shortDate(ms: number): string {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit' }).format(ms);
  }

  protected draft(agent: AgentId, field: 'input' | 'cachedInput' | 'output', value: string): void {
    this.drafts.update((d) => ({ ...d, [agent]: { ...d[agent], [field]: value } }));
  }

  protected async savePrice(agent: AgentId): Promise<void> {
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

  protected async saveBudgets(): Promise<void> {
    const parse = (raw: string | null, fallback: number | null) => (raw === null ? fallback : raw.trim() === '' ? null : Number(raw));
    await this.guard(() => this.budget.saveBudgets({
      perTask: parse(this.draftTask(), this.budget.budgets().perTask),
      daily: parse(this.draftDaily(), this.budget.budgets().daily),
    }));
  }

  protected async exportCsv(): Promise<void> {
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
  }
}
