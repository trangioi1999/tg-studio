import { Component, computed, inject } from '@angular/core';
import { AgentBackend } from '../../../core/backend';
import { contextLabel, contextTone } from '../../../shared/utils/context';
import { ChatState } from '../chat.state';
import { ContextPanel } from './context-panel';

/** How full the agent's context window is, as a ring and a percentage; opens the breakdown. */
@Component({
  selector: 'tg-context-chip',
  imports: [ContextPanel],
  template: `
@if (view(); as v) {
  <span class="ctx-wrap">
    <button class="ctx-chip" [class.open]="chat.menu() === 'context'" [attr.data-tone]="v.tone" [attr.aria-expanded]="chat.menu() === 'context'" aria-haspopup="dialog"
      [attr.aria-label]="'Context đã dùng ' + v.label" title="Context của agent" (click)="toggle()">
      <span class="ctx-ring" aria-hidden="true" [style.--ctx-pct]="v.pct + '%'"></span>
      <span class="ctx-label">{{ v.label }}</span>
    </button>
    @if (chat.menu() === 'context') { <tg-context-panel /> }
  </span>
}
  `,
})
export class ContextChip {
  protected readonly chat = inject(ChatState);
  private readonly backend = inject(AgentBackend);
  protected readonly view = computed(() => {
    const c = this.chat.run()?.context;
    const label = c ? contextLabel(c) : '';
    return c && label ? { label, tone: contextTone(c.percent), pct: Math.min(100, Math.max(0, c.percent ?? 0)) } : null;
  });

  protected toggle(): void {
    const opening = this.chat.menu() !== 'context';
    this.chat.toggleMenu('context');
    const id = this.chat.run()?.id;
    if (opening && id) void this.backend.refreshContext(id).catch(() => {});
  }
}
