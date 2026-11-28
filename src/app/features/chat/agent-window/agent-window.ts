import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AGENT_META } from '../../../services/agents/agent-meta';
import { UiService } from '../../../services/app/ui.service';
import { RunsService } from '../../../services/runs/runs.service';
import { Run, isSubagent, turnStart } from '../../../services/runs/run';
import { costOf } from '../../../services/usage/pricing';
import { WorkspaceService } from '../../../services/workspace.service';
import { AgentAvatar } from '../../../shared/ui/agent-avatar';
import { Mascot } from '../../../shared/ui/mascot';
import { fmtUsd } from '../../../shared/utils/format';
import { errorText } from '../../../shared/utils/errors';
import { mascotPose } from '../dock/dock-mascot';
import { AgentTerminal, TURN_LABEL, canMessage, clock, runEnd, taskOf } from '../conversation/agent-terminal';
import { turnStatus } from '../conversation/turn-status';
import { logSections } from '../../workbench/log-sections';

type Tab = 'live' | 'changes' | 'task';

/**
 * "Mở to": one agent of the conversation over the chat. Left, every agent of the conversation
 * (children under their parent, ↑↓ to switch); right, its full terminal, changes and task.
 */
@Component({
  selector: 'tg-agent-window',
  imports: [AgentAvatar, AgentTerminal, Mascot],
  template: `
    @if (run(); as r) {
      <div class="aw-backdrop" (pointerdown)="ui.closeAgentWindow()"></div>
      <div #dialog class="aw" role="dialog" aria-modal="true" [attr.aria-label]="meta[r.agent].name + ' · ' + task()" tabindex="-1" (keydown)="key($event)">
        <aside class="aw-list" aria-label="Agent trong cuộc trò chuyện">
          <div class="aw-cap">Cuộc trò chuyện này</div>
          <div class="aw-rows" role="listbox" aria-label="Agent">
            @for (s of agents(); track s.run.id) {
              <button class="aw-row" role="option" [class.active]="s.run.id === r.id" [class.nested]="s.nested" [attr.aria-selected]="s.run.id === r.id"
                [attr.data-id]="s.run.id" (click)="ui.agentWindow.set(s.run.id)">
                <tg-agent-avatar [agent]="s.run.agent" [size]="16" />
                <span class="aw-who">
                  <span class="ellipsis aw-name">{{ meta[s.run.agent].name }}@if (s.nested) { · {{ taskOf(s.run.prompt) }} }</span>
                  <span class="aw-state" [attr.data-status]="stateOf(s.run)">{{ labelOf(s.run) }}</span>
                </span>
              </button>
            }
          </div>
          <span class="spacer"></span>
          <div class="mono aw-keys">↑ ↓ đổi agent<br />Enter nhắn riêng<br />Esc đóng</div>
        </aside>
        <section class="aw-main">
          <header class="aw-head">
            <tg-agent-avatar [agent]="r.agent" [size]="20" />
            <strong>{{ meta[r.agent].name }}</strong>
            <span class="ellipsis aw-task" [title]="task()">{{ task() }}@if (parentName(); as p) {<span class="dim"> · việc con của {{ p }}</span>}</span>
            <span class="pill" [attr.data-status]="stateOf(r)">{{ labelOf(r) }}</span>
            <span class="mono dim aw-meta">{{ elapsed() }}@if (cost() !== null) { · {{ usd(cost()) }} }@if (r.context?.percent != null) { · ctx {{ r.context!.percent }}% }</span>
            <button class="aw-icon" (click)="ui.pinLog(r.id)" aria-label="Ghim xuống khung dưới" title="Ghim xuống khung dưới">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/></svg>
            </button>
            @if (r.status === 'running' && !subagent(r)) {
              <button class="aw-icon aw-stop" (click)="runs.stop(r.id)" [attr.aria-label]="'Dừng ' + meta[r.agent].name" title="Dừng">
                <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>
              </button>
            }
            <button class="aw-icon" (click)="ui.closeAgentWindow()" aria-label="Thu về trong chat" title="Thu về trong chat (Esc)">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </header>
          <div class="aw-tabs" role="tablist" aria-label="Nội dung">
            <button role="tab" class="aw-tab" [class.active]="tab() === 'live'" [attr.aria-selected]="tab() === 'live'" (click)="tab.set('live')">Trực tiếp</button>
            <button role="tab" class="aw-tab" [class.active]="tab() === 'changes'" [attr.aria-selected]="tab() === 'changes'" (click)="tab.set('changes')">Thay đổi · {{ files().length }}</button>
            <button role="tab" class="aw-tab" [class.active]="tab() === 'task'" [attr.aria-selected]="tab() === 'task'" (click)="tab.set('task')">Việc được giao</button>
          </div>
          <div class="aw-body" role="tabpanel">
            @switch (tab()) {
              @case ('live') { <tg-agent-terminal [run]="r" [compact]="false" [bare]="true" /> }
              @case ('changes') {
                <div class="aw-files">
                  @for (f of files(); track f.path) {
                    <button class="aw-file mono" (click)="openChanges(r.id)"><span class="aw-fst" [attr.data-st]="f.status">{{ f.status }}</span> {{ f.path }}</button>
                  } @empty {
                    <p class="dim">{{ r.task ? 'Agent này chưa sửa tệp nào.' : 'Agent này không sửa tệp.' }}</p>
                  }
                </div>
              }
              @case ('task') { <pre class="aw-prompt">{{ r.prompt }}</pre> }
            }
          </div>
          @if (dm()) {
            <div class="aw-foot">
              <tg-mascot class="aw-cat" [pose]="pose()" [size]="54" />
              <form class="aw-dm" (submit)="$event.preventDefault(); send(box)">
                <label class="dim aw-dm-label" for="aw-dm">Nhắn riêng cho {{ meta[r.agent].name }}</label>
                <input #box id="aw-dm" class="aw-input" placeholder="Ví dụ: kiểm tra cả bản mobile" autocomplete="off" />
                <button class="aw-send" type="submit" aria-label="Gửi">
                  <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>
                </button>
              </form>
              @if (sendError(); as err) { <p class="aw-err" role="alert">{{ err }}</p> }
            </div>
          }
        </section>
      </div>
    }
  `,
})
export class AgentWindow {
  protected readonly ui = inject(UiService);
  protected readonly runs = inject(RunsService);
  private readonly workspace = inject(WorkspaceService);
  protected readonly meta = AGENT_META;
  protected readonly subagent = isSubagent;
  protected readonly taskOf = taskOf;
  protected readonly tab = signal<Tab>('live');
  protected readonly sendError = signal<string | null>(null);
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');

  protected readonly run = computed(() => {
    const id = this.ui.agentWindow();
    return id ? (this.runs.runs().find((r) => r.id === id) ?? null) : null;
  });
  /** The conversation's agents, children right under the run that started them. */
  protected readonly agents = computed(() =>
    logSections(this.runs.runs(), this.run()?.thread).map((s) => ({ run: s.run, nested: s.role !== 'main' })),
  );
  protected readonly task = computed(() => taskOf(this.run()?.prompt ?? ''));
  protected readonly parentName = computed(() => {
    const id = this.run()?.parent;
    const parent = id ? this.runs.runs().find((r) => r.id === id) : null;
    return parent ? AGENT_META[parent.agent].name : null;
  });
  protected readonly files = computed(() => {
    const id = this.run()?.id;
    return id ? (this.workspace.diffs()[id] ?? []) : [];
  });
  protected readonly dm = computed(() => {
    const r = this.run();
    return !!r && canMessage(r);
  });
  protected readonly cost = computed(() => {
    const r = this.run();
    return r ? costOf(r.agent, r.usage, r.startedAt).usd : null;
  });
  protected readonly elapsed = computed(() => {
    const r = this.run();
    return r ? clock(runEnd(r, r.status === 'running' ? this.runs.now() : 0) - turnStart(r)) : '';
  });
  protected readonly pose = computed(() => {
    const r = this.run();
    return r ? mascotPose(r, { now: this.runs.now(), lastEvent: this.runs.lastEvent()[r.id] }).pose : 'idle';
  });

  constructor() {
    // A run deleted (its conversation removed) while shown: nothing left to show.
    effect(() => {
      if (this.ui.agentWindow() && !this.run()) untracked(() => this.ui.closeAgentWindow());
    });
    // Opened, or another run picked: its changes are read fresh, the draft is dropped and the keys
    // keep working on its row. A new open (even on the same run) starts on Trực tiếp.
    let seen: { opens: number; id: string | null } = { opens: -1, id: null };
    effect(() => {
      const opens = this.ui.agentWindowOpens();
      const id = this.ui.agentWindow();
      const fresh = opens !== seen.opens;
      if (!id || (!fresh && id === seen.id)) {
        seen = { opens, id };
        return;
      }
      seen = { opens, id };
      untracked(() => {
        if (fresh) this.tab.set('live');
        this.sendError.set(null);
        const box = this.box()?.nativeElement;
        if (box) box.value = '';
        if (this.run()?.task) void this.workspace.refresh(id);
        setTimeout(() => this.focusRow(id));
      });
    });
  }

  protected key(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const typing = !!target?.closest('input, textarea');
    // Only the list (or the dialog itself) takes ↑↓ and Enter: the terminal, task and files scroll with them.
    const inList = target === this.dialog()?.nativeElement || !!target?.closest('.aw-list');
    if (e.key === 'Tab') {
      this.trapTab(e);
    } else if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      this.ui.closeAgentWindow();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && inList) {
      e.preventDefault();
      e.stopPropagation();
      this.step(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && !typing && inList) {
      const box = this.box()?.nativeElement;
      if (!box) return;
      e.preventDefault();
      e.stopPropagation();
      box.focus();
    }
  }

  /** aria-modal: Tab and Shift+Tab go round inside the window, never to the chat behind it. */
  private trapTab(e: KeyboardEvent): void {
    const dialog = this.dialog()?.nativeElement;
    if (!dialog) return;
    const all = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!all.length) return;
    const first = all[0];
    const last = all[all.length - 1];
    const at = document.activeElement;
    if (e.shiftKey ? at === first || at === dialog : at === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  private step(by: number): void {
    const list = this.agents();
    const at = list.findIndex((s) => s.run.id === this.ui.agentWindow());
    const next = list[Math.min(list.length - 1, Math.max(0, at + by))];
    if (next) this.ui.agentWindow.set(next.run.id);
  }

  private focusRow(id: string): void {
    const dialog = this.dialog()?.nativeElement;
    if (!dialog) return;
    // Leave the focus where the user is typing.
    if (dialog.contains(document.activeElement) && document.activeElement?.closest('input, textarea')) return;
    const row = [...dialog.querySelectorAll<HTMLElement>('.aw-row')].find((b) => b.dataset['id'] === id);
    (row ?? dialog).focus();
  }

  protected openChanges(runId: string): void {
    this.workspace.open({ kind: 'changes', runId });
    this.ui.sideOpen.set(true);
    this.ui.closeAgentWindow();
  }

  protected async send(box: HTMLInputElement): Promise<void> {
    const r = this.run();
    const text = box.value.trim();
    if (!r || !text) return;
    this.sendError.set(null);
    try {
      await this.runs.sendMessage(r.id, text);
    } catch (e) {
      // Not sent: the words stay for another try.
      if (this.ui.agentWindow() === r.id) this.sendError.set(errorText(e));
      return;
    }
    if (box.value.trim() === text) box.value = '';
  }

  protected stateOf(r: Run) {
    return turnStatus(r);
  }

  protected labelOf(r: Run): string {
    return TURN_LABEL[turnStatus(r)];
  }

  protected usd(n: number | null): string {
    return fmtUsd(n);
  }
}
