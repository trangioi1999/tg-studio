import { Component, ElementRef, OnDestroy, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import { AgentBackend } from '../core/backend';
import { EDITOR_OPTIONS, EditorStatus, MonacoApi, addWrapToggle, loadMonaco, trackStatus } from '../core/monaco';
import { EditorStatusBar } from './editor-status';

/** Read-only Monaco on a file of the opened project. Changes go through an agent's draft. */
@Component({
  selector: 'tg-source-viewer',
  imports: [EditorStatusBar],
  template: `
    <div class="editor-main">
      <div class="editor-bar">
        <nav class="crumbs mono ellipsis" aria-label="Đường dẫn">
          @for (part of crumbs(); track $index; let last = $last) {
            <span [class.crumb-last]="last">{{ part }}</span>
            @if (!last) { <span class="dim">›</span> }
          }
        </nav>
        <span class="spacer"></span>
        <button class="btn ghost sm" title="Chép đường dẫn tương đối" (click)="copyPath()">{{ copied() ? 'Đã chép' : 'Chép đường dẫn' }}</button>
      </div>
      @if (error()) { <p class="error-text pad" role="alert">{{ error() }}</p> }
      <div #host class="editor-host" [class.hidden]="error()"></div>
      <tg-editor-status [status]="status()" [wrap]="wrap()" note="Chỉ đọc · giao cho agent để sửa" (toggleWrap)="toggleWrap?.()" />
    </div>
  `,
})
export class SourceViewer implements OnDestroy {
  private readonly backend = inject(AgentBackend);
  readonly root = input.required<string>();
  readonly path = input.required<string>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  protected readonly error = signal<string | null>(null);
  protected readonly crumbs = computed(() => this.path().split('/'));
  protected readonly status = signal<EditorStatus | null>(null);
  protected readonly wrap = signal(false);
  protected readonly copied = signal(false);
  protected toggleWrap: (() => void) | null = null;
  private monaco: MonacoApi | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private model: Monaco.editor.ITextModel | null = null;
  private ticket = 0;

  constructor() {
    afterNextRender(() => void this.mount());
    effect(() => {
      this.root();
      this.path();
      untracked(() => void this.show());
    });
  }

  ngOnDestroy(): void {
    this.ticket += 1;
    this.model?.dispose();
    this.editor?.dispose();
    this.editor = null;
  }

  private async mount(): Promise<void> {
    try {
      this.monaco = await loadMonaco();
      this.editor = this.monaco.editor.create(this.host().nativeElement, { ...EDITOR_OPTIONS, readOnly: true, domReadOnly: true });
      trackStatus(this.monaco, this.editor, (s) => this.status.set(s));
      this.toggleWrap = addWrapToggle(this.monaco, this.editor, (on) => this.wrap.set(on));
      await this.show();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  protected copyPath(): void {
    void navigator.clipboard?.writeText(this.path()).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1200);
    });
  }

  private async show(): Promise<void> {
    if (!this.monaco || !this.editor) return;
    const ticket = ++this.ticket;
    const [root, path] = [this.root(), this.path()];
    try {
      const text = await this.backend.readProjectFile(root, path);
      if (ticket !== this.ticket || !this.editor) return;
      const uri = this.monaco.Uri.from({ scheme: 'tg-source', path: `/${path}` });
      this.model?.dispose();
      this.model = this.monaco.editor.createModel(text, undefined, uri);
      this.editor.setModel(this.model);
      this.error.set(null);
    } catch (e) {
      if (ticket === this.ticket) this.error.set(e instanceof Error ? e.message : String(e));
    }
  }
}
