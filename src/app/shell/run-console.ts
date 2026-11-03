import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { AgentBackend } from '../core/backend';
import { AgentsService } from '../core/agents.service';
import { fmtDuration, fmtTokens } from '../core/format';
import { AGENT_META, AgentId } from '../core/protocol';
import { RunsService } from '../core/runs.service';
import { AgentAvatar } from './agent-avatar';

@Component({
  selector: 'tg-run-console',
  imports: [AgentAvatar],
  template: `
    <section class="composer">
      <label class="sr-only" for="prompt">Yêu cầu cho agent</label>
      <textarea id="prompt" rows="3" placeholder="Giao việc cho agent… (⌘↵ để chạy)"
        [value]="prompt()" (input)="prompt.set($any($event.target).value)"
        (keydown.meta.enter)="run()" (keydown.control.enter)="run()"></textarea>
      <div class="composer-row">
        <label class="field">
          <span>Agent</span>
          <select [value]="agent()" (change)="chosen.set($any($event.target).value)">
            @for (a of agents.runnable(); track a.id) { <option [value]="a.id">{{ a.name }}</option> }
            @if (!agents.runnable().length) { <option value="">Chưa có agent nào chạy được</option> }
          </select>
        </label>
        <label class="field grow">
          <span>Thư mục làm việc</span>
          <input class="mono" [value]="cwd()" (input)="cwd.set($any($event.target).value)" spellcheck="false" />
        </label>
        <button class="btn primary" (click)="run()" [disabled]="!canRun()">Chạy ⌘↵</button>
      </div>
      @if (error()) { <p class="error-text">{{ error() }}</p> }
    </section>

    <div class="run-tabs" role="tablist">
      @for (r of runs.runs(); track r.id) {
        <button role="tab" class="run-tab" [class.active]="r.id === runs.selectedId()" [attr.aria-selected]="r.id === runs.selectedId()" (click)="runs.selectedId.set(r.id)">
          <tg-agent-avatar [agent]="r.agent" [size]="14" />
          <span class="ellipsis">{{ r.prompt || meta[r.agent].name }}</span>
          <span class="status" [attr.data-status]="r.status">{{ statusLabel[r.status] }}</span>
        </button>
      }
    </div>

    <section class="console" aria-label="Agent output">
      @if (runs.selected(); as r) {
        <div class="console-head">
          <tg-agent-avatar [agent]="r.agent" />
          <strong>{{ meta[r.agent].name }}</strong>
          <span class="dim mono ellipsis">{{ r.cwd }}</span>
          <span class="spacer"></span>
          @if (r.usage) {
            <span class="dim mono">{{ tok(r.usage.inputTokens + r.usage.cachedInputTokens + r.usage.outputTokens) }} tok</span>
          }
          <span class="dim">{{ dur(r) }}</span>
          @if (r.status === 'running') { <button class="btn ghost sm" (click)="runs.stop(r.id)">Dừng</button> }
        </div>
        <div class="console-body mono">
          @for (l of r.lines; track $index) { <div class="line" [attr.data-tone]="l.tone">{{ l.text }}</div> }
        </div>
      } @else {
        <div class="empty">
          <p>Chưa có lượt chạy nào.</p>
          <p class="dim">Chọn agent, nhập yêu cầu và bấm Chạy. Mỗi lượt chạy được ghi lại token và chi phí ở cột bên phải.</p>
        </div>
      }
    </section>
  `,
})
export class RunConsole implements OnInit {
  protected readonly agents = inject(AgentsService);
  protected readonly runs = inject(RunsService);
  private readonly backend = inject(AgentBackend);
  protected readonly meta = AGENT_META;
  protected readonly statusLabel = { running: 'đang chạy', done: 'xong', failed: 'lỗi', stopped: 'đã dừng' };

  protected readonly prompt = signal('');
  protected readonly cwd = signal('');
  protected readonly chosen = signal<AgentId | ''>('');
  protected readonly error = signal<string | null>(null);
  protected readonly agent = computed<AgentId | ''>(() => this.chosen() || this.agents.runnable()[0]?.id || '');
  protected readonly canRun = computed(() => !!this.agent() && !!this.prompt().trim() && !!this.cwd().trim());

  async ngOnInit() {
    this.cwd.set((await this.backend.homeDir()) ?? '');
  }

  protected async run() {
    const agent = this.agent();
    if (!agent || !this.canRun()) return;
    this.error.set(null);
    try {
      await this.runs.start(agent, this.prompt().trim(), this.cwd().trim());
      this.prompt.set('');
    } catch (e) {
      this.error.set(String(e));
    }
  }

  protected tok = fmtTokens;
  protected dur(r: { startedAt: number; endedAt: number | null }) {
    return fmtDuration((r.endedAt ?? Date.now()) - r.startedAt);
  }
}
