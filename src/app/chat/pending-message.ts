import { Component, inject } from '@angular/core';
import { AgentAvatar } from '../shared/agent-avatar';
import { AGENT_META } from '../agents/agent-meta';
import { ChatState } from './chat.state';

/** The message just sent, shown while the agent starts (that takes seconds). */
@Component({
  selector: 'tg-pending-message',
  imports: [AgentAvatar],
  template: `
@if (chat.pending(); as p) {
  <div class="msg-user">{{ p.text }}</div>
  <div class="boot-status" role="status">
    @if (p.agent) { <tg-agent-avatar [agent]="p.agent" [size]="20" /> }
    <span>Đang khởi động {{ p.agent ? meta[p.agent].name : 'các agent' }}</span>
    <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
  </div>
}
  `,
})
export class PendingMessage {
  protected readonly chat = inject(ChatState);
  protected readonly meta = AGENT_META;
}
