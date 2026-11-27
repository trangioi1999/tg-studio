import { Component, computed, inject } from '@angular/core';
import { Mascot } from '../../../shared/ui/mascot';
import { canCompact } from '../../../shared/utils/context';
import { ChatState } from '../chat.state';

/** The context is nearly full: offer to summarise the conversation before the agent loses its start. */
@Component({
  selector: 'tg-context-alert',
  imports: [Mascot],
  template: `
@if (shown(); as r) {
  <div class="ctx-alert" role="status">
    <tg-mascot pose="thinking" [size]="44" />
    <span class="ctx-alert-text">Context đã dùng {{ percent() }}%. Thu gọn để agent nhớ tiếp mà không bị cắt ngang?</span>
    <button class="btn warn sm" (click)="chat.compact(r.id)">Thu gọn</button>
  </div>
}
  `,
})
export class ContextAlert {
  protected readonly chat = inject(ChatState);
  protected readonly percent = computed(() => Math.round(this.chat.run()?.context?.percent ?? 0));
  protected readonly shown = computed(() => {
    const r = this.chat.run();
    if (!r || r.status !== 'idle' || (r.context?.percent ?? 0) < 85) return null;
    const list = this.chat.agents.commandsFor(r.agent, r.cwd);
    return canCompact(r.agent, Array.isArray(list) ? list : []) ? r : null;
  });
}
