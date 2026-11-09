import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { AGENT_META, AgentId, FileDiff, OwnChange } from '../core/protocol';
import { RunsService } from '../core/runs.service';
import { WorkspaceService } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';
import { FileIcon } from './file-icon';

/**
 * A run's changes as git sees them, like an editor's Source Control view: commit or revert
 * whole files, no step per hunk. A direct run's changes are already in the user's folder;
 * a draft's are applied to the folder in one go first.
 */
@Component({
  selector: 'tg-diff-viewer',
  imports: [AgentAvatar, FileIcon],
  template: `
    <div class="review" [style.--agent]="color()">
      <div class="review-bar">
        <span class="dim">{{ summary() }}</span>
        <span class="spacer"></span>
        <button class="btn ghost sm" [disabled]="busy()" (click)="load()">Tải lại</button>
        @if (direct() === true && files().length) {
          @if (confirmingRevertAll()) {
            <button class="btn ghost sm" [disabled]="busy()" (click)="confirmingRevertAll.set(false)">Giữ lại</button>
            <button class="btn warn sm" [disabled]="busy() || running()" (click)="revert(paths())">Xác nhận hoàn tác {{ files().length }} tệp</button>
          } @else {
            <button class="btn ghost sm" [disabled]="busy() || running()" (click)="confirmingRevertAll.set(true)">Hoàn tác tất cả</button>
          }
        }
        @if (direct() === false && !running()) {
          @if (confirmingDiscard()) {
            <button class="btn ghost sm" [disabled]="busy()" (click)="confirmingDiscard.set(false)">Giữ lại</button>
            <button class="btn warn sm" [disabled]="busy()" (click)="discard()">Xác nhận bỏ bản nháp</button>
          } @else {
            <button class="btn ghost sm" [disabled]="busy()" (click)="confirmingDiscard.set(true)">Bỏ bản nháp</button>
          }
          @if (files().length) {
            <button class="btn primary sm" [disabled]="busy()" (click)="apply()">Áp vào thư mục</button>
          }
        }
      </div>
      @if (running()) { <p class="dim chg-note" role="status">{{ agentName() }} đang sửa. Dừng hoặc đợi xong để commit hay hoàn tác.</p> }
      @if (error()) { <p class="error-text" role="alert">{{ error() }}</p> }
      @if (committed()) { <p class="ok-text" role="status">Đã commit {{ committed() }}</p> }
      @if (applied().length) { <p class="ok-text" role="status">Đã đưa {{ applied().length }} tệp vào thư mục của bạn.</p> }

      @if (commitPaths().length || (direct() === true && (files().length || own().length))) {
        <section class="commit-box" aria-label="Commit">
          <label class="field">
            <span>Nội dung commit</span>
            <textarea rows="2" [value]="message()" (input)="edited.set($any($event.target).value)"></textarea>
          </label>
          <div class="chg-commit-row">
            <span class="dim">Chỉ các tệp được chọn vào commit; phần bạn đã tự stage ở tệp khác vẫn giữ nguyên.</span>
            <button class="btn primary sm" [disabled]="busy() || running() || !commitPaths().length || !message().trim()" (click)="commit()">
              Commit {{ commitPaths().length }} tệp
            </button>
          </div>
        </section>
      }

      @if (files().length) {
        <section class="chg-group" aria-label="Thay đổi của agent">
          <h3 class="chg-group-head">{{ direct() === false ? 'Trong bản nháp' : 'Của agent' }} <span class="dim">{{ files().length }}</span></h3>
          @for (f of files(); track f.path) {
            <div class="chg-row">
              @if (direct() === true) {
                <input type="checkbox" [checked]="picked().has(f.path)" (change)="toggle(f.path)" [attr.aria-label]="'Chọn ' + f.path + ' để commit'" />
              }
              <span class="file-status" [attr.data-status]="f.status" [attr.title]="statusLabel[f.status]">{{ f.status }}</span>
              <button class="chg-path" (click)="openFile(f.path)" [title]="f.path">
                <tg-file-icon [name]="f.path" />
                <span class="chg-name">{{ base(f.path) }}</span>
                <span class="chg-dir dim">{{ dir(f.path) }}</span>
              </button>
              <tg-agent-avatar [agent]="agent()" [size]="14" />
              @if (f.binary) { <span class="hunk-count dim">nhị phân</span> }
              @else { <span class="hunk-count"><span class="plus">+{{ count(f, '+') }}</span> <span class="minus">−{{ count(f, '-') }}</span></span> }
              <button class="btn ghost sm icon" [disabled]="busy() || running()" (click)="revert([f.path])"
                [title]="direct() === false ? 'Bỏ thay đổi của tệp này trong bản nháp' : 'Hoàn tác: trả tệp về như trước khi agent sửa'"
                [attr.aria-label]="'Hoàn tác ' + f.path">↶</button>
            </div>
          }
        </section>
      }

      @if (own().length) {
        <section class="chg-group" aria-label="Bạn tự sửa">
          <h3 class="chg-group-head">Bạn tự sửa <span class="dim">{{ own().length }}</span></h3>
          @for (f of own(); track f.path) {
            <div class="chg-row">
              <input type="checkbox" [checked]="picked().has(f.path)" (change)="toggle(f.path)" [attr.aria-label]="'Chọn ' + f.path + ' để commit'" />
              <span class="file-status" [attr.data-status]="f.status" [attr.title]="statusLabel[f.status]">{{ f.status }}</span>
              <button class="chg-path" (click)="workspace.openSource(f.path)" [title]="f.path">
                <tg-file-icon [name]="f.path" />
                <span class="chg-name">{{ base(f.path) }}</span>
                <span class="chg-dir dim">{{ dir(f.path) }}</span>
              </button>
            </div>
          }
        </section>
      }
    </div>
  `,
})
export class DiffViewer {
  private readonly runs = inject(RunsService);
  protected readonly workspace = inject(WorkspaceService);
  readonly runId = input.required<string>();
  readonly agent = input.required<AgentId>();
  readonly running = input(false);
  readonly suggestion = input('');

  protected readonly files = signal<FileDiff[]>([]);
  protected readonly own = signal<OwnChange[]>([]);
  /** Null until the core says where the run works. */
  protected readonly direct = signal<boolean | null>(null);
  /** Files that go into the commit. */
  protected readonly picked = signal<Set<string>>(new Set());
  /** Files the user ticked or unticked, so a reload keeps their choice. */
  private readonly touched = new Set<string>();
  /** A draft's files once applied to the folder: what its commit takes. */
  protected readonly applied = computed(() => this.workspace.applied()[this.runId()] ?? []);
  protected readonly busy = signal(false);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly committed = signal<string | null>(null);
  protected readonly edited = signal<string | null>(null);
  protected readonly confirmingDiscard = signal(false);
  protected readonly confirmingRevertAll = signal(false);
  protected readonly message = computed(() => this.edited() ?? this.suggestion());
  protected readonly color = computed(() => AGENT_META[this.agent()].color);
  protected readonly agentName = computed(() => AGENT_META[this.agent()].name);
  protected readonly statusLabel: Record<string, string> = { M: 'Đã sửa', A: 'Tệp mới', D: 'Đã xóa' };
  protected readonly paths = computed(() => this.files().map((f) => f.path));
  protected readonly commitPaths = computed(() => {
    if (this.direct() === false) return this.applied();
    const picked = this.picked();
    return [...this.files().map((f) => f.path), ...this.own().map((f) => f.path)].filter((p) => picked.has(p));
  });
  protected readonly summary = computed(() => {
    if (!this.loaded()) return 'Đang tải…';
    const files = this.files();
    if (!files.length) return this.running() ? 'Agent đang làm, chưa sửa tệp nào.' : 'Agent không còn thay đổi nào chưa commit.';
    const added = files.reduce((n, f) => n + this.count(f, '+'), 0);
    const removed = files.reduce((n, f) => n + this.count(f, '-'), 0);
    return `${files.length} tệp · +${added} −${removed}`;
  });

  constructor() {
    // Reload for a different run, and once more when the agent finishes.
    effect(() => {
      const id = this.runId();
      this.running();
      untracked(() => {
        if (id !== this.loadedFor) {
          this.loadedFor = id;
          this.touched.clear();
          this.edited.set(null);
          this.committed.set(null);
        }
        void this.load();
      });
    });
  }
  private loadedFor: string | null = null;

  protected count(f: FileDiff, sign: '+' | '-'): number {
    return f.hunks.reduce((n, h) => n + (sign === '+' ? h.added : h.removed), 0);
  }

  protected base(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
  }

  protected dir(path: string): string {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
  }

  protected toggle(path: string): void {
    this.touched.add(path);
    this.picked.update((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  protected openFile(path: string): void {
    this.workspace.openFile(this.runId(), path);
  }

  protected async load(): Promise<void> {
    const id = this.runId();
    await this.guard(async () => {
      const [files, own] = await Promise.all([this.runs.getDiff(id), this.runs.ownChanges(id)]);
      if (id !== this.runId()) return;
      this.files.set(files);
      this.own.set(own.files);
      this.direct.set(own.direct);
      // The agent's files go into the commit unless unticked; the user's own only when ticked.
      const prev = this.picked();
      const next = new Set<string>();
      for (const f of files) if (!this.touched.has(f.path) || prev.has(f.path)) next.add(f.path);
      for (const f of own.files) if (this.touched.has(f.path) && prev.has(f.path)) next.add(f.path);
      this.picked.set(next);
      this.loaded.set(true);
    });
  }

  protected async revert(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const id = this.runId();
    this.confirmingRevertAll.set(false);
    await this.guard(async () => {
      await this.runs.revertFiles(id, paths);
      this.committed.set(null);
    });
    await this.load();
    void this.workspace.refresh(id);
  }

  protected async apply(): Promise<void> {
    const id = this.runId();
    const paths = this.paths();
    let ok = false;
    await this.guard(async () => {
      await this.runs.acceptAll(id);
      ok = true;
    });
    if (ok) this.setApplied(id, paths);
    await this.load();
    void this.workspace.refresh(id);
  }

  protected async commit(): Promise<void> {
    const id = this.runId();
    const paths = this.commitPaths();
    let hash: string | null = null;
    await this.guard(async () => {
      hash = await this.runs.commitFiles(id, paths, this.message().trim());
    });
    if (!hash) return;
    this.committed.set((hash as string).slice(0, 7));
    this.setApplied(id, []);
    this.edited.set(null);
    for (const p of paths) this.touched.delete(p);
    await this.load();
    void this.workspace.refresh(id);
  }

  private setApplied(runId: string, paths: string[]): void {
    this.workspace.applied.update(({ [runId]: _, ...rest }) => (paths.length ? { ...rest, [runId]: paths } : rest));
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
