import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AgentBackend } from '../../core/backend';
import { AGENT_META } from '../../services/agents/agent-meta';
import { TerminalsService } from '../../services/app/terminals.service';
import { RunsService } from '../../services/runs/runs.service';
import { WorkspaceService } from '../../services/workspace.service';
import { Splitter } from '../../shared/ui/splitter';
import { AgentAvatar } from '../../shared/ui/agent-avatar';
import { AgentId } from '../../core/protocol';
import { RUN_STATUS_LABEL } from '../../services/runs/run';
import { copyText } from '../../shared/utils/clipboard';
import { LogSection, filterSections, logSections, logText, sectionTitle } from './log-sections';

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
 * Bottom panel. Log: the selected conversation's runs, sub-agents included, in one
 * chat-like log with filters (it does not change which conversation is open).
 * Terminal: the user's shell of the selected conversation, where its agent works.
 */
@Component({
  selector: 'tg-terminal',
  imports: [AgentAvatar, Splitter],
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
          <span class="spacer"></span>
          @for (r of runningInThread(); track r.id) {
            <button class="btn ghost sm" (click)="runs.stop(r.id)">Dừng {{ meta[r.agent].name }}</button>
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
        <div class="lg-tools">
          @if (logAgents().length > 1) {
            <span class="lg-chips" role="group" aria-label="Lọc theo agent">
              <button class="lg-chip" [class.active]="!logAgent()" [attr.aria-pressed]="!logAgent()" (click)="logAgent.set(null)">Tất cả</button>
              @for (a of logAgents(); track a) {
                <button class="lg-chip" [class.active]="logAgent() === a" [attr.aria-pressed]="logAgent() === a" (click)="logAgent.set(logAgent() === a ? null : a)">
                  <tg-agent-avatar [agent]="a" [size]="14" />{{ meta[a].name }}
                </button>
              }
            </span>
          }
          <button class="lg-chip" [class.active]="errorsOnly()" [attr.aria-pressed]="errorsOnly()" (click)="errorsOnly.set(!errorsOnly())">Chỉ lỗi</button>
          <input class="lg-search" type="search" placeholder="Tìm trong log" aria-label="Tìm trong log" [value]="logQuery()" (input)="logQuery.set($any($event.target).value)" />
          @if (sections().length) {
            <button class="lg-copy" [class.done]="copied()" (click)="copyLog()" [title]="copied() ? 'Đã chép' : 'Chép log đang hiện (theo bộ lọc)'" [attr.aria-label]="copied() ? 'Đã chép' : 'Chép log đang hiện'">
              @if (copied()) { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg> }
              @else { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg> }
            </button>
          }
        </div>
        <div #body class="term-body lg-body">
          @for (s of shownSections(); track s.run.id) {
            <section class="lg-sec" [attr.data-role]="s.role" [attr.aria-label]="title(s)">
              <header class="lg-head">
                @if (s.role !== 'main') { <span class="lg-arrow" aria-hidden="true">↳</span> }
                <tg-agent-avatar [agent]="s.run.agent" [size]="18" />
                <strong>{{ title(s) }}</strong>
                @if (s.role !== 'main' && s.run.prompt) { <span class="lg-task ellipsis" [title]="s.run.prompt">{{ s.run.prompt }}</span> }
                <span class="spacer"></span>
                <span class="dim mono">{{ clock(s.run.startedAt) }}</span>
                <span class="pill" [attr.data-status]="s.run.status">{{ statusLabel[s.run.status] }}</span>
              </header>
              @for (e of s.entries; track $index) {
                @if (e.kind === 'user') {
                  <div class="lg-user">@if (e.text) {<span>{{ e.text }}</span>}@if (e.files) {<span class="dim">📎 {{ e.files }} tệp</span>}</div>
                } @else {
                  <div class="line lg-line mono" [attr.data-tone]="e.line.tone">{{ e.line.text }}</div>
                }
              } @empty {
                <div class="dim lg-line">Chưa có dòng log nào.</div>
              }
            </section>
          } @empty {
            <p class="dim">{{ sections().length ? 'Không có dòng nào khớp bộ lọc.' : 'Log của cuộc trò chuyện sẽ hiện ở đây: mọi agent, kể cả agent con, theo thứ tự.' }}</p>
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
  protected readonly statusLabel = RUN_STATUS_LABEL;
  protected readonly sections = computed(() => logSections(this.runs.runs(), this.runs.selected()?.thread));
  protected readonly logAgent = signal<AgentId | null>(null);
  protected readonly errorsOnly = signal(false);
  protected readonly logQuery = signal('');
  protected readonly logAgents = computed(() => [...new Set(this.sections().map((s) => s.run.agent))]);
  protected readonly shownSections = computed(() => filterSections(this.sections(), { agent: this.logAgent(), errorsOnly: this.errorsOnly(), query: this.logQuery() }));
  protected readonly runningInThread = computed(() => this.sections().map((s) => s.run).filter((r) => r.status === 'running'));
  protected readonly copied = signal(false);

  protected title(s: LogSection): string { return sectionTitle(s); }
  protected clock(ms: number): string { return new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }); }

  protected async copyLog(): Promise<void> {
    if (!(await copyText(logText(this.shownSections())))) return;
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

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
    // Another conversation: its filters start over.
    effect(() => {
      this.runs.selected()?.thread;
      untracked(() => { this.logAgent.set(null); this.errorsOnly.set(false); this.logQuery.set(''); });
    });
    effect(() => {
      this.shownSections().reduce((n, s) => n + s.entries.length, 0);
      const el = this.body()?.nativeElement;
      if (!el) return;
      if (!el.onscroll) el.onscroll = () => (pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24);
      if (pinned) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }
}
