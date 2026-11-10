import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { fmtDuration, fmtTokens, fmtUsd } from '../../shared/utils/format';
import { AgentId } from '../../core/protocol';
import { AGENT_IDS, AGENT_META } from '../../services/agents/agent-meta';
import { RunsService } from '../../services/runs/runs.service';
import { Run, RUN_STATUS_LABEL } from '../../services/runs/run';
import { ConsoleView, UiService } from '../../services/app/ui.service';
import { WorkspaceService } from '../../services/workspace.service';
import { AgentAvatar } from '../../shared/ui/agent-avatar';
import { errorText } from '../../shared/utils/errors';

interface QueueItem {
  key: string;
  kind: 'approve' | 'review' | 'commit';
  run: Run;
  detail: string;
  view: ConsoleView;
}

const TIMELINE_RUNS = 12;

/**
 * Everything the agents are doing in this session: a timeline with approval waits,
 * one column per agent, and the queue of things waiting on the user.
 */
@Component({
  selector: 'tg-mission-control',
  imports: [AgentAvatar],
  template: `
    <div class="mission">
      <section class="kpis" aria-label="Tổng quan">
        <div class="kpi"><span class="label">ĐANG CHẠY</span><strong>{{ runs.running().length }}</strong></div>
        <div class="kpi" [class.attention]="waiting() > 0"><span class="label">CHỜ DUYỆT</span><strong>{{ waiting() }}</strong></div>
        <div class="kpi"><span class="label">CHỜ REVIEW</span><strong>{{ reviewCount() }}</strong></div>
        <div class="kpi"><span class="label">LƯỢT CHẠY</span><strong>{{ runs.sessionRuns().length }}</strong></div>
        <div class="kpi"><span class="label">TOKEN</span><strong>{{ tok(runs.totals().tokens) }}</strong></div>
        <div class="kpi"><span class="label">CHI PHÍ</span><strong>{{ usd(runs.totals().costUsd) }}</strong></div>
      </section>

      <section class="mission-block" aria-label="Hàng chờ">
        <div class="block-head"><span class="label">HÀNG CHỜ CỦA BẠN</span><span class="dim">{{ queue().length + runs.handoffs().length }}</span></div>
        @for (h of runs.handoffs(); track h.id) {
          <div class="queue-row handoff-row" [style.--agent]="meta[h.agent].color">
            <span class="queue-kind" data-kind="handoff">Chuyển việc</span>
            <tg-agent-avatar [agent]="h.from" [size]="16" /><span class="dim">→</span><tg-agent-avatar [agent]="h.agent" [size]="16" />
            <span class="ellipsis">{{ h.task }}</span>
            <span class="spacer"></span>
            <button class="btn ghost sm" (click)="runs.dismissHandoff(h.id)">Bỏ qua</button>
            <button class="btn primary sm" [disabled]="busy()" (click)="acceptHandoff(h.id)">Giao cho {{ meta[h.agent].name }}</button>
          </div>
        }
        @if (error()) { <p class="error-text pad" role="alert">{{ error() }}</p> }
        @for (q of queue(); track q.key) {
          <button class="queue-row" (click)="ui.openRun(q.run.id, q.view)" [style.--agent]="meta[q.run.agent].color">
            <span class="queue-kind" [attr.data-kind]="q.kind">{{ kindLabel[q.kind] }}</span>
            <tg-agent-avatar [agent]="q.run.agent" [size]="16" />
            <span class="ellipsis">{{ q.run.prompt || meta[q.run.agent].name }}</span>
            <span class="spacer"></span>
            <span class="dim mono ellipsis">{{ q.detail }}</span>
          </button>
        } @empty {
          @if (!runs.handoffs().length) { <p class="dim pad">Không có gì chờ bạn.</p> }
        }
      </section>

      <section class="mission-block" aria-label="Timeline">
        <div class="block-head">
          <span class="label">TIMELINE</span>
          <span class="spacer"></span>
          <span class="legend"><i class="lg-run"></i>chạy</span>
          <span class="legend"><i class="lg-wait"></i>chờ duyệt</span>
          <span class="dim mono">{{ span() }}</span>
        </div>
        @for (row of timeline(); track row.run.id) {
          <button class="tl-row" (click)="ui.openRun(row.run.id)" [attr.aria-label]="meta[row.run.agent].name + ': ' + row.run.prompt + ', ' + statusLabel[row.run.status]">
            <span class="tl-name">
              <tg-agent-avatar [agent]="row.run.agent" [size]="14" />
              <span class="ellipsis">{{ row.run.prompt || meta[row.run.agent].name }}</span>
            </span>
            <span class="tl-track">
              <span class="tl-bar" [attr.data-status]="row.run.status" [style.left.%]="row.left" [style.width.%]="row.width" [style.--agent]="meta[row.run.agent].color">
                @for (w of row.waits; track $index) { <span class="tl-wait" [style.left.%]="w.left" [style.width.%]="w.width"></span> }
              </span>
            </span>
            <span class="status" [attr.data-status]="row.run.status">{{ statusLabel[row.run.status] }}</span>
          </button>
        } @empty {
          <p class="dim pad">Chưa có lượt chạy nào trong phiên này.</p>
        }
      </section>

      <section class="agent-columns" aria-label="Theo agent">
        @for (c of columns(); track c.agent) {
          <div class="agent-col" [style.--agent]="meta[c.agent].color">
            <div class="agent-col-head">
              <tg-agent-avatar [agent]="c.agent" [size]="18" />
              <strong>{{ meta[c.agent].name }}</strong>
            </div>
            <div class="dim mono agent-col-usage">{{ c.tokens }} · {{ c.cost }}</div>
            @if (c.progress; as p) {
              <div class="ap-progress" [attr.title]="p.note ?? ''"><span class="ellipsis">{{ p.step }}</span>
                @if (p.pct !== null) { <span class="meter" aria-hidden="true"><span [style.width.%]="p.pct"></span></span><span class="mono dim">{{ p.pct }}%</span> }
              </div>
            }
            <div class="agent-col-counts">
              <span><b>{{ c.running }}</b> đang chạy</span>
              <span [class.attention]="c.waiting > 0"><b>{{ c.waiting }}</b> chờ duyệt</span>
              <span><b>{{ c.done }}</b> xong</span>
              @if (c.failed) { <span class="err"><b>{{ c.failed }}</b> lỗi</span> }
            </div>
            @for (r of c.recent; track r.id) {
              <button class="agent-col-run" (click)="ui.openRun(r.id)">
                <span class="status" [attr.data-status]="r.status">{{ statusLabel[r.status] }}</span>
                <span class="ellipsis">{{ r.prompt }}</span>
              </button>
            }
          </div>
        } @empty {
          <p class="dim pad">Giao việc ở ô chat để thấy các agent ở đây.</p>
        }
      </section>
    </div>
  `,
})
export class MissionControl implements OnDestroy {
  protected readonly runs = inject(RunsService);
  protected readonly ui = inject(UiService);
  protected readonly meta = AGENT_META;
  protected readonly statusLabel = RUN_STATUS_LABEL;
  protected readonly kindLabel = { approve: 'Duyệt lệnh', review: 'Review', commit: 'Commit' };
  protected readonly tok = fmtTokens;
  private readonly workspace = inject(WorkspaceService);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async acceptHandoff(id: string): Promise<void> {
    const h = this.runs.handoffs().find((x) => x.id === id);
    const repo = this.workspace.repo()?.root ?? this.runs.runs().find((r) => r.id === h?.runId)?.cwd ?? '';
    this.busy.set(true);
    this.error.set(null);
    try {
      const runId = await this.runs.acceptHandoff(id, repo);
      this.ui.openRun(runId);
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
  protected readonly usd = fmtUsd;

  /** Advances once a second while something runs, so bars grow without re-rendering per event. */
  private readonly now = signal(Date.now());
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Files still waiting for review, per finished task run. */
  private readonly pending = signal<Record<string, number>>({});

  protected readonly waiting = computed(() => this.runs.sessionRuns().reduce((n, r) => n + r.permissions.length, 0));
  /** Same unit as the queue: a parallel group counts once. */
  protected readonly reviewCount = computed(() => this.queue().filter((q) => q.kind === 'review').length);

  protected readonly queue = computed<QueueItem[]>(() => {
    const items: QueueItem[] = [];
    const session = this.runs.sessionRuns();
    for (const r of session) {
      if (r.permissions.length) {
        const title = r.permissions[0].toolCall.title ?? 'công cụ';
        items.push({ key: `a:${r.id}`, kind: 'approve', run: r, detail: title, view: 'log' });
      }
    }
    const choices = this.runs.choices();
    const chosen = new Set(Object.values(choices).map((c) => c.runId));
    for (const r of [...session].sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))) {
      const files = this.pending()[r.id] ?? 0;
      const decided = r.group && choices[r.group];
      if (files > 0 && !decided && r.status !== 'running') {
        items.push({ key: `r:${r.id}`, kind: 'review', run: r, detail: `${files} tệp`, view: r.group ? 'compare' : 'changes' });
      }
    }
    for (const [group, choice] of Object.entries(choices)) {
      // A composite has no run of its own: show it under the group's first run.
      const run = session.find((r) => (choice.runId ? r.id === choice.runId : r.group === group));
      if (run && !choice.commit) {
        const what = choice.compositeId ? 'bản ghép' : 'đã áp dụng';
        items.push({ key: `c:${group}`, kind: 'commit', run, detail: `${choice.files} tệp ${what}`, view: 'compare' });
      }
    }
    // A parallel group needs one review, not one per agent.
    const seen = new Set<string>();
    return items.filter((q) => {
      if (q.kind !== 'review' || !q.run.group) return true;
      if (seen.has(q.run.group) || chosen.has(q.run.id)) return false;
      seen.add(q.run.group);
      const ready = items.filter((i) => i.kind === 'review' && i.run.group === q.run.group).length;
      q.detail = `${ready} bản để so sánh`;
      return true;
    });
  });

  private readonly window = computed(() => {
    const rows = [...this.runs.sessionRuns()].sort((a, b) => a.startedAt - b.startedAt).slice(-TIMELINE_RUNS);
    const start = Math.min(...rows.map((r) => r.startedAt));
    const end = Math.max(this.now(), ...rows.map((r) => r.endedAt ?? 0));
    return { rows, start, total: Math.max(1, end - start) };
  });

  protected readonly span = computed(() => (this.window().rows.length ? fmtDuration(this.window().total) : ''));

  protected readonly timeline = computed(() => {
    const { rows, start, total } = this.window();
    const now = this.now();
    const pct = (ms: number) => (ms / total) * 100;
    return rows.map((run) => {
      const end = run.endedAt ?? now;
      const length = Math.max(1, end - run.startedAt);
      return {
        run,
        left: pct(run.startedAt - start),
        // Keep very short runs visible.
        width: Math.max(0.6, pct(end - run.startedAt)),
        waits: run.waits.map((w) => ({
          left: ((w.from - run.startedAt) / length) * 100,
          width: Math.max(1, (((w.to ?? now) - w.from) / length) * 100),
        })),
      };
    });
  });

  protected readonly columns = computed(() => {
    const session = this.runs.sessionRuns();
    const usage = this.runs.usageByAgent();
    return AGENT_IDS.filter((a) => session.some((r) => r.agent === a)).map((agent: AgentId) => {
      const mine = session.filter((r) => r.agent === agent);
      const u = usage.find((x) => x.agent === agent)!;
      return {
        agent,
        running: mine.filter((r) => r.status === 'running').length,
        waiting: mine.reduce((n, r) => n + r.permissions.length, 0),
        done: mine.filter((r) => r.status === 'done').length,
        failed: mine.filter((r) => r.status === 'failed').length,
        tokens: fmtTokens(u.inputTokens + u.cachedInputTokens + u.outputTokens) + ' tok',
        cost: fmtUsd(u.costUsd),
        recent: [...mine].sort((a, b) => b.startedAt - a.startedAt).slice(0, 3),
        /** What the agent last reported through tg-bridge, while it runs. */
        progress: mine.find((r) => r.status === 'running' && r.progress)?.progress ?? null,
      };
    });
  });

  constructor() {
    effect(() => {
      const live = this.runs.running().length > 0;
      untracked(() => this.tick(live));
    });
    // Review counts change when a run finishes or a worktree is accepted or dropped.
    effect(() => {
      const key = this.runs.sessionRuns().map((r) => `${r.id}:${r.status}:${r.task}`).join();
      this.runs.choices();
      untracked(() => void this.loadPending(key));
    });
  }

  ngOnDestroy(): void {
    this.tick(false);
  }

  private tick(on: boolean): void {
    this.now.set(Date.now());
    if (on && !this.timer) this.timer = setInterval(() => this.now.set(Date.now()), 1000);
    if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private loads = 0;

  private async loadPending(_key: string): Promise<void> {
    const ticket = ++this.loads;
    const done = this.runs.sessionRuns().filter((r) => r.task && r.status !== 'running');
    const counts = await Promise.all(done.map(async (r) => {
      try {
        return [r.id, (await this.runs.getDiff(r.id)).length] as const;
      } catch {
        return [r.id, 0] as const;
      }
    }));
    if (ticket === this.loads) this.pending.set(Object.fromEntries(counts));
  }
}
