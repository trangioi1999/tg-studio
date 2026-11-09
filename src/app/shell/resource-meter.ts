import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { AgentAvatar } from './agent-avatar';
import { AgentBackend } from '../core/backend';
import { fmtBytes, fmtCpu } from '../core/format';
import { AGENT_META, ResourceReport, UsageGroup } from '../core/protocol';
import { RunsService } from '../core/runs.service';
import { errorText } from '../shared/errors';

/** Every 3 s while the window is visible, every 15 s while it is hidden. */
const VISIBLE_MS = 3_000;
const HIDDEN_MS = 15_000;

/** Status bar: memory and CPU of the app and its agents, with a breakdown to free memory. */
@Component({
  selector: 'tg-resource-meter',
  imports: [AgentAvatar],
  template: `
    <span class="res-anchor">
      <button class="res-btn" [class.open]="open()" [attr.aria-expanded]="open()" aria-haspopup="dialog"
        [title]="'RAM và CPU mà TG Studio cùng các agent đang dùng. Bấm để xem chi tiết.'" (click)="toggle()">
        @if (report(); as r) { TG · {{ bytes(r.memory) }} · {{ cpu(r.cpu) }} } @else { TG · … }
      </button>
      @if (open()) {
        <div class="res-backdrop" (click)="open.set(false)"></div>
        <div class="res-pop" role="dialog" aria-label="Tài nguyên đang dùng" (keydown.escape)="open.set(false)">
          <div class="res-head">
            <strong>Tài nguyên đang dùng</strong>
            @if (report(); as r) { <span class="dim">{{ bytes(r.memory) }} RAM · {{ cpu(r.cpu) }} CPU · máy có {{ r.cores }} nhân</span> }
          </div>
          @if (error()) { <p class="err res-note">{{ error() }}</p> }
          @for (row of rows(); track row.key) {
            <div class="res-row">
              @if (row.agent) { <tg-agent-avatar [agent]="row.agent" [size]="16" /> } @else { <span class="res-mark" aria-hidden="true">TG</span> }
              <span class="res-name ellipsis" [title]="row.detail">{{ row.label }}<span class="dim"> · {{ row.detail }}</span></span>
              <span class="res-num mono">{{ bytes(row.group.memory) }}</span>
              <span class="res-num mono">{{ cpu(row.group.cpu) }}</span>
              @if (row.stop) {
                <button class="btn ghost sm" [disabled]="busy()" (click)="stop(row.group)" [title]="row.stopTitle">Dừng</button>
              } @else { <span class="res-gap"></span> }
            </div>
          }
          <p class="dim res-note">
            CPU tính theo % của một nhân (như Activity Monitor). Mỗi cuộc trò chuyện còn mở giữ agent của nó; Dừng để giải phóng, chat tiếp thì agent mở lại.
            @if (report() && !report()!.webview) { Không gồm WebView của macOS (khoảng 150–200 MB), vì hệ điều hành chạy nó ngoài app. }
          </p>
        </div>
      }
    </span>
  `,
})
export class ResourceMeter {
  private readonly backend = inject(AgentBackend);
  private readonly runs = inject(RunsService);
  protected readonly report = signal<ResourceReport | null>(null);
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly bytes = fmtBytes;
  protected readonly cpu = fmtCpu;

  protected readonly rows = computed(() => {
    const r = this.report();
    if (!r) return [];
    const runs = this.runs.runs();
    const order = { app: 0, run: 1, warm: 2, other: 3 } as const;
    return [...r.groups].sort((a, b) => order[a.kind] - order[b.kind] || b.memory - a.memory).map((group, i) => {
      const children = group.processes.length;
      const procs = `${children} tiến trình`;
      if (group.kind === 'run') {
        const run = runs.find((x) => x.id === group.runId);
        const live = !!run && (run.status === 'running' || run.status === 'idle');
        return { key: `run:${group.runId}`, group, agent: run?.agent ?? null,
          label: run ? (run.prompt || AGENT_META[run.agent].name).slice(0, 60) : 'Cuộc trò chuyện đã đóng', detail: `${run ? AGENT_META[run.agent].name + ' · ' : ''}${procs}`,
          stop: live, stopTitle: 'Dừng agent của cuộc trò chuyện này' };
      }
      if (group.kind === 'warm') return { key: 'warm', group, agent: null, label: 'Phiên mở sẵn', detail: `${procs}, mở trước để câu đầu trả lời nhanh`, stop: false, stopTitle: '' };
      if (group.kind === 'other') return { key: `other:${i}`, group, agent: null, label: 'Khác', detail: group.processes.map((p) => p.name).join(', '), stop: true, stopTitle: 'Dừng các tiến trình không thuộc cuộc trò chuyện nào' };
      return { key: 'app', group, agent: null, label: 'TG Studio', detail: r.webview ? 'lõi và giao diện' : 'lõi', stop: false, stopTitle: '' };
    });
  });

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const loop = async () => {
      await this.refresh();
      if (!stopped) timer = setTimeout(loop, document.hidden ? HIDDEN_MS : VISIBLE_MS);
    };
    void loop();
    inject(DestroyRef).onDestroy(() => {
      stopped = true;
      clearTimeout(timer);
    });
  }

  protected toggle(): void {
    this.open.set(!this.open());
    if (this.open()) void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      this.report.set(await this.backend.resourceUsage());
      this.error.set(null);
    } catch (e) {
      this.error.set(`Không đo được: ${errorText(e)}`);
    }
  }

  protected async stop(group: UsageGroup): Promise<void> {
    this.busy.set(true);
    try {
      if (group.kind === 'run' && group.runId) await this.runs.stop(group.runId);
      else for (const p of group.processes.filter((x) => !group.processes.some((y) => y.pid === x.parent))) await this.backend.killProcess(p.pid);
      await this.refresh();
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
