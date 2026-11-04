import { Component, ElementRef, OnDestroy, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import { lineMarks } from '../core/line-marks';
import { MonacoApi, loadMonaco } from '../core/monaco';
import { AGENT_META, AgentId, FileDiff } from '../core/protocol';
import { RunsService } from '../core/runs.service';

/**
 * Monaco on a task's worktree. Lines the agent changed get a bar in the agent's
 * colour. Saving writes to the worktree only, so the edit joins the review queue.
 */
@Component({
  selector: 'tg-code-editor',
  template: `
    <div class="editor" [style.--agent]="color()">
      <nav class="editor-files" aria-label="Tệp trong worktree">
        @if (changed().length) {
          <div class="label editor-group">ĐÃ SỬA</div>
          @for (f of changed(); track f.path) {
            <button class="file-row" [class.active]="f.path === path()" [attr.aria-current]="f.path === path()" (click)="open(f.path)">
              <span class="agent-dot" aria-hidden="true"></span>
              <span class="mono ellipsis">{{ f.path }}</span>
              <span class="file-status" [attr.data-status]="f.status" [attr.aria-label]="statusLabel[f.status]">{{ f.status }}</span>
            </button>
          }
        }
        <div class="label editor-group">TẤT CẢ TỆP</div>
        @for (p of others(); track p) {
          <button class="file-row" [class.active]="p === path()" [attr.aria-current]="p === path()" (click)="open(p)">
            <span class="mono ellipsis">{{ p }}</span>
          </button>
        }
        @if (truncated()) { <p class="dim pad">Chỉ hiện {{ files().length }} tệp đầu.</p> }
      </nav>
      <div class="editor-main">
        <div class="editor-bar">
          @if (path(); as p) {
            <span class="mono ellipsis">{{ p }}</span>
            @if (dirty()) { <span class="dirty" title="Chưa lưu">● chưa lưu</span> }
            <span class="spacer"></span>
            @if (marks().added.length || marks().removedBefore.length) {
              <span class="dim">{{ meta[agent()].name }} sửa {{ marks().added.length }} dòng</span>
            }
            @if (running()) { <span class="dim">Chỉ đọc khi agent đang chạy</span> }
            @if (dirty()) { <button class="btn ghost sm" [disabled]="busy()" (click)="revert()">Hoàn tác</button> }
            <button class="btn primary sm" [disabled]="busy() || running() || !dirty()" (click)="save()">Lưu<span class="kbd">⌘S</span></button>
          } @else {
            <span class="dim">Chọn một tệp để mở.</span>
          }
        </div>
        @if (pendingOpen(); as next) {
          <div class="editor-confirm" role="alert">
            <span>{{ path() }} có thay đổi chưa lưu.</span>
            <span class="spacer"></span>
            <button class="btn ghost sm" (click)="pendingOpen.set(null)">Ở lại</button>
            <button class="btn ghost sm" (click)="discardAndOpen(next)">Bỏ thay đổi</button>
            <button class="btn primary sm" [disabled]="running()" (click)="saveAndOpen(next)">Lưu rồi mở</button>
          </div>
        }
        @if (error()) { <p class="error-text pad" role="alert">{{ error() }}</p> }
        <div #host class="editor-host" [class.hidden]="!path()"></div>
      </div>
    </div>
  `,
})
export class CodeEditor implements OnDestroy {
  private readonly runs = inject(RunsService);
  readonly runId = input.required<string>();
  readonly agent = input.required<AgentId>();
  readonly running = input(false);

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  protected readonly meta = AGENT_META;
  protected readonly statusLabel: Record<string, string> = { M: 'Đã sửa', A: 'Tệp mới', D: 'Đã xóa' };
  protected readonly files = signal<string[]>([]);
  protected readonly diffs = signal<FileDiff[]>([]);
  protected readonly path = signal<string | null>(null);
  protected readonly dirty = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly pendingOpen = signal<string | null>(null);
  protected readonly color = computed(() => AGENT_META[this.agent()].color);
  /** Deleted files cannot be opened, so they stay in the review view only. */
  protected readonly changed = computed(() => this.diffs().filter((f) => f.status !== 'D' && !f.binary));
  protected readonly others = computed(() => {
    const changed = new Set(this.changed().map((f) => f.path));
    return this.files().filter((p) => !changed.has(p));
  });
  protected readonly truncated = computed(() => this.files().length >= 5000);
  protected readonly marks = computed(() => lineMarks(this.diffs().find((f) => f.path === this.path())));

  private monaco: MonacoApi | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private decorations: Monaco.editor.IEditorDecorationsCollection | null = null;
  private saved = '';

  constructor() {
    afterNextRender(() => void this.mount());
    // Reload when switching runs, and once more when the agent finishes writing.
    effect(() => {
      this.runId();
      const running = this.running();
      untracked(() => {
        this.editor?.updateOptions({ readOnly: running });
        void this.refresh();
      });
    });
    effect(() => {
      const marks = this.marks();
      untracked(() => this.paint(marks));
    });
  }

  ngOnDestroy(): void {
    this.editor?.getModel()?.dispose();
    this.editor?.dispose();
    this.editor = null;
  }

  protected open(path: string): void {
    if (path === this.path()) return;
    if (this.dirty()) {
      this.pendingOpen.set(path);
      return;
    }
    void this.load(path);
  }

  protected async discardAndOpen(path: string): Promise<void> {
    this.pendingOpen.set(null);
    this.dirty.set(false);
    await this.load(path);
  }

  protected async saveAndOpen(path: string): Promise<void> {
    this.pendingOpen.set(null);
    if (await this.save()) await this.load(path);
  }

  protected revert(): void {
    this.editor?.getModel()?.setValue(this.saved);
    this.dirty.set(false);
  }

  protected async save(): Promise<boolean> {
    const path = this.path();
    const model = this.editor?.getModel();
    if (!path || !model || this.running() || this.busy()) return false;
    const text = model.getValue();
    return this.guard(async () => {
      await this.runs.writeFile(this.runId(), path, text);
      this.saved = text;
      this.dirty.set(model.getValue() !== text);
      this.diffs.set(await this.runs.getDiff(this.runId()));
    });
  }

  private async mount(): Promise<void> {
    try {
      this.monaco = await loadMonaco();
    } catch (e) {
      this.error.set(`Không tải được editor: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (this.editor) return;
    const monaco = this.monaco;
    this.editor = monaco.editor.create(this.host().nativeElement, {
      theme: 'tg-dark',
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 19,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      lineDecorationsWidth: 6,
      readOnly: this.running(),
    });
    this.decorations = this.editor.createDecorationsCollection();
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.save());
    this.editor.onDidChangeModelContent(() => this.dirty.set(this.editor?.getValue() !== this.saved));
    const path = this.path();
    if (path) await this.load(path);
  }

  private async refresh(): Promise<void> {
    await this.guard(async () => {
      const [files, diffs] = await Promise.all([this.runs.listFiles(this.runId()), this.runs.getDiff(this.runId())]);
      this.files.set(files);
      this.diffs.set(diffs);
      const current = this.path();
      const first = this.changed()[0]?.path ?? files[0] ?? null;
      if (!current || !files.includes(current)) {
        this.dirty.set(false);
        if (first) await this.load(first);
        else this.path.set(null);
      } else if (!this.dirty()) {
        await this.load(current); // the agent may have changed it
      }
    });
  }

  private async load(path: string): Promise<void> {
    await this.guard(async () => {
      const text = await this.runs.readFile(this.runId(), path);
      this.path.set(path);
      this.saved = text;
      this.dirty.set(false);
      const monaco = this.monaco;
      if (!monaco || !this.editor) return;
      const uri = monaco.Uri.from({ scheme: 'tg', path: `/${this.runId()}/${path}` });
      const old = this.editor.getModel();
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, undefined, uri);
      if (model.getValue() !== text) model.setValue(text);
      this.editor.setModel(model);
      if (old && old !== model) old.dispose();
      this.paint(this.marks());
      const first = this.marks().added[0] ?? this.marks().removedBefore[0];
      if (first) this.editor.revealLineInCenter(first);
    });
  }

  private paint(marks: ReturnType<typeof lineMarks>): void {
    const monaco = this.monaco;
    const model = this.editor?.getModel();
    if (!monaco || !model || !this.decorations) return;
    const last = model.getLineCount();
    const whole = (line: number, options: Monaco.editor.IModelDecorationOptions) => ({
      range: new monaco.Range(Math.min(line, last), 1, Math.min(line, last), 1),
      options: { isWholeLine: true, ...options },
    });
    this.decorations.set([
      ...marks.added.map((l) => whole(l, { className: 'agent-line', linesDecorationsClassName: 'agent-gutter' })),
      ...marks.removedBefore.map((l) => whole(l, { linesDecorationsClassName: 'agent-gutter-del' })),
    ]);
  }

  private async guard(work: () => Promise<void>): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
      return true;
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
