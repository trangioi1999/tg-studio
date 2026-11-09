import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { fmtDuration, fmtTokens, fmtUsd } from '../shared/format';
import { costOf } from '../usage/pricing';
import { AgentId, FileDiff } from '../core/protocol';
import { AGENT_META } from '../agents/agent-meta';
import { RunsService } from '../runs/runs.service';
import { Run } from '../runs/run';
import { AgentAvatar } from '../shared/agent-avatar';
import { Mixer } from './mixer';
import { errorText } from '../shared/errors';
import { diffStats } from '../shared/diff-stats';

interface Summary {
  files: FileDiff[];
  added: number;
  removed: number;
}

/**
 * Side by side results of one prompt given to several agents. "Use this" applies a
 * whole run to the repo in one patch; the other worktrees can then be cleaned up.
 */
@Component({
  selector: 'tg-compare',
  imports: [AgentAvatar, Mixer],
  template: `
    <div class="review">
      <div class="review-bar">
        <span class="dim ellipsis">{{ runs().length }} agent cùng làm: “{{ prompt() }}”</span>
        <span class="spacer"></span>
        @if (anyRunning()) { <span class="dim">Đang chờ {{ runningCount() }} agent…</span> }
        <button class="btn ghost sm" [disabled]="busy()" (click)="load()">Tải lại</button>
      </div>
      @if (error()) { <p class="error-text" role="alert">{{ error() }}</p> }

      @if (choice()) {
        <section class="commit-box" aria-label="Commit bản đã chọn">
          @if (committed()) {
            <p class="ok-text" role="status">Đã commit {{ committed() }} từ {{ choiceLabel() }}.</p>
            @if (leftovers().length || hasComposite()) {
              <div><button class="btn ghost sm" [disabled]="busy()" (click)="cleanup()">Dọn bản nháp của nhóm</button></div>
            }
          } @else {
            <label class="field">
              <span>Đã áp dụng {{ choiceLabel() }} ({{ appliedFiles() }} tệp) vào repo. Nội dung commit</span>
              <textarea rows="2" [value]="message()" (input)="edited.set($any($event.target).value)"></textarea>
            </label>
            <div><button class="btn primary sm" [disabled]="busy() || !message().trim()" (click)="commit()">Commit</button></div>
          }
        </section>
      }

      <div class="compare-grid">
        @for (r of runs(); track r.id) {
          <article class="compare-card" [class.chosen]="chosen()?.id === r.id" [style.--agent]="meta[r.agent].color" [attr.aria-label]="'Kết quả của ' + meta[r.agent].name">
            <header class="compare-head">
              <tg-agent-avatar [agent]="r.agent" [size]="18" />
              <strong>{{ meta[r.agent].name }}</strong>
              <span class="spacer"></span>
              <span class="status" [attr.data-status]="r.status">{{ statusLabel[r.status] }}</span>
            </header>
            @if (summaries()[r.id]; as s) {
              <dl class="compare-stats">
                <div><dt>Tệp</dt><dd>{{ s.files.length }}</dd></div>
                <div><dt>Dòng</dt><dd><span class="plus">+{{ s.added }}</span> <span class="minus">−{{ s.removed }}</span></dd></div>
                <div><dt>Token</dt><dd>{{ tokens(r) }}</dd></div>
                <div><dt>Chi phí</dt><dd>{{ cost(r) }}</dd></div>
                <div><dt>Thời gian</dt><dd>{{ duration(r) }}</dd></div>
              </dl>
              <ul class="compare-files">
                @for (f of s.files.slice(0, 8); track f.path) {
                  <li><span class="file-status" [attr.data-status]="f.status">{{ f.status }}</span><span class="mono ellipsis">{{ f.path }}</span></li>
                } @empty {
                  <li class="dim">{{ !r.task ? 'Đã bỏ bản nháp.' : r.status === 'running' ? 'Chưa có thay đổi.' : 'Không có thay đổi nào chờ duyệt.' }}</li>
                }
                @if (s.files.length > 8) { <li class="dim">và {{ s.files.length - 8 }} tệp khác</li> }
              </ul>
            } @else {
              <p class="dim">Đang tải…</p>
            }
            @if (r.lastMessage) { <p class="compare-msg">{{ excerpt(r.lastMessage) }}</p> }
            <footer class="compare-actions">
              <button class="btn ghost sm" (click)="review.emit(r.id)">Xem thay đổi</button>
              <span class="spacer"></span>
              @if (confirming() === r.id) {
                <button class="btn ghost sm" [disabled]="busy()" (click)="confirming.set(null)">Thôi</button>
                <button class="btn warn sm" [disabled]="busy()" (click)="use(r)">Áp dụng vào repo</button>
              } @else {
                <button class="btn primary sm" [disabled]="!canUse(r)" [attr.title]="useHint(r)" (click)="confirming.set(r.id)">Dùng bản này</button>
              }
            </footer>
          </article>
        }
      </div>

      @if (doneRuns().length > 1 || hasComposite()) {
        <tg-mixer [group]="group()" [runs]="doneRuns()" [diffs]="diffMap()" />
      }
    </div>
  `,
})
export class Compare {
  private readonly runsService = inject(RunsService);
  readonly group = input.required<string>();
  /** Asks the console to open this run's hunk review. */
  readonly review = output<string>();

  protected readonly meta = AGENT_META;
  protected readonly statusLabel = { running: 'đang chạy', idle: 'chờ bạn', done: 'xong', failed: 'lỗi', stopped: 'đã dừng', interrupted: 'gián đoạn' };
  protected readonly runs = computed(() => this.runsService.groupRuns(this.group()));
  protected readonly prompt = computed(() => this.runs()[0]?.prompt ?? '');
  protected readonly runningCount = computed(() => this.runs().filter((r) => r.status === 'running').length);
  protected readonly anyRunning = computed(() => this.runningCount() > 0);
  protected readonly summaries = signal<Record<string, Summary>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal<string | null>(null);
  protected readonly choice = computed(() => this.runsService.choices()[this.group()] ?? null);
  protected readonly chosenId = computed(() => this.choice()?.runId ?? null);
  protected readonly chosen = computed(() => this.runs().find((r) => r.id === this.chosenId()) ?? null);
  protected readonly appliedFiles = computed(() => this.choice()?.files ?? 0);
  protected readonly committed = computed(() => this.choice()?.commit ?? null);
  protected readonly edited = signal<string | null>(null);
  protected readonly choiceLabel = computed(() => (this.chosen() ? `bản của ${AGENT_META[this.chosen()!.agent].name}` : 'bản ghép'));
  protected readonly message = computed(() => this.edited() ?? (this.chosen() ? suggestMessage(this.chosen()) : `Ghép thay đổi: ${this.prompt()}`.slice(0, 72)));
  protected readonly hasComposite = computed(() => !!this.runsService.composites()[this.group()]);
  protected readonly doneRuns = computed(() => this.runs().filter((r) => r.task && r.status !== 'running'));
  protected readonly diffMap = computed(() => Object.fromEntries(Object.entries(this.summaries()).map(([id, s]) => [id, s.files])));
  protected readonly leftovers = computed(() => this.runs().filter((r) => r.task && r.status !== 'running'));

  constructor() {
    // Reload when the group changes and whenever one of its runs changes status.
    effect(() => {
      this.group();
      this.runs().map((r) => `${r.id}:${r.status}:${r.task}`).join();
      untracked(() => void this.load());
    });
    effect(() => {
      this.group();
      untracked(() => {
        this.edited.set(null);
        this.confirming.set(null);
      });
    });
  }

  protected canUse(r: Run): boolean {
    const files = this.summaries()[r.id]?.files.length ?? 0;
    return !this.busy() && !this.choice() && r.task && r.status !== 'running' && files > 0;
  }

  protected useHint(r: Run): string | null {
    if (this.choice()) return 'Đã chọn một bản cho nhóm này.';
    if (r.status === 'running') return 'Chờ agent làm xong.';
    if (!(this.summaries()[r.id]?.files.length ?? 0)) return 'Bản này không có thay đổi.';
    return null;
  }

  private loads = 0;

  protected async load(): Promise<void> {
    const ticket = ++this.loads;
    const runs = this.runs();
    const before = this.summaries();
    const failed: string[] = [];
    const next: Record<string, Summary> = {};
    await Promise.all(runs.map(async (r) => {
      if (!r.task) {
        next[r.id] = { files: [], added: 0, removed: 0 };
        return;
      }
      try {
        const files = await this.runsService.getDiff(r.id);
        next[r.id] = { files, ...diffStats(files) };
      } catch {
        // Not "no changes": keep the last read, and say so.
        next[r.id] = before[r.id] ?? { files: [], added: 0, removed: 0 };
        failed.push(AGENT_META[r.agent].name);
      }
    }));
    // A slower, older load must not replace a newer one (switching groups quickly).
    if (ticket !== this.loads) return;
    this.summaries.set(next);
    const stale = 'Chưa đọc được thay đổi';
    if (failed.length) this.error.set(`${stale} của ${failed.join(', ')}. Đang hiện bản trước.`);
    else if (this.error()?.startsWith(stale)) this.error.set(null);
  }

  protected async use(r: Run): Promise<void> {
    await this.guard(async () => {
      await this.runsService.useRun(this.group(), r.id);
      this.confirming.set(null);
      await this.load();
    });
  }

  protected async commit(): Promise<void> {
    await this.guard(async () => {
      await this.runsService.commitChoice(this.group(), this.message().trim());
    });
  }

  protected async cleanup(): Promise<void> {
    await this.guard(async () => {
      for (const r of this.leftovers()) await this.runsService.discardWorktree(r.id);
      await this.runsService.dropComposite(this.group());
      await this.load();
    });
  }

  protected tokens(r: Run): string {
    const u = r.usage;
    return u ? fmtTokens(u.inputTokens + u.cachedInputTokens + u.outputTokens) : '—';
  }

  protected cost(r: Run): string {
    if (!r.usage) return '—';
    return fmtUsd(costOf(r.agent as AgentId, r.usage, r.startedAt).usd);
  }

  protected duration(r: Run): string {
    return fmtDuration((r.endedAt ?? Date.now()) - r.startedAt);
  }

  protected excerpt(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 280 ? flat.slice(0, 279) + '…' : flat;
  }

  private async guard(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}

/** First line of the chosen agent's last message, else the prompt. */
export function suggestMessage(run: Run | null): string {
  if (!run) return '';
  const line = run.lastMessage.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? run.prompt;
  return line.length > 72 ? line.slice(0, 71) + '…' : line;
}
