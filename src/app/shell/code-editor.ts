import { Component, ElementRef, OnDestroy, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import { KEYS } from '../core/keys';
import { lineMarks } from '../core/line-marks';
import { EDITOR_OPTIONS, EditorStatus, MonacoApi, addWrapToggle, loadMonaco, trackStatus } from '../core/monaco';
import { AGENT_META, AgentId, Hunk } from '../core/protocol';
import { RunsService } from '../core/runs.service';
import { WorkspaceService, tabKey } from '../core/workspace.service';
import { EditorStatusBar } from './editor-status';
import { errorText } from '../shared/errors';

interface Buffer {
  model: Monaco.editor.ITextModel;
  /** Text as last read from or written to disk. */
  saved: string;
}

/**
 * Monaco on one file of a task's worktree. The agent's lines get a bar in its colour,
 * each pending hunk gets an Accept/Reject bar underneath, and the agent's cursor shows
 * while it works. Each file keeps its own model, so unsaved edits survive tab switches.
 */
@Component({
  selector: 'tg-code-editor',
  imports: [EditorStatusBar],
  template: `
    <div class="editor-main" [style.--agent]="color()">
      <div class="editor-bar">
        <nav class="crumbs mono ellipsis" aria-label="Đường dẫn">
          @for (part of crumbs(); track $index; let last = $last) {
            <span [class.crumb-last]="last">{{ part }}</span>
            @if (!last) { <span class="dim">›</span> }
          }
        </nav>
        @if (dirty()) { <span class="dirty" title="Chưa lưu">● chưa lưu</span> }
        <span class="spacer"></span>
        @if (agentHere()) {
          <span class="live-dot" aria-hidden="true"></span><span class="dim">{{ meta[agent()].name }} {{ hereLabel() }}</span>
        }
        @if (hunks().length) { <span class="dim">· {{ hunks().length }} đoạn agent sửa</span> }
        @if (dirty()) { <button class="btn ghost sm" [disabled]="busy()" (click)="revert()">Hoàn tác</button> }
        <button class="btn primary sm" [disabled]="busy() || running() || !dirty()" (click)="save()">Lưu<span class="kbd">{{ keys.save }}</span></button>
      </div>
      @if (error()) { <p class="error-text pad" role="alert">{{ error() }}</p> }
      <div #host class="editor-host"></div>
      <tg-editor-status [status]="status()" [wrap]="wrap()" [note]="running() ? 'Chỉ đọc khi agent chạy' : null" (toggleWrap)="toggleWrap?.()" />
    </div>
  `,
})
export class CodeEditor implements OnDestroy {
  private readonly runs = inject(RunsService);
  private readonly workspace = inject(WorkspaceService);
  readonly runId = input.required<string>();
  readonly agent = input.required<AgentId>();
  /** The agent worked in the user's folder: changes are already there, so keep or undo them. */
  protected readonly direct = computed(() => this.runs.runs().find((r) => r.id === this.runId())?.place === 'direct');
  readonly running = input(false);
  readonly path = input.required<string>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  protected readonly meta = AGENT_META;
  protected readonly keys = KEYS;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly dirty = signal(false);
  protected readonly color = computed(() => AGENT_META[this.agent()].color);
  protected readonly crumbs = computed(() => this.path().split('/'));
  protected readonly status = signal<EditorStatus | null>(null);
  protected readonly wrap = signal(false);
  protected toggleWrap: (() => void) | null = null;
  private readonly file = computed(() => (this.workspace.diffs()[this.runId()] ?? []).find((f) => f.path === this.path()));
  protected readonly hunks = computed<Hunk[]>(() => this.file()?.hunks ?? []);
  private readonly marks = computed(() => lineMarks(this.file()));
  private readonly activity = computed(() => (this.running() ? (this.runs.activity()[this.runId()] ?? null) : null));
  protected readonly agentHere = computed(() => {
    const a = this.activity();
    return !!a && this.workspace.relative(this.runId(), a.path) === this.path();
  });
  protected readonly hereLabel = computed(() => (this.activity()?.editing ? 'đang sửa tệp này' : 'đang xem tệp này'));

  private monaco: MonacoApi | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private decorations: Monaco.editor.IEditorDecorationsCollection | null = null;
  private zones: string[] = [];
  private widgets: Monaco.editor.IContentWidget[] = [];
  private readonly buffers = new Map<string, Buffer>();

  constructor() {
    afterNextRender(() => void this.mount());
    effect(() => {
      const key = `${this.runId()}:${this.path()}`;
      untracked(() => void this.show(key));
    });
    effect(() => {
      this.editor?.updateOptions({ readOnly: this.running() });
    });
    // Repaint bars, hunk zones and the cursor whenever the diff or the agent moves.
    effect(() => {
      this.marks();
      this.hunks();
      this.agentHere();
      this.activity()?.line;
      untracked(() => this.paint());
    });
    // The agent just wrote this file: show its version unless the user is editing.
    effect(() => {
      const a = this.activity();
      if (a?.editing && a.done && this.agentHere()) untracked(() => void this.reload());
    });
  }

  ngOnDestroy(): void {
    for (const [key, b] of this.buffers) {
      const text = b.model.getValue();
      if (text !== b.saved) this.workspace.unsaved.set(key, text);
      else this.workspace.unsaved.delete(key);
      b.model.dispose();
    }
    this.editor?.dispose();
    this.editor = null;
  }

  private get key(): string {
    return `${this.runId()}:${this.path()}`;
  }

  protected revert(): void {
    const b = this.buffers.get(this.key);
    if (!b) return;
    b.model.setValue(b.saved);
    this.workspace.unsaved.delete(this.key);
    this.dirty.set(false);
  }

  protected async save(): Promise<boolean> {
    // Fixed before the write: the user may switch tabs while it runs.
    const key = this.key;
    const runId = this.runId();
    const b = this.buffers.get(key);
    if (!b || this.running() || this.busy()) return false;
    const text = b.model.getValue();
    return this.guard(async () => {
      await this.runs.writeFile(runId, this.path(), text);
      b.saved = text;
      if (b.model.isDisposed()) return;
      if (b.model.getValue() === text) this.workspace.unsaved.delete(key);
      if (key === this.key) this.dirty.set(b.model.getValue() !== text);
      await this.workspace.refresh(runId);
    });
  }

  private async mount(): Promise<void> {
    try {
      this.monaco = await loadMonaco();
    } catch (e) {
      this.error.set(`Không tải được editor: ${errorText(e)}`);
      return;
    }
    if (this.editor) return;
    const monaco = this.monaco;
    this.editor = monaco.editor.create(this.host().nativeElement, {
      ...EDITOR_OPTIONS,
      lineDecorationsWidth: 6,
      readOnly: this.running(),
    });
    this.decorations = this.editor.createDecorationsCollection();
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.save());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void this.actAtCursor('accept'));
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backspace, () => void this.actAtCursor('reject'));
    trackStatus(monaco, this.editor, (st) => this.status.set(st));
    this.toggleWrap = addWrapToggle(monaco, this.editor, (on) => this.wrap.set(on));
    this.editor.onDidLayoutChange(() => this.paint());
    this.editor.onDidChangeModelContent(() => {
      const b = this.buffers.get(this.key);
      this.dirty.set(!!b && b.model.getValue() !== b.saved);
      // Editing a previewed file keeps its tab, as in an editor.
      if (this.dirty()) this.workspace.pin(tabKey({ kind: 'file', runId: this.runId(), path: this.path() }));
    });
    await this.show(this.key);
  }

  /** Switches the editor to this tab's buffer, reading the file the first time. */
  private async show(key: string): Promise<void> {
    const monaco = this.monaco;
    if (!monaco || !this.editor) return;
    await this.guard(async () => {
      let b = this.buffers.get(key);
      const known = !!b;
      if (!b) {
        const text = await this.runs.readFile(this.runId(), this.path());
        if (key !== this.key) return;
        const uri = monaco.Uri.from({ scheme: 'tg', path: `/${this.runId()}/${this.path()}` });
        b = { model: monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, undefined, uri), saved: text };
        this.buffers.set(key, b);
        // Back from the review tab with edits that were never saved.
        const unsaved = this.workspace.unsaved.get(key);
        if (unsaved !== undefined) b.model.setValue(unsaved);
      }
      this.editor!.setModel(b.model);
      this.dirty.set(b.model.getValue() !== b.saved);
      if (known) await this.reload(); // the agent may have changed it meanwhile
      this.paint();
      const first = this.cursorLine() ?? this.marks().added[0] ?? this.marks().removedBefore[0];
      if (first) this.editor!.revealLineInCenterIfOutsideViewport(first);
    });
  }

  /** Re-reads the open file from disk, keeping unsaved edits. */
  private async reload(): Promise<void> {
    const key = this.key;
    const b = this.buffers.get(key);
    if (!b || b.model.getValue() !== b.saved) return;
    // Typing while the file is read must not be overwritten by what was on disk.
    const version = b.model.getVersionId();
    await this.guard(async () => {
      const text = await this.runs.readFile(this.runId(), this.path());
      if (b.model.isDisposed() || b.model.getVersionId() !== version) return;
      b.saved = text;
      if (b.model.getValue() !== text) b.model.setValue(text);
      if (key === this.key) this.dirty.set(false);
    });
  }

  private cursorLine(): number | null {
    if (!this.agentHere()) return null;
    return this.activity()?.line ?? this.marks().added[0] ?? 1;
  }

  private paint(): void {
    const monaco = this.monaco;
    const model = this.editor?.getModel();
    if (!monaco || !model || !this.decorations || !this.editor) return;
    const marks = this.marks();
    const last = model.getLineCount();
    const whole = (line: number, options: Monaco.editor.IModelDecorationOptions) => ({
      range: new monaco.Range(Math.min(line, last), 1, Math.min(line, last), 1),
      options: { isWholeLine: true, ...options },
    });
    const cursor = this.cursorLine();
    const at = cursor === null ? null : Math.min(cursor, last);
    this.decorations.set([
      ...marks.added.map((l) => whole(l, { className: 'agent-line', linesDecorationsClassName: 'agent-gutter' })),
      ...marks.removedBefore.map((l) => whole(l, { linesDecorationsClassName: 'agent-gutter-del' })),
      ...(at === null ? [] : [{
        range: new monaco.Range(at, model.getLineMaxColumn(at), at, model.getLineMaxColumn(at)),
        options: {
          className: 'agent-cursor-line',
          isWholeLine: true,
          showIfCollapsed: true,
          after: { content: ` ${AGENT_META[this.agent()].name}`, inlineClassName: 'agent-cursor' },
        },
      }]),
    ]);
    this.paintZones(last);
  }

  /**
   * An Accept/Reject bar under each pending hunk. A view zone keeps the space; the bar
   * itself is a content widget, because Monaco's text layer covers view zones and
   * would swallow the clicks.
   */
  private paintZones(last: number): void {
    const editor = this.editor!;
    const monaco = this.monaco!;
    const hunks = this.dirty() ? [] : this.hunks();
    for (const w of this.widgets) editor.removeContentWidget(w);
    const width = Math.max(240, editor.getLayoutInfo().contentWidth - 28);
    const lines = hunks.map((h) => Math.max(1, Math.min(last, h.newLines === 0 ? h.newStart : h.newStart + h.newLines - 1)));
    editor.changeViewZones((acc) => {
      for (const id of this.zones) acc.removeZone(id);
      this.zones = lines.map((line) => acc.addZone({ afterLineNumber: line, heightInPx: 36, domNode: document.createElement('div') }));
    });
    this.widgets = hunks.map((h, i) => {
      // Monaco sets its own display on the widget node, so the flex bar goes inside it.
      const node = document.createElement('div');
      node.style.width = `${width}px`;
      node.append(this.hunkBar(h));
      return {
        getId: () => `tg.hunk.${h.id}.${i}`,
        getDomNode: () => node,
        getPosition: () => ({ position: { lineNumber: lines[i], column: 1 }, preference: [monaco.editor.ContentWidgetPositionPreference.BELOW] }),
      };
    });
    for (const w of this.widgets) editor.addContentWidget(w);
  }

  private hunkBar(h: Hunk): HTMLElement {
    const meta = AGENT_META[this.agent()];
    const bar = document.createElement('div');
    bar.className = 'hunk-zone';
    bar.style.setProperty('--agent', meta.color);
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    Object.assign(avatar.style, { width: '18px', height: '18px' });
    const logo = document.createElement('img');
    Object.assign(logo, { src: `agents/${this.agent()}.svg`, alt: meta.name, width: 13, height: 13 });
    avatar.append(logo);
    const label = document.createElement('span');
    label.className = 'hunk-zone-label ellipsis';
    label.textContent = `${meta.name} · ${h.header.replace(/^@@[^@]*@@\s*/, '') || this.path()}`;
    const count = document.createElement('span');
    count.className = 'hunk-count';
    count.innerHTML = `<span class="plus">+${h.added}</span> <span class="minus">−${h.removed}</span>`;
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const button = (text: string, kbd: string, cls: string, action: 'accept' | 'reject') => {
      const b = document.createElement('button');
      b.className = `btn sm ${cls}`;
      b.textContent = text;
      const k = document.createElement('span');
      k.className = 'kbd';
      k.textContent = kbd;
      b.append(k);
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.act(action, h);
      });
      return b;
    };
    // In the user's folder the change is already there: it only needs undoing, and committing
    // happens per file in the Changes tab. A draft's hunk can still be taken one by one.
    if (this.direct()) bar.append(avatar, label, count, spacer, button('Hoàn tác đoạn này', KEYS.backspace, 'ghost', 'reject'));
    else bar.append(avatar, label, count, spacer, button('Bỏ', KEYS.backspace, 'ghost', 'reject'), button('Nhận', KEYS.enter, 'primary', 'accept'));
    return bar;
  }

  private async actAtCursor(action: 'accept' | 'reject'): Promise<void> {
    if (action === 'accept' && this.direct()) return;
    const line = this.editor?.getPosition()?.lineNumber;
    if (!line) return;
    const h = this.hunks().find((x) => line >= x.newStart - 1 && line <= x.newStart + Math.max(x.newLines, 1));
    if (h) await this.act(action, h);
  }

  private async act(action: 'accept' | 'reject', h: Hunk): Promise<void> {
    if (this.busy()) return;
    if (this.running()) {
      this.error.set('Agent đang sửa tệp này. Hãy chờ agent xong rồi mới giữ hay bỏ đoạn sửa.');
      return;
    }
    await this.guard(async () => {
      if (action === 'accept') await this.runs.acceptHunk(this.runId(), this.path(), h.id);
      else await this.runs.rejectHunk(this.runId(), this.path(), h.id);
      await this.workspace.refresh(this.runId());
      // Reject rewrites the file in the worktree.
      if (action === 'reject') await this.reload();
    });
  }

  private async guard(work: () => Promise<void>): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
      return true;
    } catch (e) {
      this.error.set(errorText(e));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
