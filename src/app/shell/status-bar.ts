import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { AgentAvatar } from './agent-avatar';
import { AgentsService } from '../core/agents.service';
import { limitView, limitsTitle } from '../core/limits';
import { AGENT_IDS, AgentId } from '../core/protocol';
import { AgentBackend } from '../core/backend';
import { BudgetService } from '../core/budget.service';
import { DiagnosticsService } from '../core/diagnostics.service';
import { fmtTokens, fmtUsd } from '../core/format';
import { RunsService } from '../core/runs.service';

/** Agents with a known source of plan limits. Gemini and Kiro have none yet. */
const LIMIT_SOURCES: AgentId[] = ['claude', 'codex'];

@Component({
  selector: 'tg-status-bar',
  imports: [AgentAvatar],
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
        <span class="limit" [title]="row.title" [attr.aria-label]="row.title">
          <tg-agent-avatar [agent]="row.agent" [size]="14" />
          @for (w of row.windows; track w.id) {
            <span [attr.data-level]="w.level">{{ w.name }} {{ w.reset ? 'đã reset' : w.percent + '%' }}</span>
          } @empty {
            <span class="dim">chưa có số</span>
          }
        </span>
      }
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
      return [{ agent, windows: [], title: 'Số hạn mức có sau lượt chạy đầu tiên của agent này.' }];
    });
  });

  constructor() {
    // A window can reset, and another Codex session can spend, while nothing runs here.
    const timer = setInterval(() => {
      this.tick.set(Date.now());
      void this.runs.loadLimits();
    }, 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected tok = fmtTokens;
  protected usd = fmtUsd;
}
