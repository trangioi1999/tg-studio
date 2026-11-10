import { Component, inject } from '@angular/core';
import { UsageState } from './usage.state';

/** Cost or tokens per day; a day picked filters the runs below. */
@Component({
  selector: 'tg-usage-chart',
  imports: [],
  template: `
<section class="pg-card cost-chart-card" aria-label="Biểu đồ theo ngày">
  <div class="pg-card-head">
    <h2>Theo ngày</h2>
    @if (use.agent(); as a) { <span class="dim">chỉ {{ use.meta[a].name }}</span> }
    @if (use.day() !== null) { <span class="dim">bấm cột lần nữa để bỏ lọc</span> }
    <span class="spacer"></span>
    <div class="segmented" role="group" aria-label="Đơn vị">
      <button [class.active]="use.measure() === 'cost'" [attr.aria-pressed]="use.measure() === 'cost'" (click)="use.measure.set('cost')">Chi phí</button>
      <button [class.active]="use.measure() === 'tokens'" [attr.aria-pressed]="use.measure() === 'tokens'" (click)="use.measure.set('tokens')">Token</button>
    </div>
  </div>
  @if (use.chart().max > 0) {
    <div class="chart cost-chart" role="img" [attr.aria-label]="use.chartLabel()">
      <div class="chart-grid" aria-hidden="true">
        @for (t of use.chart().ticks; track t.value) {
          <div class="tick" [style.bottom.%]="t.pct"><span class="mono">{{ t.label }}</span></div>
        }
        @if (use.chart().budget; as b) {
          <div class="cost-budget-line" [style.bottom.%]="b.pct"><span>ngân sách ngày {{ use.usd(b.value) }}</span></div>
        }
      </div>
      <div class="bars">
        @for (d of use.chart().days; track d.start; let i = $index) {
          <div class="day" tabindex="0" role="button" [class.today]="d.start === use.today()" [class.sel]="d.start === use.day()"
               [attr.aria-pressed]="d.start === use.day()" [attr.aria-label]="use.dayLabel(d)"
               (mouseenter)="use.hover.set(i)" (mouseleave)="use.hover.set(null)" (focus)="use.hover.set(i)" (blur)="use.hover.set(null)"
               (click)="use.toggleDay(d.start)" (keydown.enter)="use.toggleDay(d.start)" (keydown.space)="$event.preventDefault(); use.toggleDay(d.start)">
            <div class="stack" [style.height.%]="(d.total / use.chart().max) * 100">
              @for (s of d.segments; track s.agent) {
                <span class="seg" [style.flex-grow]="s.pct" [style.background]="use.meta[s.agent].chart"></span>
              }
            </div>
            @if (use.hover() === i) {
              <div class="tip" role="tooltip" [class.flip]="i > use.chart().days.length * 0.66">
                <strong>{{ d.label }} <span class="dim">· {{ d.runs }} lượt</span></strong>
                @for (s of d.segments; track s.agent) {
                  <div class="tip-row"><i [style.background]="use.meta[s.agent].chart"></i>{{ use.meta[s.agent].name }}<span class="spacer"></span><span class="mono">{{ use.fmt(s.value) }}</span></div>
                }
                <div class="tip-row tip-total">Tổng<span class="spacer"></span><span class="mono">{{ use.fmt(d.total) }}</span></div>
                <span class="faint cost-tip-hint">Bấm để lọc bảng theo ngày này</span>
              </div>
            }
          </div>
        }
      </div>
      <div class="x-labels" aria-hidden="true">
        @for (d of use.chart().days; track d.start; let i = $index) {
          <span [class.cost-x-today]="d.start === use.today()">{{ i % use.labelEvery() === 0 || i === use.chart().days.length - 1 ? d.label : '' }}</span>
        }
      </div>
    </div>
  } @else {
    <p class="dim pad">{{ use.measure() === 'cost' ? 'Chưa có chi phí trong khoảng này. Chuyển sang Token, hoặc điền bảng giá để ước tính.' : 'Chưa có lượt chạy nào trong khoảng này.' }}</p>
  }
</section>
  `,
})
export class UsageChart {
  protected readonly use = inject(UsageState);
}
