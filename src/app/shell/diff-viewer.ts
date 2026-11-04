import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { AGENT_META, AgentId, FileDiff, Hunk } from '../core/protocol';
import { KEYS } from '../core/keys';
import { RunsService } from '../core/runs.service';
import { WorkspaceService } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';

/** Reviews a task's worktree one hunk at a time; only accepted hunks reach the user's repo. */
@Component({
  selector: 'tg-diff-viewer',
  imports: [AgentAvatar],
  template: `
    <div class="review" [style.--agent]="color()">
      <div class="review-bar">
        <span class="dim">{{ summary() }}</span>
        <span class="spacer"></span>
        <button class="btn ghost sm" [disabled]="busy()" (click)="load()">Tải lại</button>
        @if (!running()) {
          @if (confirmingDiscard()) {
            <button class="btn ghost sm" [disabled]="busy()" (click)="confirmingDiscard.set(false)">Giữ lại</button>
            <button class="btn warn sm" [disabled]="busy()" (click)="discard()">Xác nhận bỏ worktree</button>
          } @else {
            <button class="btn ghost sm" [disabled]="busy()" (click)="confirmingDiscard.set(true)">Bỏ worktree</button>
          }
        }
      </div>
      @if (error()) { <p class="error-text" role="alert">{{ error() }}</p> }
      @if (committed()) { <p class="ok-text" role="status">Đã commit {{ committed() }}</p> }

      @if (staged().length) {
        <section class="commit-box" aria-label="Commit các thay đổi đã chấp nhận">
          <p class="dim">Commit sẽ gồm mọi tệp đang staged trong dự án, kể cả tệp bạn tự stage:</p>
          <ul class="commit-files mono">
            @for (path of staged(); track path) { <li>{{ path }}</li> }
          </ul>
          <label class="field">
            <span>Nội dung commit</span>
            <textarea rows="2" [value]="message()" (input)="edited.set($any($event.target).value)"></textarea>
          </label>
          <div><button class="btn primary sm" [disabled]="busy() || !message().trim()" (click)="commit()">Commit</button></div>
        </section>
      }

      @for (f of files(); track f.path) {
        <section class="review-file">
          <div class="review-file-head">
            <span class="file-status" [attr.data-status]="f.status" [attr.aria-label]="statusLabel[f.status]">{{ f.status }}</span>
            <span class="mono ellipsis">{{ f.path }}</span>
          </div>
          @if (f.binary) { <p class="dim pad">Tệp nhị phân: không xem và duyệt được ở đây.</p> }
          @for (h of f.hunks; track h.id) {
            <div class="hunk" tabindex="0" [attr.aria-label]="'Thay đổi trong ' + f.path"
              (keydown.meta.enter)="act('accept', f, h)" (keydown.control.enter)="act('accept', f, h)"
              (keydown.meta.backspace)="act('reject', f, h)" (keydown.control.backspace)="act('reject', f, h)">
              <div class="hunk-bar">
                <tg-agent-avatar [agent]="agent()" [size]="16" />
                <span class="mono dim ellipsis">{{ h.header }}</span>
                <span class="spacer"></span>
                <span class="hunk-count"><span class="plus">+{{ h.added }}</span> <span class="minus">−{{ h.removed }}</span></span>
                <button class="btn ghost sm" [disabled]="busy()" (click)="act('reject', f, h)">Reject<span class="kbd">{{ keys.backspace }}</span></button>
                <button class="btn primary sm" [disabled]="busy()" (click)="act('accept', f, h)">Accept<span class="kbd">{{ keys.enter }}</span></button>
              </div>
              <div class="hunk-body">
                @for (line of h.lines; track $index) { <div class="diff-line" [attr.data-kind]="kindOf(line)">{{ line }}</div> }
              </div>
            </div>
          }
        </section>
      }
    </div>
  `,
})
export class DiffViewer {
  protected readonly keys = KEYS;
  private readonly runs = inject(RunsService);
  private readonly workspace = inject(WorkspaceService);
  readonly runId = input.required<string>();
  readonly agent = input.required<AgentId>();
  readonly running = input(false);
  readonly suggestion = input('');

  protected readonly files = signal<FileDiff[]>([]);
  protected readonly busy = signal(false);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly committed = signal<string | null>(null);
  /** From the repository, so changes accepted in the editor or before a tab switch count too. */
  protected readonly staged = signal<string[]>([]);
  protected readonly edited = signal<string | null>(null);
  protected readonly confirmingDiscard = signal(false);
  protected readonly message = computed(() => this.edited() ?? this.suggestion());
  protected readonly color = computed(() => AGENT_META[this.agent()].color);
  protected readonly statusLabel: Record<string, string> = { M: 'Đã sửa', A: 'Tệp mới', D: 'Đã xóa' };
  protected readonly summary = computed(() => {
    if (!this.loaded()) return 'Đang tải…';
    const hunks = this.files().reduce((n, f) => n + f.hunks.length, 0);
    if (hunks) return `${hunks} thay đổi chờ duyệt trong ${this.files().length} tệp`;
    return this.running() ? 'Agent đang làm, chưa có thay đổi nào.' : 'Không còn thay đổi nào chờ duyệt.';
  });

  constructor() {
    // Reload for a different run, and once more when the agent finishes.
    effect(() => {
      this.runId();
      this.running();
      untracked(() => {
        this.edited.set(null);
        this.committed.set(null);
        void this.load();
      });
    });
  }

  protected kindOf(line: string): string {
    return line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('\\') ? 'meta' : 'ctx';
  }

  protected async load(): Promise<void> {
    await this.guard(async () => {
      const [files, staged] = await Promise.all([this.runs.getDiff(this.runId()), this.runs.stagedFiles(this.runId())]);
      this.files.set(files);
      this.staged.set(staged);
      this.loaded.set(true);
    });
  }

  protected async act(action: 'accept' | 'reject', file: FileDiff, hunk: Hunk): Promise<void> {
    if (this.busy()) return;
    const id = this.runId();
    await this.guard(async () => {
      if (action === 'accept') {
        await this.runs.acceptHunk(id, file.path, hunk.id);
      } else {
        await this.runs.rejectHunk(id, file.path, hunk.id);
      }
      this.committed.set(null);
      const [files, staged] = await Promise.all([this.runs.getDiff(id), this.runs.stagedFiles(id)]);
      this.files.set(files);
      this.staged.set(staged);
      void this.workspace.refresh(id);
    });
  }

  protected async commit(): Promise<void> {
    await this.guard(async () => {
      const hash = await this.runs.commitAccepted(this.runId(), this.message().trim());
      this.committed.set(hash.slice(0, 7));
      this.staged.set(await this.runs.stagedFiles(this.runId()));
      this.edited.set(null);
    });
  }

  protected async discard(): Promise<void> {
    await this.guard(() => this.runs.discardWorktree(this.runId()));
  }

  private async guard(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
