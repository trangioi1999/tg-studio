import { Component, computed, inject } from '@angular/core';
import { fmtTokens, fmtUsd } from '../core/format';
import { AGENT_META } from '../core/protocol';
import { RunsService } from '../core/runs.service';
import { AgentAvatar } from './agent-avatar';

@Component({
  selector: 'tg-usage-panel',
  imports: [AgentAvatar],
  template: `
    <div class="panel-head">
      <span class="label">USAGE · PHIÊN NÀY</span>
      <span class="spacer"></span>
      <strong>{{ usd(runs.totals().costUsd) }}</strong>
      <span class="dim">{{ tok(runs.totals().tokens) }} tok</span>
    </div>
    <div class="usage-table">
      @for (u of rows(); track u.agent) {
        <div class="usage-row">
          <tg-agent-avatar [agent]="u.agent" />
          <div class="usage-main">
            <div>{{ meta[u.agent].name }} <span class="src" [attr.data-src]="u.costSource">{{ sourceLabel[u.costSource] }}</span></div>
            <div class="mono dim">in {{ tok(u.inputTokens) }} · cache {{ tok(u.cachedInputTokens) }} · out {{ tok(u.outputTokens) }}</div>
          </div>
          <div class="usage-cost">
            <strong>{{ usd(u.costUsd) }}</strong>
            <span class="dim">{{ u.runs }} lượt</span>
          </div>
        </div>
      } @empty {
        <p class="dim pad">Chưa có số liệu. Chạy một agent để bắt đầu ghi usage.</p>
      }
    </div>
    <div class="note">
      <p><strong>reported</strong>: CLI tự báo chi phí. <strong>estimated</strong>: tính từ token × bảng giá trong <code>core/pricing.ts</code>. <strong>chưa có giá</strong>: chỉ có token.</p>
      <p class="dim">Quota gói subscription (Claude Max, ChatGPT plan, Kiro credits) sẽ có ở giai đoạn 3.</p>
    </div>
  `,
})
export class UsagePanel {
  protected readonly runs = inject(RunsService);
  protected readonly meta = AGENT_META;
  protected readonly rows = computed(() => this.runs.usageByAgent().filter((u) => u.runs > 0));
  protected readonly sourceLabel = { reported: 'reported', estimated: 'estimated', unpriced: 'chưa có giá', none: '' };
  protected tok = fmtTokens;
  protected usd = fmtUsd;
}
