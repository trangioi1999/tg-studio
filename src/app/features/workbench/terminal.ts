import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AgentBackend } from '../../core/backend';
import { AGENT_META } from '../../services/agents/agent-meta';
import { TerminalsService } from '../../services/app/terminals.service';
import { RunsService } from '../../services/runs/runs.service';
import { WorkspaceService } from '../../services/workspace.service';
import { Splitter } from '../../shared/ui/splitter';

const TAB_KEY = 'tg.bottom';
type BottomTab = 'log' | 'shell';

function readTab(): BottomTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'log' ? 'log' : 'shell';
  } catch {
    return 'shell';
  }
}

/**
 * Bottom panel. Log: one tab per run of this session, following the selected run.
 * Terminal: the user's shell of the selected conversation, where its agent works.
 */
@Component({
  selector: 'tg-terminal',
  imports: [Splitter],
  template: `
    <div class="term" [class.collapsed]="collapsed()">
      @if (!collapsed()) { <tg-splitter class="split-edge" pane="term" axis="y" target="parent" [grow]="-1" /> }
      <div class="term-tabs" role="tablist" aria-label="Khung dưới">
        <button role="tab" class="term-tab tty-mode" [class.active]="tab() === 'shell'" [attr.aria-selected]="tab() === 'shell'" (click)="show('shell')">Terminal</button>
        <button role="tab" class="term-tab tty-mode" [class.active]="tab() === 'log'" [attr.aria-selected]="tab() === 'log'" (click)="show('log')">Log</button>
        <span class="tty-sep" aria-hidden="true"></span>
        @if (tab() === 'shell') {
          @if (shellState(); as st) {
            <span class="dim mono ellipsis tty-where" [title]="st.cwd">{{ st.shell }} · {{ shortDir(st.cwd) }}</span>
          }
          <span class="spacer"></span>
          @if (key() && cwd()) {
            @if (shellState(); as st) {
              @if (!st.alive) {
                <button class="btn ghost sm" (click)="reopen()">Mở lại</button>
              } @else if (st.cwd !== cwd()) {
                <button class="btn ghost sm" (click)="reopen()" [title]="'Agent đang làm ở ' + cwd()">Mở ở thư mục của agent</button>
              }
            }
          }
        } @else {
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
        }
        <button class="btn ghost sm" [attr.aria-expanded]="!collapsed()" (click)="collapsed.set(!collapsed())">{{ collapsed() ? 'Mở' : 'Thu gọn' }}</button>
      </div>
      @if (!collapsed() && tab() === 'shell') {
        @if (key()) {
          <div #shell class="tty-host"></div>
        } @else {
          <p class="dim term-body">Mở một dự án để dùng terminal.</p>
        }
      }
      @if (!collapsed() && tab() === 'log') {
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
  private readonly backend = inject(AgentBackend);
  private readonly workspace = inject(WorkspaceService);
  private readonly terminals = inject(TerminalsService);
  protected readonly meta = AGENT_META;
  protected readonly tab = signal<BottomTab>(readTab());
  private readonly shell = viewChild<ElementRef<HTMLElement>>('shell');
  /** The conversation whose shell shows: the selected run's, else the open project's. */
  protected readonly key = computed(() => {
    const run = this.runs.selected();
    if (run?.thread) return run.thread;
    const root = this.workspace.project()?.root;
    return root ? `project:${root}` : null;
  });
  /** Where the selected run's agent works; null while it is being asked. */
  protected readonly cwd = signal<string | null>(null);
  protected readonly shellState = computed(() => {
    const key = this.key();
    return key ? (this.terminals.state()[key] ?? null) : null;
  });
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

  protected show(tab: BottomTab): void {
    this.tab.set(tab);
    this.collapsed.set(false);
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch { /* storage off: the choice lasts this session */ }
  }

  protected shortDir(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
  }

  protected reopen(): void {
    const key = this.key();
    const cwd = this.cwd();
    const el = this.shell()?.nativeElement;
    if (key && cwd && el) void this.terminals.reopen(key, cwd, el);
  }

  constructor() {
    // Ask where the selected run works; without a run (or a worktree), the project folder.
    let asked = 0;
    effect(() => {
      const run = this.runs.selected();
      const root = run?.project || this.workspace.project()?.root || null;
      const ticket = ++asked;
      untracked(() => {
        this.cwd.set(null);
        if (!run) return this.cwd.set(root);
        this.backend.runDir(run.id)
          .then((dir) => ticket === asked && this.cwd.set(dir))
          .catch(() => ticket === asked && this.cwd.set(root));
      });
    });
    // Show the conversation's shell when the terminal tab is open.
    effect(() => {
      const el = this.shell()?.nativeElement;
      const key = this.key();
      const cwd = this.cwd();
      if (!el || !key || !cwd) return;
      untracked(() => void this.terminals.attach(key, cwd, el));
    });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const key = this.key();
      if (key) this.terminals.resize(key);
    });
    effect(() => {
      const el = this.shell()?.nativeElement;
      observer?.disconnect();
      if (el) observer?.observe(el);
    });
    inject(DestroyRef).onDestroy(() => observer?.disconnect());
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
