import { Component, computed, inject } from '@angular/core';
import { AGENT_META } from '../../../services/agents/agent-meta';
import { AgentAvatar } from '../../../shared/ui/agent-avatar';
import { PermissionCard } from './permission-card';
import { ChatState } from '../chat.state';

/**
 * The first approval of this conversation (or of an agent it delegated to), as the strip on top
 * of the composer block. It takes the place of the status strip: one thing to answer at a time.
 */
@Component({
  selector: 'tg-approvals',
  imports: [AgentAvatar, PermissionCard],
  template: `
@if (first(); as f) {
  <div class="cx-approve">
    @if (f.child; as c) {
      <p class="dim ap-child-label"><tg-agent-avatar [agent]="c.agent" [size]="14" /> {{ meta[c.agent].name }} (việc con) cần bạn duyệt:</p>
    }
    <tg-permission-card [runId]="f.runId" [agent]="f.agent" [request]="f.request" />
    @if (f.more) { <p class="dim cx-approve-more">Còn {{ f.more }} yêu cầu nữa đang chờ.</p> }
  </div>
}
  `,
})
export class Approvals {
  protected readonly chat = inject(ChatState);
  protected readonly meta = AGENT_META;
  protected readonly first = computed(() => {
    const r = this.chat.run();
    if (!r) return null;
    const asks = [
      ...r.permissions.map((request) => ({ runId: r.id, agent: r.agent, request, child: null as { agent: typeof r.agent } | null })),
      ...this.chat.childApprovals().flatMap((c) => c.permissions.map((request) => ({ runId: c.id, agent: c.agent, request, child: { agent: c.agent } }))),
    ];
    return asks.length ? { ...asks[0], more: asks.length - 1 } : null;
  });
}
