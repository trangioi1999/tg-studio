import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { AGENT_META } from '../agents/agent-meta';
import { RunsService } from '../core/runs.service';
import { Splitter } from './splitter';

/** Bottom panel: one log tab per run of this session, following the selected run. */
@Component({
  selector: 'tg-terminal',
  imports: [Splitter],
  template: `
    <div class="term" [class.collapsed]="collapsed()">
      @if (!collapsed()) { <tg-splitter class="split-edge" pane="term" axis="y" target="parent" [grow]="-1" /> }
      <div class="term-tabs" role="tablist" aria-label="Log theo agent">
        @for (r of tabs(); track r.id) {
          <button role="tab" class="term-tab" [class.active]="r.id === shown()?.id" [attr.aria-selected]="r.id === shown()?.id" (click)="runs.selectedId.set(r.id); collapsed.set(false)">
            <span class="dot" [style.background]="meta[r.agent].color" [class.live]="r.status === 'running'"></span>
            {{ meta[r.agent].name }}
          </button>
        }
        <span class="spacer"></span>
        @if (shown(); as r) {
          @if (r.status === 'running') { <button class="btn ghost sm" (click)="runs.stop(r.id)">Dừng</button> }
        }
        <button class="btn ghost sm" [attr.aria-expanded]="!collapsed()" (click)="collapsed.set(!collapsed())">{{ collapsed() ? 'Mở log' : 'Thu gọn' }}</button>
      </div>
      @if (!collapsed()) {
        <div #body class="term-body mono">
          @if (shown(); as r) {
            @for (l of r.lines; track $index) { <div class="line" [attr.data-tone]="l.tone">{{ l.text }}</div> }
          } @else {
            <p class="dim">Log của agent sẽ hiện ở đây.</p>
          }
        </div>
      }
    </div>
  `,
})
export class Terminal {
  protected readonly runs = inject(RunsService);
  protected readonly meta = AGENT_META;
  /** The thread shows the same run; the raw log is there when asked for. */
  protected readonly collapsed = signal(true);
  private readonly body = viewChild<ElementRef<HTMLElement>>('body');
  protected readonly shown = computed(() => this.runs.selected());
  /** Recent runs of this session, plus the selected one if it is older. */
  protected readonly tabs = computed(() => {
    const recent = this.runs.sessionRuns().slice(0, 6);
    const sel = this.shown();
    return sel && !recent.some((r) => r.id === sel.id) ? [sel, ...recent.slice(0, 5)] : recent;
  });

  constructor() {
    // Stay at the bottom as lines arrive, unless the user scrolled up to read.
    let pinned = true;
    effect(() => {
      this.shown()?.lines.length;
      const el = this.body()?.nativeElement;
      if (!el) return;
      if (!el.onscroll) el.onscroll = () => (pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24);
      if (pinned) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }
}
