import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { AgentBackend } from '../core/backend';
import { BudgetService } from '../core/budget.service';
import { fmtTokens, fmtUsd } from '../core/format';
import { PRICE_HISTORY, costOf, priceAt } from '../core/pricing';
import { AGENT_IDS, AGENT_META, AgentId, UsageRow } from '../core/protocol';
import { RunsService } from '../core/runs.service';
import { AgentAvatar } from './agent-avatar';
import { UsagePanel } from './usage-panel';

type Measure = 'cost' | 'tokens';

interface Day {
  key: string;
  label: string;
  total: number;
  segments: { agent: AgentId; value: number; pct: number }[];
}

const DAY = 86_400_000;
const TABLE_LIMIT = 200;

/** Usage ledger: KPIs, a daily chart by agent, prices, budgets and every run, with CSV export. */
@Component({
  selector: 'tg-usage-screen',
  imports: [AgentAvatar, UsagePanel],
  template: `
    <div class="usage-page">
      <div class="usage-main-col">
        <header class="usage-head">
          <h1>Chi phí</h1>
          <div class="segmented" role="group" aria-label="Khoảng thời gian">
            @for (d of ranges; track d) {
              <button [class.active]="days() === d" [attr.aria-pressed]="days() === d" (click)="days.set(d)">{{ d }} ngày</button>
            }
          </div>
          <span class="spacer"></span>
          @if (saved()) { <span class="dim ellipsis" role="status">Đã lưu {{ saved() }}</span> }
          <button class="btn ghost sm" [disabled]="!rows().length" (click)="exportCsv()">Xuất CSV</button>
        </header>
        @if (error()) { <p class="error-text" role="alert">{{ error() }}</p> }

        <section class="kpis" aria-label="Tổng quan">
          <div class="kpi"><span class="label">CHI PHÍ</span><strong>{{ usd(totals().cost) }}</strong>
            @if (totals().unpriced) { <span class="dim kpi-note">{{ totals().unpriced }} lượt chưa có giá</span> }
          </div>
          <div class="kpi"><span class="label">TOKEN</span><strong>{{ tok(totals().tokens) }}</strong></div>
          <div class="kpi"><span class="label">LƯỢT CHẠY</span><strong>{{ rows().length }}</strong></div>
          <div class="kpi"><span class="label">TB / LƯỢT</span><strong>{{ usd(totals().avg) }}</strong></div>
          <div class="kpi" [class.attention]="budget.dailyLevel() === 'warn' || budget.dailyLevel() === 'over'">
            <span class="label">HÔM NAY</span><strong>{{ usd(budget.todayCost()) }}</strong>
            @if (budget.budgets().daily; as d) { <span class="dim kpi-note">/ {{ usd(d) }} ngân sách</span> }
          </div>
        </section>

        <section class="mission-block chart-block" aria-label="Biểu đồ theo ngày">
          <div class="block-head">
            <span class="label">THEO NGÀY · {{ measure() === 'cost' ? 'CHI PHÍ (USD)' : 'TOKEN' }}</span>
            <span class="spacer"></span>
            <div class="legend-row" aria-label="Chú giải">
              @for (a of agentsInRange(); track a) {
                <span class="legend"><i [style.background]="meta[a].chart"></i>{{ meta[a].name }}</span>
              }
            </div>
            <div class="segmented" role="group" aria-label="Đơn vị">
              <button [class.active]="measure() === 'cost'" [attr.aria-pressed]="measure() === 'cost'" (click)="measure.set('cost')">Chi phí</button>
              <button [class.active]="measure() === 'tokens'" [attr.aria-pressed]="measure() === 'tokens'" (click)="measure.set('tokens')">Token</button>
            </div>
          </div>
          @if (chart().max > 0) {
            <div class="chart" role="img" [attr.aria-label]="chartLabel()">
              <div class="chart-grid" aria-hidden="true">
                @for (t of chart().ticks; track t.value) {
                  <div class="tick" [style.bottom.%]="t.pct"><span class="mono">{{ t.label }}</span></div>
                }
              </div>
              <div class="bars">
                @for (d of chart().days; track d.key; let i = $index) {
                  <div class="day" (mouseenter)="hover.set(i)" (mouseleave)="hover.set(null)" (focus)="hover.set(i)" (blur)="hover.set(null)" tabindex="0" [attr.aria-label]="dayLabel(d)">
                    <div class="stack" [style.height.%]="chart().max ? (d.total / chart().max) * 100 : 0">
                      @for (s of d.segments; track s.agent) {
                        <span class="seg" [style.flex-grow]="s.pct" [style.background]="meta[s.agent].chart"></span>
                      }
                    </div>
                    @if (hover() === i) {
                      <div class="tip" role="tooltip" [class.flip]="i > chart().days.length * 0.66">
                        <strong>{{ d.label }}</strong>
                        @for (s of d.segments; track s.agent) {
                          <div class="tip-row"><i [style.background]="meta[s.agent].chart"></i>{{ meta[s.agent].name }}<span class="spacer"></span><span class="mono">{{ fmt(s.value) }}</span></div>
                        }
                        <div class="tip-row tip-total">Tổng<span class="spacer"></span><span class="mono">{{ fmt(d.total) }}</span></div>
                      </div>
                    }
                  </div>
                }
              </div>
              <div class="x-labels" aria-hidden="true">
                @for (d of chart().days; track d.key; let i = $index) {
                  <span>{{ i % labelEvery() === 0 || i === chart().days.length - 1 ? d.label : '' }}</span>
                }
              </div>
            </div>
          } @else {
            <p class="dim pad">{{ measure() === 'cost' ? 'Chưa có chi phí trong khoảng này. Chuyển sang Token, hoặc điền bảng giá bên dưới để ước tính.' : 'Chưa có lượt chạy nào trong khoảng này.' }}</p>
          }
        </section>

        <section class="mission-block" aria-label="Các lượt chạy">
          <div class="block-head"><span class="label">CÁC LƯỢT CHẠY</span><span class="dim">{{ rows().length }}</span></div>
          <div class="table-wrap">
            <table class="runs-table">
              <thead><tr><th>Thời gian</th><th>Agent</th><th>Yêu cầu</th><th class="num">Input</th><th class="num">Cache</th><th class="num">Output</th><th class="num">Chi phí</th></tr></thead>
              <tbody>
                @for (r of tableRows(); track r.id) {
                  <tr>
                    <td class="mono">{{ when(r.startedAt) }}</td>
                    <td><span class="cell-agent"><tg-agent-avatar [agent]="r.agent" [size]="14" />{{ meta[r.agent].name }}</span></td>
                    <td class="ellipsis prompt-cell" [title]="r.prompt">{{ r.prompt }}</td>
                    <td class="num mono">{{ tok(r.usage?.inputTokens ?? 0) }}</td>
                    <td class="num mono">{{ tok(r.usage?.cachedInputTokens ?? 0) }}</td>
                    <td class="num mono">{{ tok(r.usage?.outputTokens ?? 0) }}</td>
                    <td class="num mono">{{ usd(costRow(r).usd) }} <span class="src" [attr.data-src]="costRow(r).source">{{ sourceLabel[costRow(r).source] }}</span></td>
                  </tr>
                } @empty {
                  <tr><td colspan="7" class="dim">Chưa có lượt chạy nào trong khoảng này.</td></tr>
                }
              </tbody>
            </table>
            @if (rows().length > tableLimit) { <p class="dim pad">Chỉ hiện {{ tableLimit }} lượt gần nhất; CSV có đủ {{ rows().length }} lượt.</p> }
          </div>
        </section>
      </div>

      <aside class="usage-side">
        <section class="mission-block" aria-label="Ngân sách">
          <div class="block-head"><span class="label">NGÂN SÁCH</span></div>
          <div class="form-grid">
            <label class="field"><span>Mỗi task (USD)</span><input type="number" min="0" step="0.5" [value]="budget.budgets().perTask ?? ''" (input)="draftTask.set($any($event.target).value)" placeholder="không giới hạn" /></label>
            <label class="field"><span>Mỗi ngày (USD)</span><input type="number" min="0" step="1" [value]="budget.budgets().daily ?? ''" (input)="draftDaily.set($any($event.target).value)" placeholder="không giới hạn" /></label>
            <button class="btn primary sm" [disabled]="busy()" (click)="saveBudgets()">Lưu ngân sách</button>
            <p class="dim form-note">Vượt mức mỗi task thì run đó bị dừng; chạm mức ngày thì mọi run dừng và không giao việc mới được. Agent thường báo chi phí khi xong, nên việc dừng chỉ xảy ra khi đã có số.</p>
          </div>
        </section>

        <section class="mission-block" aria-label="Bảng giá">
          <div class="block-head"><span class="label">BẢNG GIÁ · USD / 1M TOKEN</span></div>
          <div class="price-list">
            @for (a of agentIds; track a) {
              <div class="price-row">
                <div class="price-title"><tg-agent-avatar [agent]="a" [size]="14" />{{ meta[a].name }}
                  <span class="spacer"></span>
                  @if (current(a); as p) { <span class="dim">từ {{ date(p.fromMs) }}</span> }
                </div>
                @if (a === 'claude') {
                  <p class="dim form-note">Claude Code tự báo chi phí; bảng giá chỉ dùng khi không có số báo.</p>
                }
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
          </div>
        </section>

        <tg-usage-panel class="usage-side-panel" />
      </aside>
    </div>
  `,
})
export class UsageScreen {
  private readonly backend = inject(AgentBackend);
  private readonly runs = inject(RunsService);
  protected readonly budget = inject(BudgetService);
  protected readonly meta = AGENT_META;
  protected readonly agentIds = AGENT_IDS;
  protected readonly ranges = [7, 30, 90];
  protected readonly tableLimit = TABLE_LIMIT;
  protected readonly tok = fmtTokens;
  protected readonly usd = fmtUsd;
  protected readonly sourceLabel = { reported: 'reported', estimated: 'estimated', unpriced: 'chưa có giá', none: '' };

  protected readonly days = signal(30);
  protected readonly measure = signal<Measure>('cost');
  protected readonly rows = signal<UsageRow[]>([]);
  protected readonly hover = signal<number | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly backfill = signal(false);
  protected readonly draftTask = signal<string | null>(null);
  protected readonly draftDaily = signal<string | null>(null);
  protected readonly drafts = signal<Partial<Record<AgentId, { input?: string; cachedInput?: string; output?: string }>>>({});

  protected readonly tableRows = computed(() => this.rows().slice(0, TABLE_LIMIT));
  protected readonly agentsInRange = computed(() => AGENT_IDS.filter((a) => this.rows().some((r) => r.agent === a)));
  protected readonly labelEvery = computed(() => Math.max(1, Math.ceil(this.days() / 8)));

  protected readonly totals = computed(() => {
    PRICE_HISTORY();
    let cost = 0;
    let tokens = 0;
    let unpriced = 0;
    for (const r of this.rows()) {
      const c = costOf(r.agent, r.usage, r.startedAt);
      if (c.usd !== null) cost += c.usd;
      else if (r.usage) unpriced++;
      if (r.usage) tokens += r.usage.inputTokens + r.usage.cachedInputTokens + r.usage.outputTokens;
    }
    return { cost, tokens, unpriced, avg: this.rows().length ? cost / this.rows().length : null };
  });

  protected readonly chart = computed(() => {
    PRICE_HISTORY();
    const measure = this.measure();
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const days: Day[] = [];
    const index = new Map<string, Day>();
    for (let i = this.days() - 1; i >= 0; i--) {
      const d = new Date(end.getTime() - i * DAY);
      const key = d.toDateString();
      const day: Day = { key, label: `${d.getDate()}/${d.getMonth() + 1}`, total: 0, segments: [] };
      days.push(day);
      index.set(key, day);
    }
    for (const r of this.rows()) {
      const day = index.get(new Date(r.startedAt).toDateString());
      if (!day || !r.usage) continue;
      const value = measure === 'cost' ? (costOf(r.agent, r.usage, r.startedAt).usd ?? 0) : r.usage.inputTokens + r.usage.cachedInputTokens + r.usage.outputTokens;
      if (!value) continue;
      const seg = day.segments.find((s) => s.agent === r.agent);
      if (seg) seg.value += value;
      else day.segments.push({ agent: r.agent, value, pct: 0 });
      day.total += value;
    }
    // Fixed agent order in every bar, so a colour always sits in the same place. Shares
    // sum to 100: flex-grow below 1 in total would leave part of the bar empty.
    for (const d of days) {
      d.segments.sort((a, b) => AGENT_IDS.indexOf(a.agent) - AGENT_IDS.indexOf(b.agent));
      for (const s of d.segments) s.pct = (s.value / d.total) * 100;
    }
    const max = niceMax(Math.max(0, ...days.map((d) => d.total)));
    const ticks = max ? [0.5, 1].map((f) => ({ value: max * f, pct: f * 100, label: measure === 'cost' ? fmtUsd(max * f) : fmtTokens(max * f) })) : [];
    return { days, max, ticks };
  });

  protected readonly chartLabel = computed(() => {
    const peak = [...this.chart().days].sort((a, b) => b.total - a.total)[0];
    return `${this.measure() === 'cost' ? 'Chi phí' : 'Token'} theo ngày trong ${this.days()} ngày${peak?.total ? `; cao nhất ${peak.label}: ${this.fmt(peak.total)}` : ''}. Số liệu đầy đủ ở bảng bên dưới.`;
  });

  constructor() {
    // Reload when the range changes and whenever a run ends.
    effect(() => {
      const days = this.days();
      this.runs.runs().filter((r) => r.status !== 'running').length;
      untracked(() => void this.load(days));
    });
  }

  private async load(days: number): Promise<void> {
    try {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      this.rows.set(await this.backend.usageReport(since.getTime() - (days - 1) * DAY));
      this.error.set(null);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  protected fmt(v: number): string {
    return this.measure() === 'cost' ? fmtUsd(v) : `${fmtTokens(v)} tok`;
  }

  protected dayLabel(d: Day): string {
    return `${d.label}: ${d.segments.map((s) => `${AGENT_META[s.agent].name} ${this.fmt(s.value)}`).join(', ') || 'không có'}`;
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

  protected when(ms: number): string {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(ms);
  }

  protected date(ms: number): string {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(ms);
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
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }
}

/** Rounds the axis top up to 1, 2 or 5 × 10ⁿ so the gridlines read cleanly. */
export function niceMax(v: number): number {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

/** One line per run; cost columns say where the number came from. */
export function toCsv(rows: UsageRow[]): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['started_at', 'agent', 'status', 'prompt', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'cost_usd', 'cost_source'];
  const lines = rows.map((r) => {
    const c = costOf(r.agent, r.usage, r.startedAt);
    return [new Date(r.startedAt).toISOString(), r.agent, r.status, r.prompt, r.usage?.inputTokens ?? 0, r.usage?.cachedInputTokens ?? 0, r.usage?.outputTokens ?? 0,
      c.usd === null ? null : c.usd.toFixed(6), c.source].map(cell).join(',');
  });
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}
