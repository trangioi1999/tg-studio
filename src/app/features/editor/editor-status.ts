import { Component, input, output } from '@angular/core';
import { EditorStatus } from './monaco';

/** The line under an editor: cursor, selection, language and word wrap. */
@Component({
  selector: 'tg-editor-status',
  host: { class: 'editor-status' },
  template: `
    @if (status(); as s) {
      <span>Dòng {{ s.line }}, cột {{ s.column }}</span>
      @if (s.selected) { <span>({{ s.selected }} ký tự đã chọn)</span> }
      <span class="dim">{{ s.lines }} dòng</span>
    }
    <span class="spacer"></span>
    @if (note()) { <span class="dim">{{ note() }}</span> }
    <button class="es-btn" [class.on]="wrap()" [attr.aria-pressed]="wrap()" title="Xuống dòng tự động (Alt+Z)" (click)="toggleWrap.emit()">Xuống dòng</button>
    @if (status(); as s) { <span>{{ s.language }}</span> }
  `,
})
export class EditorStatusBar {
  readonly status = input<EditorStatus | null>(null);
  readonly wrap = input(false);
  readonly note = input<string | null>(null);
  readonly toggleWrap = output<void>();
}
