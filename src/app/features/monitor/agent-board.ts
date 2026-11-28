import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { PermissionOption, PermissionRequest } from '../../core/protocol';
import { RunsService } from '../../services/runs/runs.service';
import { UiService } from '../../services/app/ui.service';
import { AGENT_META } from '../../services/agents/agent-meta';
import { AgentAvatar } from '../../shared/ui/agent-avatar';
import { Mascot } from '../../shared/ui/mascot';
import { Page } from '../../shared/ui/page';
import { fmtUsd } from '../../shared/utils/format';
import { boardCards, boardCounts, BoardCard, BoardState } from './board';
import { MissionControl } from './mission-control';

type Filter = BoardState | 'all';
@Component({
  selector: 'tg-agent-board',
  host: { class: 'center screen' },
  imports: [Page, AgentAvatar, Mascot, MissionControl],
  template: `
    <tg-page title="Bảng agent" lead="Mọi agent đang chạy trên các dự án. Bấm một thẻ để mở cửa sổ xem nó làm gì.">
      <tg-mission-control pageMeta />
      <div class="ab-filters" role="tablist" aria-label="Lọc theo trạng thái">
        @for (f of filters; track f) {
          <button type="button" role="tab" [attr.aria-selected]="filter() === f" [attr.tabindex]="filter() === f ? 0 : -1"
            [attr.data-status]="status[f]" (click)="filter.set(f)" (keydown)="filterKey($event, f)">{{ labels[f] }} · {{ counts()[f] }}</button>
        }
      </div>
      @if (!cards().length) {
        <div class="ab-empty"><tg-mascot pose="sleep" [size]="90" /><p>Chưa có agent nào chạy hôm nay.</p></div>
      } @else if (!visible().length) {
        <div class="ab-empty"><p>{{ emptyText() }}</p><button class="btn" (click)="filter.set('all')">Xem tất cả</button></div>
      } @else {
        <div class="ab-grid">
          @for (c of visible(); track c.runId) {
            <article class="ab-card" [attr.data-status]="status[c.state]">
              <button type="button" class="ab-open" #opener (click)="ui.openAgentWindow(c.runId, opener)" [attr.aria-label]="'Mở cửa sổ agent: ' + c.title">
                <span class="ab-head">
                  <tg-mascot [pose]="c.pose" [size]="54" />
                  <span class="ab-info">
                    <span class="ab-agent"><tg-agent-avatar [agent]="c.agent" [size]="16" /><strong>{{ meta[c.agent].name }}</strong></span>
                    @if (c.parentTitle) { <span class="ab-parent">↳ của {{ c.parentTitle }}</span> }
                    <span class="ab-title">{{ c.title }}</span>
                    <span class="ab-project">{{ c.project || 'Chưa chọn dự án' }}</span>
                  </span>
                  <span class="pill" [attr.data-status]="status[c.state]">{{ labels[c.state] }}</span>
                </span>
                <span class="ab-tail">{{ c.tail.join('\n') || 'Chưa có nhật ký.' }}</span>
              </button>
              @if (c.permission; as p) {
                <div class="ab-approval">
                  <span class="ab-request">{{ p.toolCall.title || 'Agent muốn dùng một công cụ' }}</span>
                  @if (option(p, false)) { <button class="btn" [disabled]="busy()[key(c)]" (click)="answer($event, c, false)">Từ chối</button> }
                  @if (option(p, true)) { <button class="btn warn" [disabled]="busy()[key(c)]" (click)="answer($event, c, true)">Cho phép lần này</button> }
                </div>
              }
              @if (errors()[c.runId]; as error) { <p class="ab-error" role="alert">{{ error }}</p> }
              <div class="ab-meta">
                <span>@if (c.durationMs >= 1000) { {{ duration(c.durationMs) }} · }{{ usd(c.costUsd) }}</span>
                @if (c.contextPercent !== null) {
                  <span class="ab-context" [attr.aria-label]="'Ngữ cảnh đã dùng ' + c.contextPercent + '%'">
                    <span>Ngữ cảnh</span><span class="ab-meter" aria-hidden="true"><span [style.width.%]="bounded(c.contextPercent)"></span></span><span>{{ c.contextPercent }}%</span>
                  </span>
                }
              </div>
            </article>
          }
        </div>
      }
    </tg-page>
  `,
})
export class AgentBoard {
  private readonly runs = inject(RunsService);
  protected readonly ui = inject(UiService);
  protected readonly meta = AGENT_META;
  protected readonly usd = fmtUsd;
  private readonly now = signal(Date.now());
  protected readonly cards = computed(() => boardCards(this.runs.runs(), this.runs.lastEvent(), this.now()));
  protected readonly counts = computed(() => boardCounts(this.cards()));
  protected readonly filter = signal<Filter>('all');
  protected readonly filters: Filter[] = ['all', 'needs_you', 'running', 'done', 'sleep'];
  protected readonly labels: Record<Filter, string> = { all: 'Tất cả', needs_you: 'Cần bạn', running: 'Đang chạy', done: 'Xong', sleep: 'Đang ngủ', failed: 'Lỗi' };
  protected readonly status: Record<Filter, string> = { all: '', needs_you: 'needs_you', running: 'running', done: 'ended', sleep: 'stopped', failed: 'failed' };
  protected readonly visible = computed(() => this.cards().filter(c => this.filter() === 'all' || c.state === this.filter()));
  protected readonly emptyText = computed(() => this.filter() === 'needs_you' ? 'Không có agent nào cần bạn.' : 'Không có agent nào ở trạng thái này.');
  protected readonly busy = signal<Record<string, boolean>>({});
  protected readonly errors = signal<Record<string, string>>({});

  constructor() {
    // Also advance while idle: sleep and the 24-hour cutoff do not require a new event.
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
  protected duration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  protected bounded(n: number): number { return Math.min(100, Math.max(0, n)); }
  protected key(c: BoardCard): string { return JSON.stringify([c.runId, c.permission?.requestId]); }
  protected option(p: PermissionRequest, allow: boolean): PermissionOption | undefined {
    return allow ? p.options.find(o => o.kind === 'allow_once') :
      p.options.find(o => o.kind === 'reject_once') ?? p.options.find(o => o.kind === 'reject_always');
  }
  protected async answer(event: Event, c: BoardCard, allow: boolean): Promise<void> {
    event.stopPropagation();
    const key = this.key(c);
    const live = this.runs.runs().find(r => r.id === c.runId)?.permissions.find(p => p.requestId === c.permission?.requestId);
    if (!live || this.busy()[key]) return;
    const option = this.option(live, allow);
    if (!option) return;
    this.busy.update(b => ({ ...b, [key]: true }));
    this.errors.update(e => ({ ...e, [c.runId]: '' }));
    try {
      await this.runs.respondPermission(c.runId, live.requestId, option.optionId, false);
      // Keep disabled until the permission event removes it, even if the response resolves first.
    } catch {
      this.busy.update(b => ({ ...b, [key]: false }));
      this.errors.update(e => ({ ...e, [c.runId]: 'Không gửi được câu trả lời duyệt. Vui lòng thử lại.' }));
    }
  }
  protected filterKey(event: KeyboardEvent, f: Filter): void {
    const i = this.filters.indexOf(f);
    const next = event.key === 'ArrowRight' ? (i + 1) % this.filters.length : event.key === 'ArrowLeft' ? (i + this.filters.length - 1) % this.filters.length : event.key === 'Home' ? 0 : event.key === 'End' ? this.filters.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    this.filter.set(this.filters[next]);
    (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('button')[next].focus();
  }
}
