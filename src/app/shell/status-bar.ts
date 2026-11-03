import { Component, inject } from '@angular/core';
import { AgentBackend } from '../core/backend';
import { fmtTokens, fmtUsd } from '../core/format';
import { RunsService } from '../core/runs.service';

@Component({
  selector: 'tg-status-bar',
  template: `
    <footer class="statusbar">
      <span><span class="dot" [class.live]="runs.running().length"></span>{{ runs.running().length }} agent đang chạy</span>
      <span>{{ runs.sessionRuns().length }} lượt</span>
      <span class="spacer"></span>
      @if (backend.mode === 'mock') { <span class="mock">Mock mode — mở bằng <code>npm run dev</code> để chạy agent thật</span> }
      <span>{{ tok(runs.totals().tokens) }} tok</span>
      <span>{{ usd(runs.totals().costUsd) }}</span>
    </footer>
  `,
})
export class StatusBar {
  protected readonly runs = inject(RunsService);
  protected readonly backend = inject(AgentBackend);
  protected tok = fmtTokens;
  protected usd = fmtUsd;
}
