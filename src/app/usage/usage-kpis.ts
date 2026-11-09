import { Component, inject } from '@angular/core';
import { UsageState } from './usage.state';

/** Totals of the range against the period before, and today against the daily budget. */
@Component({
  selector: 'tg-usage-kpis',
  imports: [],
  template: `
<section class="cost-kpis" aria-label="Tổng quan">
  <div class="pg-card cost-kpi cost-hero">
    <span class="cost-k">Tổng chi phí · {{ use.days() }} ngày</span>
    <strong class="cost-v">{{ use.usd(use.totals().cost) }}</strong>
    @if (use.costChange(); as c) {
      <span class="cost-delta" [attr.data-dir]="c.pct >= 0 ? 'up' : 'down'">{{ c.pct >= 0 ? '▲' : '▼' }} {{ use.pctText(c.pct) }} so với {{ use.days() }} ngày trước <span class="faint">({{ use.usd(c.prev) }})</span></span>
    } @else if (use.totals().unpriced) {
      <span class="dim cost-delta">{{ use.totals().unpriced }} lượt chưa có giá</span>
    } @else {
      <span class="dim cost-delta">Chưa có kỳ trước để so</span>
    }
    <svg class="cost-spark" viewBox="0 0 200 26" preserveAspectRatio="none" aria-hidden="true">
      <path [attr.d]="use.costSpark() + (use.costSpark() ? ' L200 26 L0 26 Z' : '')" class="area" />
      <path [attr.d]="use.costSpark()" class="line" />
    </svg>
  </div>
  <div class="pg-card cost-kpi">
    <span class="cost-k">Token</span>
    <strong class="cost-v">{{ use.tok(use.totals().tokens) }}</strong>
    <span class="dim cost-delta">{{ use.cachePct() }}% đọc từ cache</span>
    <div class="cost-track" aria-hidden="true"><i [style.width.%]="use.cachePct()"></i></div>
  </div>
  <div class="pg-card cost-kpi">
    <span class="cost-k">Lượt chạy</span>
    <strong class="cost-v">{{ use.rows().length }}</strong>
    <span class="dim cost-delta">TB {{ use.usd(use.totals().runs ? use.totals().cost / use.totals().runs : null) }} / lượt</span>
    <svg class="cost-spark" viewBox="0 0 200 26" preserveAspectRatio="none" aria-hidden="true"><path [attr.d]="use.runSpark()" class="line dim-line" /></svg>
  </div>
  <div class="pg-card cost-kpi" [attr.data-level]="use.budget.dailyLevel()">
    <span class="cost-k">Hôm nay</span>
    @if (use.budget.budgets().daily; as limit) {
      <div class="cost-ring-wrap">
        <svg class="cost-ring" viewBox="0 0 36 36" role="meter" aria-label="Chi phí hôm nay so với ngân sách ngày" aria-valuemin="0" [attr.aria-valuemax]="limit" [attr.aria-valuenow]="use.budget.todayCost()">
          <circle cx="18" cy="18" r="15" class="ring-bg" />
          <circle cx="18" cy="18" r="15" class="ring-fg" [attr.stroke-dasharray]="use.ringDash(limit)" transform="rotate(-90 18 18)" />
        </svg>
        <div>
          <strong class="cost-v sm">{{ use.usd(use.budget.todayCost()) }}</strong>
          <div class="dim cost-delta">/ {{ use.usd(limit) }} ngân sách ngày</div>
          <div class="cost-left">{{ use.todayLeft(limit) }}</div>
        </div>
      </div>
    } @else {
      <strong class="cost-v">{{ use.usd(use.budget.todayCost()) }}</strong>
      <button class="link cost-delta" (click)="use.sheet.set(true)">Đặt ngân sách ngày</button>
    }
  </div>
</section>
  `,
})
export class UsageKpis {
  protected readonly use = inject(UsageState);
}
