import { Component, inject } from '@angular/core';
import { UsageByAgent } from './usage-by-agent';
import { UsageChart } from './usage-chart';
import { UsageKpis } from './usage-kpis';
import { UsagePanel } from './usage-panel';
import { UsagePriceSheet } from './usage-price-sheet';
import { UsagePrices } from './usage-prices';
import { UsageRuns } from './usage-runs';
import { UsageState } from './usage.state';

/** Usage ledger: KPIs against the previous period, a daily chart, spend per agent, plan limits and every run. */
@Component({
  selector: 'tg-usage-screen',
  imports: [UsageByAgent, UsageChart, UsageKpis, UsagePanel, UsagePriceSheet, UsagePrices, UsageRuns],
  providers: [UsageState],
  host: { '(document:keydown.escape)': 'use.sheet.set(false)' },
  template: `
<div class="cost-page">
  <header class="pg-head">
    <div><h1>Chi phí</h1><p>Token và tiền đã dùng cho mọi agent, tính theo giá lúc lượt chạy bắt đầu.</p></div>
    <span class="spacer"></span>
    <div class="segmented" role="group" aria-label="Khoảng thời gian">
      @for (d of use.ranges; track d) {
        <button [class.active]="use.days() === d" [attr.aria-pressed]="use.days() === d" (click)="use.setDays(d)">{{ d }} ngày</button>
      }
    </div>
    <button class="btn sm" (click)="use.sheet.set(true)">Giá &amp; ngân sách</button>
    <button class="btn sm" [disabled]="!use.rows().length" (click)="use.exportCsv()">Xuất CSV</button>
  </header>
  @if (use.error()) { <p class="error-text" role="alert">{{ use.error() }}</p> }
  @if (use.saved()) { <p class="dim cost-saved ellipsis" role="status">Đã lưu {{ use.saved() }}</p> }

  <tg-usage-kpis />

  <div class="cost-grid">
    <tg-usage-chart />

    <div class="cost-side">
      <tg-usage-by-agent />
      <tg-usage-panel />
    </div>
  </div>

  <tg-usage-runs />
  <tg-usage-prices />
</div>
<tg-usage-price-sheet />
  `,
})
export class UsageScreen {
  protected readonly use = inject(UsageState);
}
