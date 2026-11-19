import { Component, DestroyRef, ElementRef, afterNextRender, inject } from '@angular/core';
import { Explorer } from '../features/files/explorer';
import { Splitter } from '../shared/ui/splitter';
import { Workbench } from '../features/workbench/workbench';
import { SIDE_COMPACT_PX, UiService } from '../services/app/ui.service';

/** The code beside the chat: the project or draft's files, editors and reviews. */
@Component({
  selector: 'tg-side-panel',
  imports: [Explorer, Splitter, Workbench],
  host: { '[class.compact]': 'ui.sideCompact()', '(keydown.escape)': 'escape($event)' },
  template: `
    <tg-splitter class="split-edge" pane="side" target="parent" [grow]="-1" />
    <!-- Hidden, not removed: the tree keeps its folds and filter. -->
    <tg-explorer class="side-files" [class.hidden]="!ui.filesShown()" />
    <tg-splitter pane="files" [class.hidden]="!ui.filesShown()" />
    <tg-workbench class="side-work" />
  `,
})
export class SidePanel {
  protected readonly ui = inject(UiService);

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(([e]) => {
        // Closed, the panel measures 0: keep the last real width.
        const w = e.contentRect.width;
        if (w > 0) this.ui.sideCompact.set(w < SIDE_COMPACT_PX);
      });
      ro.observe(el);
      destroy.onDestroy(() => ro.disconnect());
    });
  }

  /** Esc closes the panel, unless it belongs to the editor or a field. */
  protected escape(e: Event): void {
    const t = e.target as HTMLElement | null;
    if (e.defaultPrevented || t?.closest('input, textarea, select, [contenteditable], .monaco-editor, .xterm')) return;
    this.ui.sideOpen.set(false);
  }
}
