import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { AccountLimits, LimitWindow } from '../core/protocol';
import { AGENT_IDS, AGENT_META } from '../agents/agent-meta';
import { RunsService } from '../core/runs.service';
import { AgentAvatar } from './agent-avatar';

/** Plan limits (Claude Pro/Max, Codex) as a card on the cost screen. */
@Component({
  selector: 'tg-usage-panel',
  host: { class: 'pg-card cost-limits' },
  imports: [AgentAvatar],
  template: `
    <div class="pg-card-head"><h2>Hạn mức gói</h2></div>
    <div class="limits">
      @for (l of limits(); track l.agent) {
        <div class="limit-agent">
          <div class="limit-title">
            <tg-agent-avatar [agent]="l.agent" [size]="16" />
            <span>{{ meta[l.agent].name }}</span>
            <span class="spacer"></span>
            <span class="dim" [title]="exact(l.at)">{{ ago(l.at) }}</span>
          </div>
          @for (w of l.windows; track w.id) {
            <div class="limit-row" [attr.data-level]="level(w)">
              <div class="limit-line">
                <span>{{ windowLabel(w.id) }}</span>
                <span class="spacer"></span>
                <strong class="mono">{{ percent(w.utilization) }}</strong>
              </div>
              <div class="meter" role="meter" [attr.aria-label]="windowLabel(w.id)" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="percentValue(w.utilization)">
                <span [style.width.%]="percentValue(w.utilization)"></span>
              </div>
              <div class="dim limit-reset">
                @if (w.status === 'rejected') { <span class="limit-hit">Đã chạm giới hạn · </span> }
                @if (w.resetsAt) { Đặt lại {{ resetLabel(w.resetsAt) }} }
              </div>
            </div>
          }
        </div>
      } @empty {
        <p class="dim pad">Chưa có số liệu hạn mức. Hạn mức gói Claude Pro/Max (5 giờ và 7 ngày) hiện sau một lượt chạy Claude ở chế độ <strong>Chỉ đọc</strong>. Chế độ Sửa code (qua adapter ACP) hiện chưa nhận được số này. Đăng nhập Claude bằng API key thì không có hạn mức gói, chỉ có chi phí.</p>
      }
    </div>
    <p class="dim cost-limits-note">Với gói Pro/Max, chi phí là giá API quy đổi để tham khảo; phần bị trừ thật là hạn mức ở đây. Lấy từ lượt chạy gần nhất.</p>
  `,
})
export class UsagePanel implements OnDestroy {
  protected readonly runs = inject(RunsService);
  protected readonly meta = AGENT_META;

  /** Re-render "x phút trước" once a minute. */
  private readonly now = signal(Date.now());
  private readonly timer = setInterval(() => this.now.set(Date.now()), 60_000);
  protected readonly limits = computed(() =>
    AGENT_IDS.map((a) => this.runs.limits()[a]).filter((l): l is AccountLimits => !!l && l.windows.length > 0));

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  protected windowLabel(id: string): string {
    return WINDOW_LABELS[id] ?? id.replace(/_/g, ' ');
  }

  protected percentValue(u: number): number {
    return Math.max(0, Math.min(100, Math.round(u * 100)));
  }

  protected percent(u: number): string {
    return `${Math.round(u * 100)}%`;
  }

  protected level(w: LimitWindow): 'ok' | 'warn' | 'hit' {
    if (w.status === 'rejected' || w.utilization >= 1) return 'hit';
    return w.status === 'allowed_warning' || w.utilization >= 0.8 ? 'warn' : 'ok';
  }

  protected resetLabel(ms: number): string {
    const sameDay = new Date(ms).toDateString() === new Date(this.now()).toDateString();
    const time = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(ms);
    if (sameDay) return `lúc ${time}`;
    return `${new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'numeric' }).format(ms)} ${time}`;
  }

  protected ago(at: number): string {
    const minutes = Math.floor((this.now() - at) / 60_000);
    if (minutes < 1) return 'vừa cập nhật';
    if (minutes < 60) return `${minutes} phút trước`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours} giờ trước` : `${Math.floor(hours / 24)} ngày trước`;
  }

  protected exact(at: number): string {
    return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(at);
  }
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 giờ',
  seven_day: '7 ngày · mọi model',
  seven_day_opus: '7 ngày · Opus',
  seven_day_sonnet: '7 ngày · Sonnet',
};
