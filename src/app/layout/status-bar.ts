import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { AgentAvatar } from '../shared/ui/agent-avatar';
import { ResourceMeter } from './resource-meter';
import { AgentsService } from '../services/agents/agents.service';
import { limitView, limitsTitle } from '../services/usage/limits';
import { AgentId } from '../core/protocol';
import { AGENT_IDS } from '../services/agents/agent-meta';
import { AgentBackend } from '../core/backend';
import { BudgetService } from '../services/usage/budget.service';
import { DiagnosticsService } from '../services/app/diagnostics.service';
import { fmtTokens, fmtUsd } from '../shared/utils/format';
import { RunsService } from '../services/runs/runs.service';
import { VersionService } from '../services/app/version.service';

/** Agents with a known source of plan limits. Gemini and Kiro have none yet. */
const LIMIT_SOURCES: AgentId[] = ['claude', 'codex'];

@Component({
  selector: 'tg-status-bar',
  imports: [AgentAvatar, ResourceMeter],
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
      @for (row of limitRows(); track row.agent) {
        <button class="limit" [class.busy]="runs.refreshingLimits()" [title]="row.title + '\nBấm để cập nhật.'" [attr.aria-label]="row.title + '. Bấm để cập nhật.'" (click)="runs.refreshLimits(true)">
          <tg-agent-avatar [agent]="row.agent" [size]="14" />
          @for (w of row.windows; track w.id) {
            <span [attr.data-level]="w.level">{{ w.name }} {{ w.reset ? 'đã reset' : w.percent + '%' }}</span>
          } @empty {
            <span class="dim">{{ runs.refreshingLimits() ? 'đang đọc…' : 'chưa có số' }}</span>
          }
        </button>
      }
      @if (diag.saved()) { <span class="ellipsis" role="status">Đã lưu chẩn đoán: {{ diag.saved() }}</span> }
      @if (diag.failed()) { <span class="err" role="alert">{{ diag.failed() }}</span> }
      <button class="status-btn" (click)="diag.export()" title="Lưu một tệp chẩn đoán (không gồm khóa hay mật khẩu) vào Downloads để gửi khi báo lỗi. App không tự gửi gì.">Chẩn đoán</button>
      @if (backend.mode === 'mock') { <span class="mock">Mock mode — mở bằng <code>npm run dev</code> để chạy agent thật</span> }
      <tg-resource-meter />
      @if (version.label()) {
        <button class="status-btn version" [class.newer]="version.latest()?.newer" [class.busy]="version.checking()"
          [title]="version.title()" [attr.aria-label]="version.title()" (click)="version.check()">
          {{ version.label() }}@if (version.latest()?.newer) { · có v{{ version.latest()!.latest }} }
        </button>
      }
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
  protected readonly version = inject(VersionService);
  private readonly agents = inject(AgentsService);
  private readonly tick = signal(Date.now());
  /** Plan limits stay on screen for every agent that can report them. */
  protected readonly limitRows = computed(() => {
    const now = this.tick();
    const installed = new Set<AgentId>(this.agents.agents().filter((a) => a.path).map((a) => a.id));
    return AGENT_IDS.flatMap((agent) => {
      const limits = this.runs.limits()[agent];
      if (limits?.windows.length) return [{ agent, windows: limits.windows.map((w) => limitView(w, now)), title: limitsTitle(limits, now) }];
      if (!installed.has(agent) || !LIMIT_SOURCES.includes(agent)) return [];
      return [{ agent, windows: [], title: agent === 'claude' ? 'Chưa đọc được hạn mức từ Claude Code.' : 'Số hạn mức có sau lượt chạy đầu tiên của agent này.' }];
    });
  });

  constructor() {
    // A window can reset, and another Codex session can spend, while nothing runs here.
    const timer = setInterval(() => {
      this.tick.set(Date.now());
      void this.runs.refreshLimits();
    }, 60_000);
    // Coming back to the app after using a CLI elsewhere: the numbers may be stale.
    const onFocus = () => void this.runs.refreshLimits();
    window.addEventListener('focus', onFocus);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    });
  }

  protected tok = fmtTokens;
  protected usd = fmtUsd;
}
