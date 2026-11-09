import { Component, inject } from '@angular/core';
import { AgentAvatar } from '../shared/agent-avatar';
import { UsageState } from './usage.state';

/** Each agent's share of the range; picking one filters the runs. */
@Component({
  selector: 'tg-usage-by-agent',
  imports: [AgentAvatar],
  template: `
<section class="pg-card" aria-label="Theo agent">
  <div class="pg-card-head"><h2>Theo agent</h2><span class="spacer"></span><span class="dim">bấm để lọc</span></div>
  <div class="cost-split">
    @for (a of use.shares(); track a.agent) {
      <button class="cost-split-row" [class.on]="use.agent() === a.agent" [attr.aria-pressed]="use.agent() === a.agent" (click)="use.toggleAgent(a.agent)">
        <tg-agent-avatar [agent]="a.agent" [size]="22" />
        <span class="cost-split-main">
          <span class="cost-split-name"><span class="ellipsis">{{ use.meta[a.agent].name }}</span><span class="dim">{{ use.round(a.share) }}%</span></span>
          <span class="cost-track"><i [style.width.%]="a.share" [style.background]="use.meta[a.agent].chart"></i></span>
        </span>
        <span class="cost-split-amt mono">{{ use.usd(a.cost) }}<small>{{ use.tok(a.tokens) }} tok · {{ a.runs }} lượt</small></span>
      </button>
    } @empty {
      <p class="dim">Chưa có lượt chạy nào trong khoảng này.</p>
    }
  </div>
</section>
  `,
})
export class UsageByAgent {
  protected readonly use = inject(UsageState);
}
