import { Component, inject } from '@angular/core';
import { AgentBackend } from '../core/backend';
import { BudgetService } from '../core/budget.service';
import { DiagnosticsService } from '../core/diagnostics.service';
import { fmtTokens, fmtUsd } from '../core/format';
import { RunsService } from '../core/runs.service';

@Component({
  selector: 'tg-status-bar',
  template: `
    @if (budget.notices().length) {
      <div class="notices" role="status">
        @for (n of budget.notices(); track $index; let i = $index) {
          <div class="notice"><span>{{ n }}</span><button class="btn ghost sm" (click)="budget.dismiss(i)" aria-label="Đóng thông báo">×</button></div>
        }
      </div>
    }
    <footer class="statusbar">
      <span><span class="dot" [class.live]="runs.running().length"></span>{{ runs.running().length }} agent đang chạy</span>
      <span>{{ runs.sessionRuns().length }} lượt</span>
      <span class="spacer"></span>
      @if (diag.saved()) { <span class="ellipsis" role="status">Đã lưu chẩn đoán: {{ diag.saved() }}</span> }
      @if (diag.failed()) { <span class="err" role="alert">{{ diag.failed() }}</span> }
      <button class="status-btn" (click)="diag.export()" title="Lưu một tệp chẩn đoán (không gồm khóa hay mật khẩu) vào Downloads để gửi khi báo lỗi. App không tự gửi gì.">Chẩn đoán</button>
      @if (backend.mode === 'mock') { <span class="mock">Mock mode — mở bằng <code>npm run dev</code> để chạy agent thật</span> }
      <span>{{ tok(runs.totals().tokens) }} tok</span>
      <span [attr.data-level]="budget.dailyLevel()" class="today">
        Hôm nay {{ usd(budget.todayCost()) }}@if (budget.budgets().daily; as d) { / {{ usd(d) }} }
      </span>
    </footer>
  `,
})
export class StatusBar {
  protected readonly runs = inject(RunsService);
  protected readonly backend = inject(AgentBackend);
  protected readonly budget = inject(BudgetService);
  protected readonly diag = inject(DiagnosticsService);
  protected tok = fmtTokens;
  protected usd = fmtUsd;
}
