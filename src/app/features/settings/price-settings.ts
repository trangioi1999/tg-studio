import { Component, inject } from '@angular/core';
import { AgentAvatar } from '../../shared/ui/agent-avatar';
import { UsageState } from './usage.state';

/** The sheet that edits prices (from a date on) and the budgets. */
@Component({
  selector: 'tg-usage-price-sheet',
  imports: [AgentAvatar],
  template: `
@if (use.sheet()) {
  <div class="sheet-backdrop" (click)="use.sheet.set(false)">
    <aside class="sheet cost-sheet" role="dialog" aria-modal="true" aria-label="Giá và ngân sách" (click)="$event.stopPropagation()">
      <div class="sheet-head"><h3>Giá &amp; ngân sách</h3><span class="spacer"></span><button class="icon-btn" aria-label="Đóng" (click)="use.sheet.set(false)">✕</button></div>
      @if (use.error()) { <p class="error-text" role="alert">{{ use.error() }}</p> }

      <h4 class="cost-sheet-h">Ngân sách</h4>
      <div class="cost-two">
        <label class="field"><span>Mỗi task (USD)</span><input type="number" min="0" step="0.5" [value]="use.budget.budgets().perTask ?? ''" (input)="use.draftTask.set($any($event.target).value)" placeholder="không giới hạn" /></label>
        <label class="field"><span>Mỗi ngày (USD)</span><input type="number" min="0" step="1" [value]="use.budget.budgets().daily ?? ''" (input)="use.draftDaily.set($any($event.target).value)" placeholder="không giới hạn" /></label>
      </div>
      <div class="row-end"><button class="btn primary sm" [disabled]="use.busy()" (click)="use.saveBudgets()">Lưu ngân sách</button></div>
      <p class="dim form-note">Vượt mức mỗi task thì run đó bị dừng; chạm mức ngày thì mọi run dừng và không giao việc mới được. Agent thường báo chi phí khi xong, nên việc dừng chỉ xảy ra khi đã có số.</p>

      <h4 class="cost-sheet-h">Bảng giá · USD / 1M token</h4>
      @for (a of use.agentIds; track a) {
        <div class="price-row">
          <div class="price-title"><tg-agent-avatar [agent]="a" [size]="14" />{{ use.meta[a].name }}
            <span class="spacer"></span>
            @if (use.current(a); as p) { <span class="dim">từ {{ use.date(p.fromMs) }}</span> }
          </div>
          @if (a === 'claude') { <p class="dim form-note">Claude Code tự báo chi phí; bảng giá chỉ dùng khi không có số báo.</p> }
          <div class="price-inputs">
            <label class="field"><span>Input</span><input type="number" min="0" step="0.01" [value]="use.current(a)?.input ?? ''" (input)="use.draft(a, 'input', $any($event.target).value)" /></label>
            <label class="field"><span>Cache</span><input type="number" min="0" step="0.01" [value]="use.current(a)?.cachedInput ?? ''" (input)="use.draft(a, 'cachedInput', $any($event.target).value)" /></label>
            <label class="field"><span>Output</span><input type="number" min="0" step="0.01" [value]="use.current(a)?.output ?? ''" (input)="use.draft(a, 'output', $any($event.target).value)" /></label>
            <button class="btn ghost sm" [disabled]="use.busy() || !use.drafts()[a]" (click)="use.savePrice(a)">Áp dụng</button>
          </div>
        </div>
      }
      <label class="check-line"><input type="checkbox" [checked]="use.backfill()" (change)="use.backfill.set($any($event.target).checked)" /> Áp dụng cho cả các lượt trước (chỉ những lượt chưa có giá nào)</label>
      <p class="dim form-note">Mặc định giá mới áp dụng từ lúc bấm; các lượt cũ giữ giá lúc chúng chạy. Để trống cả ba ô rồi Áp dụng để bỏ giá.</p>
    </aside>
  </div>
}
  `,
})
export class UsagePriceSheet {
  protected readonly use = inject(UsageState);
}
