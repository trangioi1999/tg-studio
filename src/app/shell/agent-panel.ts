import { Component, computed, inject, signal } from '@angular/core';
import { AgentsService } from '../core/agents.service';
import { fmtDuration, fmtTokens, fmtUsd } from '../core/format';
import { KEYS } from '../core/keys';
import { DEFAULT_TEMPLATES, PipelineService, PipelineStep } from '../core/pipeline.service';
import { estimateCost } from '../core/pricing';
import { AGENT_IDS, AGENT_META, AgentId } from '../core/protocol';
import { Run, RunsService } from '../core/runs.service';
import { WorkspaceService } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';
import { PermissionCard } from './permission-card';

type Mode = 'task' | 'parallel' | 'pipeline' | 'read';

const PIPELINE_KEY = 'tg.pipeline';

const WINDOW_SHORT: Record<string, string> = { five_hour: '5 giờ', seven_day: '7 ngày' };

/**
 * Right side of the IDE: the selected task's thread, plan and runs, its usage,
 * approval cards, and the composer that hands out work.
 */
@Component({
  selector: 'tg-agent-panel',
  imports: [AgentAvatar, PermissionCard],
  template: `
    <div class="ap-tabs" role="tablist" aria-label="Panel agent">
      @for (t of panelTabs; track t.id) {
        <button role="tab" class="ap-tab" [class.active]="tab() === t.id" [attr.aria-selected]="tab() === t.id" (click)="tab.set(t.id)">{{ t.label }}</button>
      }
      <span class="spacer"></span>
      <span class="dim mono ap-total">{{ usd(runs.totals().costUsd) }} · {{ tok(runs.totals().tokens) }} tok</span>
    </div>

    <div class="ap-body">
      @switch (tab()) {
        @case ('thread') {
          @if (run(); as r) {
            @if (pipelineOf(); as po) {
              <h2 class="ap-title">{{ po.pipeline.task }}</h2>
              <ol class="stepper" aria-label="Các bước pipeline">
                @for (s of po.pipeline.steps; track $index; let i = $index) {
                  <li [attr.data-state]="stepState(po.pipeline, i)" [style.--agent]="meta[s.agent].color" [class.current]="i === po.step">
                    <button [disabled]="!po.pipeline.runIds[i]" (click)="runs.selectedId.set(po.pipeline.runIds[i]!)">
                      <span class="stepper-bar"></span>
                      <tg-agent-avatar [agent]="s.agent" [size]="14" />
                      <span class="stepper-name ellipsis">{{ s.name }}</span>
                    </button>
                  </li>
                }
              </ol>
              @if (po.pipeline.error) { <p class="error-text">{{ po.pipeline.error }}</p> }
            } @else {
              <h2 class="ap-title">{{ r.prompt || meta[r.agent].name }}</h2>
            }
            <section class="ap-card" aria-label="Usage của task">
              <div class="ap-card-head"><span class="label">USAGE · TASK NÀY</span><span class="spacer"></span><strong>{{ usd(taskCost()) }}</strong><span class="dim">{{ tok(taskTokens()) }} tok</span></div>
              @for (t of taskRuns(); track t.id) {
                <div class="ap-usage-row">
                  <tg-agent-avatar [agent]="t.agent" [size]="16" />
                  <div class="ap-usage-main">
                    <div>{{ meta[t.agent].name }} <span class="src" [attr.data-src]="t.usage?.costUsd != null ? 'reported' : 'unpriced'">{{ t.usage?.costUsd != null ? 'reported' : t.status === 'running' ? 'đang chạy' : 'chưa có giá' }}</span></div>
                    <div class="mono dim">in {{ tok(t.usage?.inputTokens ?? 0) }} · cache {{ tok(t.usage?.cachedInputTokens ?? 0) }} · out {{ tok(t.usage?.outputTokens ?? 0) }}</div>
                  </div>
                  <strong class="mono">{{ usd(costOf(t)) }}</strong>
                </div>
              }
              @if (limitsLine(); as l) { <div class="ap-limits dim">{{ l }}</div> }
            </section>

            @if (otherApprovals().length) {
              <div class="ap-notice">
                @for (o of otherApprovals(); track o.id) {
                  <button class="btn ghost sm" (click)="runs.selectedId.set(o.id)"><tg-agent-avatar [agent]="o.agent" [size]="14" /> {{ meta[o.agent].name }} cần bạn duyệt</button>
                }
              </div>
            }

            <div class="ap-thread" [style.--agent]="meta[r.agent].color">
              <div class="ap-who"><tg-agent-avatar [agent]="r.agent" [size]="16" /><strong>{{ meta[r.agent].name }}</strong><span class="dim">{{ statusLabel[r.status] }} · {{ duration(r) }}</span></div>
              @for (l of r.lines; track $index) {
                @switch (l.tone) {
                  @case ('text') { <p class="ap-msg">{{ l.text }}</p> }
                  @case ('tool') { <div class="ap-tool mono">{{ l.text }}</div> }
                  @case ('error') { <div class="ap-tool mono err">{{ l.text }}</div> }
                  @default { <div class="ap-tool mono dim">{{ l.text }}</div> }
                }
              }
            </div>
            @for (p of r.permissions; track p.requestId) { <tg-permission-card [runId]="r.id" [agent]="r.agent" [request]="p" /> }
          } @else {
            <div class="ap-empty">
              <p>Chưa có task nào được chọn.</p>
              <p class="dim">Gõ yêu cầu ở ô dưới. <strong>Sửa code</strong> làm trong worktree riêng: repo của bạn chỉ đổi khi bạn Accept. Gõ <code>&#64;codex</code>, <code>&#64;claude</code>… ở đầu câu để chọn agent.</p>
            </div>
          }
        }
        @case ('plan') {
          @if (run()?.plan?.length) {
            <ul class="ap-plan">
              @for (p of run()!.plan; track $index) {
                <li [attr.data-status]="p.status">
                  <span class="plan-mark" aria-hidden="true"></span>
                  <span>{{ p.content }}</span>
                  <span class="sr-only">{{ planLabel[p.status] ?? p.status }}</span>
                </li>
              }
            </ul>
          } @else {
            <p class="dim pad">Agent chưa gửi kế hoạch cho task này.</p>
          }
        }
        @case ('runs') {
          @for (r of runs.runs(); track r.id) {
            <button class="ap-run" [class.active]="r.id === run()?.id" (click)="runs.selectedId.set(r.id); tab.set('thread')">
              <tg-agent-avatar [agent]="r.agent" [size]="16" />
              <span class="ellipsis">{{ r.prompt || meta[r.agent].name }}</span>
              <span class="spacer"></span>
              @if (r.group) { <span class="group-mark" title="Chạy song song">∥</span> }
              @if (r.permissions.length) { <span class="needs" title="Cần bạn duyệt">!</span> }
              <span class="status" [attr.data-status]="r.status">{{ statusLabel[r.status] }}</span>
            </button>
          } @empty {
            <p class="dim pad">Chưa có lượt chạy nào.</p>
          }
        }
      }
    </div>

    <section class="ap-composer" aria-label="Giao việc">
      <label class="sr-only" for="prompt">Yêu cầu cho agent</label>
      <textarea id="prompt" rows="3" [placeholder]="'Giao việc, hỏi, hoặc @mention agent… (' + keys.enter + ' để chạy)'"
        [value]="prompt()" (input)="prompt.set($any($event.target).value)"
        (keydown.meta.enter)="send()" (keydown.control.enter)="send()"></textarea>
      <div class="ap-composer-row">
        <select aria-label="Chế độ" [value]="mode()" (change)="mode.set($any($event.target).value)">
          <option value="task">Sửa code</option>
          <option value="parallel">Song song</option>
          <option value="pipeline">Pipeline</option>
          <option value="read">Chỉ đọc</option>
        </select>
        @if (mode() === 'parallel') {
          <div class="picks" role="group" aria-label="Agent chạy song song">
            @for (a of choices(); track a.id) {
              <label class="pick" [class.on]="picked().includes(a.id)" [style.--agent]="meta[a.id].color" [title]="a.name">
                <input type="checkbox" [checked]="picked().includes(a.id)" (change)="toggle(a.id)" />
                <tg-agent-avatar [agent]="a.id" [size]="14" />
              </label>
            }
          </div>
        } @else if (mode() === 'pipeline') {
          <button class="btn ghost sm" [attr.aria-expanded]="editSteps()" (click)="editSteps.set(!editSteps())">{{ editSteps() ? 'Xong' : 'Sửa mẫu' }}</button>
        } @else {
          <select aria-label="Agent" (change)="chosen.set($any($event.target).value)">
            @for (a of choices(); track a.id) { <option [value]="a.id" [selected]="a.id === agent()">{{ a.name }}</option> }
            @if (!choices().length) { <option value="">Chưa có agent</option> }
          </select>
        }
        <span class="spacer"></span>
        <button class="btn primary sm" [disabled]="!canRun()" [title]="blocked() ?? ''" (click)="send()">Chạy<span class="kbd">{{ keys.enter }}</span></button>
      </div>
      @if (mode() === 'pipeline') {
        <ol class="pipe-steps" aria-label="Các bước">
          @for (s of steps(); track $index; let i = $index) {
            <li>
              <div class="pipe-step">
                <span class="pipe-name">{{ s.name }}</span>
                <select [attr.aria-label]="'Agent cho bước ' + s.name" (change)="setStep(i, { agent: $any($event.target).value })">
                  @for (a of choices(); track a.id) { <option [value]="a.id" [selected]="a.id === s.agent">{{ a.name }}</option> }
                </select>
              </div>
              @if (editSteps()) {
                <textarea class="mono" rows="4" [attr.aria-label]="'Mẫu prompt bước ' + s.name" [value]="s.template" (input)="setStep(i, { template: $any($event.target).value })"></textarea>
              }
            </li>
          }
        </ol>
        @if (editSteps()) {
          <p class="dim ap-hint"><code>{{ '{{task}}' }}</code> yêu cầu · <code>{{ '{{previous}}' }}</code> tin nhắn cuối của bước trước · <code>{{ '{{diff}}' }}</code> diff hiện tại. <button class="link" (click)="resetSteps()">Khôi phục mặc định</button></p>
        }
      }
      @if (blocked(); as b) { <p class="dim ap-hint">{{ b }}</p> }
      @if (error()) { <p class="error-text">{{ error() }}</p> }
    </section>
  `,
})
export class AgentPanel {
  protected readonly runs = inject(RunsService);
  private readonly agents = inject(AgentsService);
  private readonly pipelines = inject(PipelineService);
  private readonly workspace = inject(WorkspaceService);
  protected readonly meta = AGENT_META;
  protected readonly keys = KEYS;
  protected readonly tok = fmtTokens;
  protected readonly usd = fmtUsd;
  protected readonly panelTabs = [{ id: 'thread', label: 'Thread' }, { id: 'plan', label: 'Plan' }, { id: 'runs', label: 'Runs' }] as const;
  protected readonly statusLabel = { running: 'đang chạy', done: 'xong', failed: 'lỗi', stopped: 'đã dừng', interrupted: 'gián đoạn' };
  protected readonly planLabel: Record<string, string> = { completed: 'xong', in_progress: 'đang làm', pending: 'chưa làm' };

  protected readonly tab = signal<'thread' | 'plan' | 'runs'>('thread');
  protected readonly run = computed(() => this.runs.selected());
  /** The selected run and, for a parallel task, the rest of its group. */
  protected readonly taskRuns = computed(() => {
    const r = this.run();
    if (!r) return [];
    const group = this.runs.groupRuns(r.group);
    return group.length ? group : [r];
  });
  protected readonly taskTokens = computed(() => this.taskRuns().reduce((n, r) => n + (r.usage ? r.usage.inputTokens + r.usage.cachedInputTokens + r.usage.outputTokens : 0), 0));
  protected readonly taskCost = computed(() => {
    const costs = this.taskRuns().map((r) => this.costOf(r)).filter((c): c is number => c !== null);
    return costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  });
  protected readonly limitsLine = computed(() => {
    const parts = AGENT_IDS.flatMap((a) => {
      const l = this.runs.limits()[a];
      if (!l?.windows.length || !this.taskRuns().some((r) => r.agent === a)) return [];
      return [`${AGENT_META[a].name} · ${l.windows.map((w) => `${WINDOW_SHORT[w.id] ?? w.id} ${Math.round(w.utilization * 100)}%`).join(' · ')}`];
    });
    return parts.length ? `Hạn mức gói: ${parts.join(' | ')}` : null;
  });
  protected readonly pipelineOf = computed(() => this.pipelines.of(this.run()?.id));
  protected readonly otherApprovals = computed(() => this.runs.runs().filter((r) => r.permissions.length && r.id !== this.run()?.id));

  // Composer
  protected readonly mode = signal<Mode>('task');
  protected readonly prompt = signal('');
  protected readonly chosen = signal<AgentId | ''>('');
  protected readonly error = signal<string | null>(null);
  protected readonly picks = signal<AgentId[] | null>(null);
  /** Code tasks run over ACP, so agents without a headless mode (Kiro) can take them. */
  protected readonly choices = computed(() =>
    this.mode() !== 'read' ? this.agents.agents().filter((a) => a.path) : this.agents.runnable());
  protected readonly agent = computed<AgentId | ''>(() => this.mention()?.agent ?? (this.chosen() || this.choices()[0]?.id || ''));
  protected readonly picked = computed(() => {
    const available = this.choices().map((a) => a.id);
    return (this.picks() ?? available).filter((id) => available.includes(id));
  });
  /** `@codex fix this` hands the task to Codex. */
  private readonly mention = computed(() => {
    const m = /^@(\w+)\s+/.exec(this.prompt());
    const id = m?.[1].toLowerCase() as AgentId | undefined;
    return id && this.choices().some((a) => a.id === id) ? { agent: id, rest: this.prompt().slice(m![0].length) } : null;
  });
  private readonly text = computed(() => (this.mention()?.rest ?? this.prompt()).trim());
  /** Why Run is disabled, in words. */
  protected readonly blocked = computed(() => {
    if (!this.choices().length) return 'Chưa có agent nào chạy được. Cài một CLI ở cột Agents rồi bấm Dò lại.';
    if (!this.workspace.folder().trim()) return 'Chọn thư mục làm việc ở thanh trên cùng.';
    if (this.mode() !== 'read' && !this.workspace.repo()) return 'Sửa code cần một repo Git: đổi thư mục ở thanh trên cùng, hoặc dùng Chỉ đọc.';
    if (this.mode() === 'parallel' && this.picked().length < 2) return 'Song song cần ít nhất 2 agent.';
    if (this.mode() === 'pipeline' && this.steps().some((s) => !this.choices().some((a) => a.id === s.agent))) return 'Có bước dùng agent chưa cài. Chọn agent khác cho bước đó.';
    return null;
  });
  protected readonly canRun = computed(() => !this.blocked() && !!this.text());

  // Pipeline steps, remembered for the next task.
  protected readonly editSteps = signal(false);
  private readonly savedSteps = signal<PipelineStep[] | null>(loadSteps());
  protected readonly steps = computed<PipelineStep[]>(() => {
    const saved = this.savedSteps();
    if (saved) return saved;
    const ids = this.choices().map((a) => a.id);
    const pick = (i: number): AgentId => (ids[i % Math.max(ids.length, 1)] ?? 'claude') as AgentId;
    return [
      { name: 'Plan', agent: pick(0), template: DEFAULT_TEMPLATES.plan },
      { name: 'Build', agent: pick(1), template: DEFAULT_TEMPLATES.build },
      { name: 'Review', agent: pick(2), template: DEFAULT_TEMPLATES.review },
    ];
  });

  protected setStep(i: number, change: Partial<PipelineStep>): void {
    const next = this.steps().map((s, j) => (j === i ? { ...s, ...change } : s));
    this.savedSteps.set(next);
    try {
      localStorage.setItem(PIPELINE_KEY, JSON.stringify(next));
    } catch {
      /* remembered for this session only */
    }
  }

  protected resetSteps(): void {
    this.savedSteps.set(null);
    try {
      localStorage.removeItem(PIPELINE_KEY);
    } catch {
      /* nothing saved */
    }
  }

  protected stepState(p: { runIds: (string | null)[]; current: number; status: string }, i: number): string {
    const id = p.runIds[i];
    const run = id ? this.runs.runs().find((r) => r.id === id) : null;
    if (!run) return i < p.current ? 'done' : 'pending';
    return run.status === 'running' ? 'running' : run.status === 'done' ? 'done' : 'failed';
  }

  protected costOf(r: Run): number | null {
    return r.usage ? (r.usage.costUsd ?? estimateCost(r.agent, r.usage)) : null;
  }

  protected duration(r: Run): string {
    return fmtDuration((r.endedAt ?? Date.now()) - r.startedAt);
  }

  protected toggle(id: AgentId): void {
    const now = this.picked();
    this.picks.set(now.includes(id) ? now.filter((a) => a !== id) : [...now, id]);
  }

  protected async send(): Promise<void> {
    if (!this.canRun()) return;
    const agent = this.agent();
    const text = this.text();
    const cwd = this.mode() === 'read' ? this.workspace.folder().trim() : (this.workspace.repo()?.root ?? this.workspace.folder().trim());
    this.error.set(null);
    try {
      if (this.mode() === 'pipeline') {
        await this.pipelines.start(text, cwd, this.steps());
      } else if (this.mode() === 'parallel') {
        const failed = await this.runs.startParallel(this.picked(), text, cwd);
        if (failed.length) this.error.set(`Không chạy được: ${failed.join('; ')}`);
      } else if (agent) {
        if (this.mode() === 'task') await this.runs.startTask(agent, text, cwd);
        else await this.runs.start(agent, text, cwd);
      }
      this.prompt.set('');
      this.tab.set('thread');
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }
}

function loadSteps(): PipelineStep[] | null {
  try {
    const raw = localStorage.getItem(PIPELINE_KEY);
    const steps = raw ? (JSON.parse(raw) as PipelineStep[]) : null;
    return Array.isArray(steps) && steps.every((s) => s && typeof s.name === 'string' && typeof s.template === 'string') ? steps : null;
  } catch {
    return null;
  }
}
