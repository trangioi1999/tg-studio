import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { fmtDuration, fmtUsd } from '../../../shared/utils/format';
import { costOf } from '../../../services/usage/pricing';
import { AgentId, Delegation } from '../../../core/protocol';
import { AGENT_META } from '../../../services/agents/agent-meta';
import { RunsService } from '../../../services/runs/runs.service';
import { Run, isSubagent, turnStart } from '../../../services/runs/run';
import { runEnd } from './agent-terminal';
import { WorkspaceService } from '../../../services/workspace.service';
import { UiService } from '../../../services/app/ui.service';
import { AgentAvatar } from '../../../shared/ui/agent-avatar';
import { plainText } from '../../../shared/utils/plain-text';
import { AgentTerminal, taskOf } from './agent-terminal';

type State = 'needs_you' | 'running' | 'waiting' | 'failed' | 'stopped';

interface Item {
  key: string;
  /** Order among saved delegations (no report, not a subagent), matching the saved markers. */
  ord: number | null;
  agent: AgentId;
  task: string;
  run: Run | null;
  delegation: Delegation | null;
  state: State;
  label: string;
  /** What it is doing now, or how it ended. */
  now: string;
}

const LABEL: Record<Delegation['status'], [State, string]> = {
  waiting_approval: ['needs_you', 'Chờ bạn cho phép'],
  running: ['running', 'Đang chạy'],
  done: ['waiting', 'Xong'],
  failed: ['failed', 'Lỗi'],
  stopped: ['stopped', 'Đã dừng'],
  refused: ['stopped', 'Không giao'],
  conflict: ['needs_you', 'Xung đột'],
};

/** The agents a run delegated to, nested in its message: one row each, opened in place. */
@Component({
  selector: 'tg-delegations',
  imports: [AgentAvatar, AgentTerminal],
  template: `
    @if (items().length) {
      <section class="dlg" aria-label="Việc đã giao cho agent khác">
        @for (it of items(); track it.key) {
          <div class="dlg-item" [class.open]="isOpen(it)">
            @if (isOpen(it)) {
              <tg-agent-terminal [run]="it.run!" (collapse)="toggle(it.key)" />
            } @else {
              <div class="dlg-head">
                <button class="dlg-toggle" [attr.data-run]="it.run?.id ?? null" (click)="toggle(it.key)" [disabled]="!it.run" [attr.aria-expanded]="false"
                  [title]="it.run ? 'Xem agent này làm gì' : ''">
                  <svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
                  <tg-agent-avatar [agent]="it.agent" [size]="18" />
                  <strong>{{ meta[it.agent].name }}</strong>
                  <span class="ellipsis dlg-task" [title]="it.task">{{ it.task }}</span>
                </button>
                <span class="pill" [attr.data-status]="it.state">
                  @if (it.state === 'running') { <span class="spin" aria-hidden="true"></span> }
                  {{ it.label }}
                </span>
                @if (it.run) { <span class="mono dim dlg-meta">{{ duration(it.run) }}@if (cost(it.run) !== null) { · {{ usd(cost(it.run)) }} }</span> }
                @if (it.run?.status === 'running' && !subagent(it.run)) {
                  <button class="btn ghost sm" (click)="runs.stop(it.run!.id)">Dừng</button>
                }
                @if (it.delegation?.worktree && it.run) {
                  <button class="btn ghost sm" (click)="review(it.run!.id)">Xem thay đổi</button>
                }
              </div>
              @if (it.now) { <div class="dlg-now dim ellipsis" [title]="it.now">{{ it.now }}</div> }
            }
          </div>
        }
      </section>
    }
  `,
})
export class Delegations {
  protected readonly runs = inject(RunsService);
  private readonly workspace = inject(WorkspaceService);
  private readonly ui = inject(UiService);
  readonly parent = input.required<Run>();
  /** Only these (a delegation id, or a saved one's order): the ones made at this point of the chat. */
  readonly only = input<readonly (string | number)[] | null>(null);
  /** All but these: the ones no marker placed, at the end of the run. */
  readonly except = input<readonly (string | number)[]>([]);
  /**
   * The agent's own subagents (`<parent>~n`): no marker places them, so by default they sit in
   * the end block. True puts them in this block too; false keeps them out of the end block.
   */
  readonly subagents = input<boolean | null>(null);
  protected readonly meta = AGENT_META;
  /** Stopping one subagent alone has no command; stopping the parent stops them all. */
  protected readonly subagent = isSubagent;
  /**
   * One agent open at a time in a message; a finished one folds back to its summary row. Kept in
   * {@link UiService} by parent, since one message can hold several of these (one per marker).
   */
  protected readonly opened = computed(() => this.ui.openDelegation()[this.parent().id] ?? null);
  private watched: { key: string | null; status: string | null } = { key: null, status: null };

  protected readonly items = computed<Item[]>(() => {
    const only = this.only();
    const except = this.except();
    const subagents = this.subagents();
    const hit = (it: Item, refs: readonly (string | number)[]) => refs.some((r) => (typeof r === 'number' ? it.ord === r : it.key === r));
    const sub = (it: Item) => !!it.run && isSubagent(it.run);
    return this.all().filter((it) => (only
      ? hit(it, only) || (subagents === true && sub(it))
      : !hit(it, except) && !(subagents === false && sub(it))));
  });

  private readonly all = computed<Item[]>(() => {
    const parent = this.parent();
    const children = this.runs.runs().filter((r) => r.parent === parent.id);
    const delegations = parent.delegations ?? [];
    const items: Item[] = delegations.map((d) => {
      const run = children.find((r) => r.id === d.child) ?? null;
      const [state, label] = run?.permissions.length ? (['needs_you', 'Chờ bạn duyệt'] as [State, string]) : LABEL[d.status];
      return { key: d.id, ord: null, agent: d.agent, task: d.task, run, delegation: d, state, label, now: this.nowOf(run, d) };
    });
    // History has the child runs but not the delegation reports. An agent's own subagent
    // (`<parent>~n`) was not delegated through tg-bridge, so no marker counts it.
    const saved = children.filter((r) => !delegations.some((d) => d.child === r.id)).sort((a, b) => a.startedAt - b.startedAt);
    let ord = 0;
    for (const run of saved) {
      const [state, label] = this.stateOf(run);
      const sub = isSubagent(run);
      items.push({ key: run.id, ord: sub ? null : ord++, agent: run.agent, task: taskOf(run.prompt), run, delegation: null, state, label, now: this.nowOf(run, null) });
    }
    return items;
  });

  constructor() {
    effect(() => {
      const key = this.opened();
      const status = this.all().find((it) => it.key === key)?.run?.status ?? null;
      untracked(() => {
        // Only a run seen finishing folds: one opened from history stays open.
        if (key && this.watched.key === key && this.watched.status === 'running' && status !== 'running' && status !== 'idle') this.setOpened(null);
        this.watched = { key, status };
      });
    });
  }

  protected isOpen(it: Item): boolean {
    return this.opened() === it.key && !!it.run;
  }

  protected toggle(key: string): void {
    this.setOpened(this.opened() === key ? null : key);
  }

  private setOpened(key: string | null): void {
    const parent = this.parent().id;
    this.ui.openDelegation.update((all) => {
      const { [parent]: _, ...rest } = all;
      return key ? { ...rest, [parent]: key } : rest;
    });
  }

  protected review(runId: string): void {
    this.workspace.open({ kind: 'changes', runId });
  }

  protected cost(r: Run): number | null {
    return costOf(r.agent, r.usage, r.startedAt).usd;
  }

  protected usd(n: number | null): string {
    return fmtUsd(n);
  }

  protected duration(r: Run): string {
    return fmtDuration(Math.max(0, runEnd(r, this.runs.now()) - turnStart(r)));
  }

  private stateOf(run: Run): [State, string] {
    if (run.permissions.length) return ['needs_you', 'Chờ bạn duyệt'];
    if (run.status === 'running') return ['running', 'Đang chạy'];
    if (run.status === 'failed') return ['failed', 'Lỗi'];
    if (run.status === 'stopped' || run.status === 'interrupted') return ['stopped', 'Đã dừng'];
    return ['waiting', 'Xong'];
  }

  private nowOf(run: Run | null, d: Delegation | null): string {
    if (d?.status === 'conflict') return `${d.conflicts.length} tệp xung đột: ${d.conflicts.join(', ')}. Agent cha đang gộp.`;
    if (d && (d.status === 'refused' || d.status === 'failed') && d.summary) return d.summary;
    if (d?.status === 'done' && d.filesChanged.length) return `Đã gộp ${d.filesChanged.length} tệp: ${d.filesChanged.join(', ')}`;
    if (!run) return d?.status === 'waiting_approval' ? 'Đang chờ bạn cho phép giao việc này.' : '';
    // What it did last, marked the same way for a delegated agent and a subagent.
    const last = run.lines.filter((l) => l.tone === 'tool' || l.tone === 'text').at(-1);
    const first = last ? (last.tone === 'text' ? plainText(last.text) : last.text).split('\n')[0] : '';
    const text = first.replace(/^›\s*/, '').replace(/\s[✓✕]$/, '').trim();
    return text ? `› ${text}` : '';
  }
}

export { taskOf };
