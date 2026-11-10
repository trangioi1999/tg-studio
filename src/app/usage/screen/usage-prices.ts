import { Component, inject } from '@angular/core';
import { UsageState } from './usage.state';

/** The summary card of prices and budgets; it opens the sheet. */
@Component({
  selector: 'tg-usage-prices',
  imports: [],
  template: `
<button class="pg-card cost-settings" (click)="use.sheet.set(true)" aria-label="Mở giá và ngân sách">
  <span class="pg-card-head"><h2>Giá &amp; ngân sách</h2><span class="dim">bấm để chỉnh</span></span>
  <span class="cost-minis">
    <span class="cost-mini"><span class="faint">Ngân sách</span>{{ use.budgetSummary() }}</span>
    @for (a of use.agentIds; track a) {
      <span class="cost-mini">
        <span class="faint">{{ use.meta[a].name }}@if (use.current(a); as p) { · từ {{ use.shortDate(p.fromMs) }} }</span>
        @if (use.current(a); as p) { <span class="mono">{{ use.priceText(p.input) }} · {{ use.priceText(p.cachedInput) }} · {{ use.priceText(p.output) }}</span> }
        @else if (a === 'claude') { CLI tự báo chi phí }
        @else if (use.unpricedBy()[a]; as n) { <span class="cost-warn">Chưa có giá · {{ n }} lượt</span> }
        @else { <span class="dim">Chưa có giá</span> }
      </span>
    }
  </span>
</button>
  `,
})
export class UsagePrices {
  protected readonly use = inject(UsageState);
}
