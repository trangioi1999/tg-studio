import { Component, inject } from '@angular/core';
import { AgentAvatar } from '../../shared/agent-avatar';
import { AGENT_META } from '../../agents/agent-meta';
import { PermissionCard } from './permission-card';
import { ChatState } from '../chat.state';

/** Approval cards of this conversation and of the agents it delegated to, pinned above the composer. */
@Component({
  selector: 'tg-approvals',
  imports: [AgentAvatar, PermissionCard],
  template: `
@if (chat.run(); as r) {
  @if (r.permissions.length || chat.childApprovals().length) {
    <div class="ap-approvals">
      @for (p of r.permissions; track p.requestId) { <tg-permission-card [runId]="r.id" [agent]="r.agent" [request]="p" /> }
      @for (c of chat.childApprovals(); track c.id) {
        <p class="dim ap-child-label"><tg-agent-avatar [agent]="c.agent" [size]="14" /> {{ meta[c.agent].name }} (việc con) cần bạn duyệt:</p>
        @for (p of c.permissions; track p.requestId) { <tg-permission-card [runId]="c.id" [agent]="c.agent" [request]="p" /> }
      }
    </div>
  }
}
  `,
})
export class Approvals {
  protected readonly chat = inject(ChatState);
  protected readonly meta = AGENT_META;
}
