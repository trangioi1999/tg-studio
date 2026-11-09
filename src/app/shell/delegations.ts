import { Component, computed, inject, input, signal } from '@angular/core';
import { fmtDuration, fmtUsd } from '../core/format';
import { estimateCost } from '../core/pricing';
import { AGENT_META, AgentId, Delegation } from '../core/protocol';
import { Run, RunsService, turnStart } from '../core/runs.service';
import { segmentsOf } from '../core/timeline';
import { WorkspaceService } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';
import { Markdown } from './markdown';

type State = 'needs_you' | 'running' | 'waiting' | 'failed' | 'stopped';

interface Item {
  key: string;
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
  imports: [AgentAvatar, Markdown],
  template: `
    @if (items().length) {
      <section class="dlg" aria-label="Việc đã giao cho agent khác">
        @for (it of items(); track it.key) {
          <div class="dlg-item" [class.open]="opened().has(it.key)">
            <div class="dlg-head">
              <button class="dlg-toggle" (click)="toggle(it.key)" [disabled]="!it.run" [attr.aria-expanded]="opened().has(it.key)"
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
              @if (it.run?.status === 'running') {
                <button class="btn ghost sm" (click)="runs.stop(it.run!.id)">Dừng</button>
              }
              @if (it.delegation?.worktree && it.run) {
                <button class="btn ghost sm" (click)="review(it.run!.id)">Xem thay đổi</button>
              }
            </div>
            @if (it.now) { <div class="dlg-now dim ellipsis" [title]="it.now">{{ it.now }}</div> }
            @if (opened().has(it.key) && it.run) {
              <div class="dlg-body">
                @for (seg of segments(it.run); track $index) {
                  @switch (seg.kind) {
                    @case ('text') { <tg-markdown class="msg-agent" [text]="seg.text" /> }
                    @case ('work') {
                      <ol class="dlg-steps">
                        @for (st of seg.steps; track $index) {
                          <li [attr.data-state]="st.state"><span class="mono ellipsis" [title]="st.text">{{ st.text }}</span></li>
                        }
                      </ol>
                    }
                  }
                }
              </div>
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
  readonly parent = input.required<Run>();
  protected readonly meta = AGENT_META;
  protected readonly opened = signal<Set<string>>(new Set());

  protected readonly items = computed<Item[]>(() => {
    const parent = this.parent();
    const children = this.runs.runs().filter((r) => r.parent === parent.id);
    const delegations = parent.delegations ?? [];
    const items: Item[] = delegations.map((d) => {
      const run = children.find((r) => r.id === d.child) ?? null;
      const [state, label] = run?.permissions.length ? (['needs_you', 'Chờ bạn duyệt'] as [State, string]) : LABEL[d.status];
      return { key: d.id, agent: d.agent, task: d.task, run, delegation: d, state, label, now: this.nowOf(run, d) };
    });
    // History has the child runs but not the delegation reports.
    for (const run of children.filter((r) => !delegations.some((d) => d.child === r.id))) {
      const [state, label] = this.stateOf(run);
      items.push({ key: run.id, agent: run.agent, task: taskOf(run.prompt), run, delegation: null, state, label, now: this.nowOf(run, null) });
    }
    return items;
  });

  protected toggle(key: string): void {
    this.opened.update((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  protected review(runId: string): void {
    this.workspace.open({ kind: 'changes', runId });
  }

  protected segments(run: Run) {
    return segmentsOf(run.lines, run.status === 'running');
  }

  protected cost(r: Run): number | null {
    return r.usage ? (r.usage.costUsd ?? estimateCost(r.agent, r.usage, r.startedAt)) : null;
  }

  protected usd(n: number | null): string {
    return fmtUsd(n);
  }

  protected duration(r: Run): string {
    return fmtDuration(Math.max(0, (r.endedAt ?? this.runs.now()) - turnStart(r)));
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
    const last = run.lines.filter((l) => l.tone === 'tool' || l.tone === 'text').at(-1);
    return last?.text.split('\n')[0] ?? '';
  }
}

/** The delegated task without the note TG Studio adds for the agent. */
export function taskOf(prompt: string): string {
  return prompt.replace(/\n\n\(Việc được [\s\S]*$/, '').replace(/\n\nTệp liên quan: .*$/, '').trim();
}
