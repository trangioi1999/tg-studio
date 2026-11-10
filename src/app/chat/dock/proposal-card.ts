import { Component, inject } from '@angular/core';
import { AgentAvatar } from '../../shared/agent-avatar';
import { AGENT_META } from '../../agents/agent-meta';
import { Markdown } from '../../shared/markdown';
import { ChatState } from '../chat.state';

/** A plan the agent wrote in Chỉ hỏi, offered to carry out in Hỏi trước. */
@Component({
  selector: 'tg-proposal-card',
  imports: [AgentAvatar, Markdown],
  template: `
@if (chat.run(); as r) {
  @if (r.proposal && r.perm === 'read' && r.status !== 'running') {
    <section class="proposal-card" aria-label="Kế hoạch sửa code">
      <div class="proposal-head">
        <tg-agent-avatar [agent]="r.agent" [size]="18" />
        <strong>{{ meta[r.agent].name }} đã lên kế hoạch sửa code</strong>
        <span class="dim">· Chỉ hỏi nên chưa sửa gì</span>
      </div>
      <details><summary>Xem kế hoạch</summary><tg-markdown class="proposal-plan" [text]="r.proposal" /></details>
      <div class="permission-actions">
        <button class="btn ghost sm" (click)="chat.runs.dismissProposal(r.id)">Không</button>
        <button class="btn primary sm" [disabled]="chat.sending() || !!chat.blockedForEdit()" [title]="chat.blockedForEdit() ?? 'Chuyển sang Hỏi trước và làm theo kế hoạch'" (click)="chat.actOnProposal(r)">Làm luôn</button>
      </div>
    </section>
  }
}
  `,
})
export class ProposalCard {
  protected readonly chat = inject(ChatState);
  protected readonly meta = AGENT_META;
}
