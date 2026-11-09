import { Component, inject } from '@angular/core';
import { effect, signal, untracked } from '@angular/core';
import { BridgeNote } from '../core/protocol';
import { AgentAvatar } from '../shared/agent-avatar';
import { ChatState } from './chat.state';

/** The agent's plan and the notes agents share through tg-bridge. */
@Component({
  selector: 'tg-plan-tab',
  imports: [AgentAvatar],
  template: `
@if (chat.run()?.plan?.length) {
  <ul class="ap-plan">
    @for (p of chat.run()!.plan; track $index) {
      <li [attr.data-status]="p.status">
        <span class="plan-mark" aria-hidden="true"></span>
        <span>{{ p.content }}</span>
        <span class="sr-only">{{ planLabel[p.status] ?? p.status }}</span>
      </li>
    }
  </ul>
} @else {
  <p class="dim">Agent chưa gửi kế hoạch cho cuộc trò chuyện này.</p>
}
<div class="ap-notes" aria-label="Ghi chú chung">
  <div class="label">GHI CHÚ CHUNG · TG-BRIDGE</div>
  @for (n of notes(); track $index) {
    <article class="ap-note">
      <div class="ap-note-head"><tg-agent-avatar [agent]="n.agent" [size]="16" /><strong>{{ n.topic }}</strong><span class="spacer"></span><span class="dim">{{ time(n.at) }}</span></div>
      <p>{{ n.text }}</p>
    </article>
  } @empty {
    <p class="dim">Chưa có ghi chú. Agent ghi qua tool <code>write_note</code> của tg-bridge; mọi agent cùng việc đọc được.</p>
  }
</div>
  `,
})
export class PlanTab {
  protected readonly chat = inject(ChatState);
  protected readonly planLabel: Record<string, string> = { completed: 'xong', in_progress: 'đang làm', pending: 'chưa làm' };
  protected readonly notes = signal<BridgeNote[]>([]);
  private noteLoads = 0;
  /** Notes reload when the tab opens and whenever the run says more. */
  private readonly loadNotes = effect(() => {
    const id = this.chat.run()?.id;
    if (!id) return;
    this.chat.run()?.lines.length;
    const ticket = ++this.noteLoads;
    // Only the latest load counts: switching conversations quickly must not show old notes.
    untracked(() => void this.chat.runs.bridgeNotes(id).then((n) => ticket === this.noteLoads && this.notes.set(n), () => ticket === this.noteLoads && this.notes.set([])));
  });

  protected time(ms: number): string {
    return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(ms);
  }
}
