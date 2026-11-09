import { Component, inject } from '@angular/core';
import { AgentAvatar } from '../shared/agent-avatar';
import { UsageState } from './usage.state';

/** Every run of the range: search, sort, pages, CSV. */
@Component({
  selector: 'tg-usage-runs',
  imports: [AgentAvatar],
  template: `
<section class="pg-card" aria-label="Các lượt chạy">
  <div class="cost-table-tools">
    <h2>Các lượt chạy</h2>
    <span class="dim">{{ use.filtered().length === use.rows().length ? use.rows().length : use.filtered().length + ' / ' + use.rows().length }}</span>
    @if (use.agent(); as a) {
      <button class="fchip on" (click)="use.agent.set(null)" [attr.aria-label]="'Bỏ lọc ' + use.meta[a].name"><tg-agent-avatar [agent]="a" [size]="14" />{{ use.meta[a].name }} <span class="x">×</span></button>
    }
    @if (use.day() !== null) {
      <button class="fchip on" (click)="use.day.set(null)" aria-label="Bỏ lọc theo ngày">{{ use.dayText(use.day()!) }} <span class="x">×</span></button>
    }
    <span class="spacer"></span>
    <input class="cost-search" type="search" placeholder="Tìm theo yêu cầu…" aria-label="Tìm theo yêu cầu" [value]="use.query()" (input)="use.query.set($any($event.target).value)" />
  </div>
  <div class="table-wrap">
    <table class="runs-table cost-table">
      <thead><tr>
        <th><button class="cost-sort" [class.on]="use.sort() === 'time'" (click)="use.sort.set('time')">Thời gian{{ use.sort() === 'time' ? ' ↓' : '' }}</button></th>
        <th>Agent</th><th>Yêu cầu</th>
        <th class="num"><button class="cost-sort" [class.on]="use.sort() === 'tokens'" (click)="use.sort.set('tokens')">Token{{ use.sort() === 'tokens' ? ' ↓' : '' }}</button></th>
        <th class="num">Input</th><th class="num">Cache</th><th class="num">Output</th>
        <th class="num"><button class="cost-sort" [class.on]="use.sort() === 'cost'" (click)="use.sort.set('cost')">Chi phí{{ use.sort() === 'cost' ? ' ↓' : '' }}</button></th>
      </tr></thead>
      <tbody>
        @for (r of use.tableRows(); track r.id) {
          <tr [class.cost-open]="use.openable().has(r.id)" [attr.tabindex]="use.openable().has(r.id) ? 0 : null"
              [attr.title]="use.openable().has(r.id) ? 'Mở cuộc trò chuyện' : null"
              (click)="use.open(r)" (keydown.enter)="use.open(r)">
            <td class="mono dim">{{ use.when(r.startedAt) }}</td>
            <td><span class="cell-agent" [title]="use.meta[r.agent].name"><tg-agent-avatar [agent]="r.agent" [size]="16" /></span></td>
            <td class="ellipsis prompt-cell" [title]="r.prompt">{{ r.prompt }}</td>
            <td class="num mono">{{ use.tok(use.tokens(r)) }}</td>
            <td class="num mono dim">{{ use.tok(r.usage?.inputTokens ?? 0) }}</td>
            <td class="num mono dim">{{ use.tok(r.usage?.cachedInputTokens ?? 0) }}</td>
            <td class="num mono dim">{{ use.tok(r.usage?.outputTokens ?? 0) }}</td>
            <td class="num mono" [class.cost-hi]="use.isTop(r)">{{ use.usd(use.costRow(r).usd) }}<span class="cost-src" [attr.data-src]="use.costRow(r).source" [title]="use.sourceLabel[use.costRow(r).source]"></span></td>
          </tr>
        } @empty {
          <tr><td colspan="8" class="dim">{{ use.rows().length ? 'Không có lượt nào khớp bộ lọc.' : 'Chưa có lượt chạy nào trong khoảng này.' }}</td></tr>
        }
      </tbody>
    </table>
    @if (use.filtered().length > use.shown()) {
      <div class="cost-more"><button class="btn sm" (click)="use.shown.set(use.shown() + 50)">Xem thêm {{ use.min(50, use.filtered().length - use.shown()) }} lượt</button><span class="dim">còn {{ use.filtered().length - use.shown() }} lượt · CSV có đủ</span></div>
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
  `,
})
export class UsageRuns {
  protected readonly use = inject(UsageState);
}
