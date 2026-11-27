import { afterRenderEffect, Component, computed, ElementRef, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { Run, turnStart } from '../../../services/runs/run';
import { AGENT_META } from '../../../services/agents/agent-meta';
import { RunsService } from '../../../services/runs/runs.service';
import { UiService } from '../../../services/app/ui.service';
import { costOf } from '../../../services/usage/pricing';
import { AgentAvatar } from '../../../shared/ui/agent-avatar';
import { Mascot } from '../../../shared/ui/mascot';
import { fmtUsd } from '../../../shared/utils/format';
import { mascotPose } from '../dock/dock-mascot';
import { liveTokens } from '../dock/live-status';
import { StepState, segmentsOf } from './timeline';
import { ToolHead, middleTruncate } from './tool-step';
import { turnStatus } from './turn-status';

export interface TermLine {
  kind: 'prompt' | 'step' | 'text' | 'status';
  text: string;
  state?: StepState;
  head?: ToolHead;
  result?: string;
}

/** The delegated task without the note TG Studio adds for the agent. */
export function taskOf(prompt: string): string {
  return prompt.replace(/\n\n\(Việc được [\s\S]*$/, '').replace(/\n\nTệp liên quan: .*$/, '').trim();
}

/** m:ss, as a terminal clock. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The task, each step CLI-style and the agent's messages: everything but the clock, so it only changes with the run. */
export function terminalBody(run: Run): TermLine[] {
  const body: TermLine[] = [{ kind: 'prompt', text: taskOf(run.prompt) }];
  for (const seg of segmentsOf(run.lines, run.status === 'running')) {
    if (seg.kind === 'text') body.push({ kind: 'text', text: seg.text });
    else if (seg.kind === 'work') {
      for (const st of seg.steps) {
        const result = st.diff ? `+${st.diff.added} −${st.diff.removed}` : st.result;
        body.push({ kind: 'step', text: st.text, state: st.state, ...(st.head ? { head: st.head } : {}), ...(result ? { result } : {}) });
      }
    }
  }
  return body;
}

/** The last `max` lines of `body`, plus a status line while the run runs; `hidden` counts the ones cut. */
export function fitTerminal(run: Run, body: TermLine[], max: number, now: number): { lines: TermLine[]; hidden: number } {
  const status = run.status === 'running' ? statusLine(run, body, now) : null;
  const room = Math.max(0, max - (status ? 1 : 0));
  const kept = body.length > room ? body.slice(body.length - room) : body;
  return { lines: status ? [...kept, status] : kept, hidden: body.length - kept.length };
}

/**
 * What a run shows as a terminal: the task, each step CLI-style, the agent's messages, and while it
 * runs a last status line. Only the last `max` lines are kept; `hidden` counts the ones before.
 */
export function terminalLines(run: Run, max: number, now: number = Date.now()): { lines: TermLine[]; hidden: number } {
  return fitTerminal(run, terminalBody(run), max, now);
}

/** Where the turn's clock stops: now while running, else when it ended (an idle session does not tick). */
export function runEnd(run: Run, now: number): number {
  return run.status === 'running' ? now : run.endedAt ?? turnStart(run);
}

function statusLine(run: Run, body: TermLine[], now: number): TermLine {
  const step = run.progress?.step ?? [...body].reverse().find((l) => l.kind === 'step' && l.state === 'running')?.text ?? 'đang suy nghĩ…';
  const t = run.live ? ` · ${liveTokens(run.live)}` : '';
  return { kind: 'status', text: `${step} (${clock(now - turnStart(run))}${t})` };
}

/** Whether the user can write to this agent on its own: an open session, not a one-shot child. */
export function canMessage(run: Run): boolean {
  // A tg-bridge child runs one turn and a subagent has no session of its own: neither takes a message.
  if (run.parent) return false;
  if (run.status === 'idle') return !run.restored;
  return run.status === 'running' && run.agent === 'claude';
}

/** A delegated agent as a small terminal: header, the last lines of its work, a box to message it. */
@Component({
  selector: 'tg-agent-terminal',
  imports: [AgentAvatar, Mascot],
  template: `
    @let r = run();
    <section class="at" [class.compact]="compact()" [attr.aria-label]="'Terminal của ' + meta[r.agent].name">
      <header class="at-head">
        <button class="at-icon" (click)="collapse.emit()" aria-label="Thu lại" title="Thu lại">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <tg-mascot [pose]="pose()" [size]="22" />
        <tg-agent-avatar [agent]="r.agent" [size]="18" />
        <strong>{{ meta[r.agent].name }}</strong>
        <span class="ellipsis at-task" [title]="task()">{{ task() }}</span>
        <span class="pill" [attr.data-status]="status()">{{ label() }}</span>
        <span class="mono dim at-meta">{{ elapsed() }}@if (cost() !== null) { · {{ usd(cost()) }} }@if (r.context?.percent != null) { · ctx {{ r.context!.percent }}% }</span>
        @if (r.status === 'running') { <button class="btn ghost sm" (click)="runs.stop(r.id)">Dừng</button> }
        <button class="at-icon" (click)="open($event)" aria-label="Mở to" title="Mở to">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>
        </button>
      </header>
      <div class="at-screen mono" #screen (scroll)="onScroll()" role="log" aria-live="off" tabindex="0">
        @if (view().hidden > 0 && !all()) {
          <button class="at-more" (click)="all.set(true)">Hiện {{ view().hidden }} dòng trước</button>
        }
        @for (l of view().lines; track $index) {
          @switch (l.kind) {
            @case ('prompt') { <div class="at-line at-prompt"><span class="at-p" aria-hidden="true">❯</span> {{ l.text }}</div> }
            @case ('text') { <div class="at-line at-text">{{ l.text }}</div> }
            @case ('status') { <div class="at-line at-status"><span aria-hidden="true">✻</span> {{ l.text }}</div> }
            @default {
              <div class="at-line at-step" [attr.data-state]="l.state">
                @if (l.head; as h) {
                  <span class="at-dot" aria-hidden="true">●</span> <b>{{ h.name }}</b>@if (h.arg !== null) {<span class="at-arg" [title]="h.arg">({{ trunc(h.arg) }})</span>}
                } @else {
                  <span class="at-dot" aria-hidden="true">●</span> {{ l.text }}
                }
                @if (l.result) { <div class="at-result">└ {{ l.result }}</div> }
              </div>
            }
          }
        }
        @if (fresh()) { <button class="at-new" (click)="jump()">↓ Dòng mới</button> }
      </div>
      @if (dm()) {
        <form class="at-dm" (submit)="$event.preventDefault(); send(box)">
          <input #box class="at-input" [placeholder]="'Nhắn riêng ' + meta[r.agent].name" [attr.aria-label]="'Nhắn riêng ' + meta[r.agent].name" autocomplete="off" />
        </form>
      }
    </section>
  `,
})
export class AgentTerminal {
  protected readonly runs = inject(RunsService);
  private readonly ui = inject(UiService);
  readonly run = input.required<Run>();
  /** True: a fixed 10 lines tall. False: fills its parent (the big window). */
  readonly compact = input(true);
  readonly maxLines = input(500);
  readonly collapse = output<void>();
  protected readonly meta = AGENT_META;
  protected readonly all = signal(false);
  protected readonly fresh = signal(false);
  private readonly screen = viewChild<ElementRef<HTMLElement>>('screen');
  private following = true;
  private seen = 0;

  /** Rebuilt only when the run changes; the clock below re-reads `now` every second. */
  private readonly body = computed(() => terminalBody(this.run()));
  protected readonly view = computed(() => {
    const r = this.run();
    const now = r.status === 'running' ? this.runs.now() : 0;
    return fitTerminal(r, this.body(), this.all() ? Number.MAX_SAFE_INTEGER : this.maxLines(), now);
  });
  protected readonly task = computed(() => taskOf(this.run().prompt));
  protected readonly status = computed(() => turnStatus(this.run()));
  protected readonly label = computed(() => ({ running: 'Đang chạy', needs_you: 'Chờ bạn duyệt', waiting: 'Xong', failed: 'Lỗi', stopped: 'Đã dừng' })[this.status()]);
  protected readonly dm = computed(() => canMessage(this.run()));
  protected readonly cost = computed(() => { const r = this.run(); return costOf(r.agent, r.usage, r.startedAt).usd; });
  protected readonly elapsed = computed(() => { const r = this.run(); return clock(runEnd(r, r.status === 'running' ? this.runs.now() : 0) - turnStart(r)); });
  protected readonly pose = computed(() => { const r = this.run(); return mascotPose(r, { now: this.runs.now(), lastEvent: this.runs.lastEvent()[r.id] }).pose; });

  constructor() {
    afterRenderEffect(() => {
      const n = this.view().lines.length;
      const el = this.screen()?.nativeElement;
      if (!el) return;
      untracked(() => {
        if (this.following) {
          el.scrollTop = el.scrollHeight;
          this.fresh.set(false);
        } else if (n > this.seen) this.fresh.set(true);
        this.seen = n;
      });
    });
  }

  protected onScroll(): void {
    const el = this.screen()?.nativeElement;
    if (!el) return;
    this.following = el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
    if (this.following) this.fresh.set(false);
  }

  protected jump(): void {
    const el = this.screen()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
    this.following = true;
    this.fresh.set(false);
  }

  protected open(e: Event): void {
    this.ui.openAgentWindow(this.run().id, e.currentTarget as HTMLElement);
  }

  protected async send(box: HTMLInputElement): Promise<void> {
    const text = box.value.trim();
    if (!text) return;
    box.value = '';
    await this.runs.sendMessage(this.run().id, text);
  }

  protected trunc(s: string): string {
    return middleTruncate(s);
  }

  protected usd(n: number | null): string {
    return fmtUsd(n);
  }
}
