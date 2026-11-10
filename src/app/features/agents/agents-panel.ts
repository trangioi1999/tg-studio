import { Component, OnInit, inject } from '@angular/core';
import { AgentsService } from '../../services/agents/agents.service';
import { AGENT_META } from '../../services/agents/agent-meta';
import { UiService } from '../../services/app/ui.service';
import { AgentAvatar } from '../../shared/ui/agent-avatar';

@Component({
  selector: 'tg-agents-panel',
  imports: [AgentAvatar],
  template: `
    <div class="panel-head">
      <span class="label">AGENTS</span>
      <span class="spacer"></span>
      <button class="btn ghost sm" (click)="ui.onboarding.set(true)">Hướng dẫn</button>
      <button class="btn ghost sm" (click)="agents.refresh()" [disabled]="agents.checking()">
        {{ agents.checking() ? 'Đang dò…' : 'Dò lại' }}
      </button>
    </div>
    <ul class="agent-list">
      @for (a of agents.agents(); track a.id) {
        <li class="agent-row" [class.missing]="!a.path">
          <tg-agent-avatar [agent]="a.id" [size]="24" />
          <div class="agent-info">
            <div class="agent-name">
              {{ a.name }}
              @if (a.path && a.auth === 'ok') { <span class="tag ok">đã đăng nhập</span> }
              @else if (a.path && a.auth === 'none') { <span class="tag warn">cần đăng nhập</span> }
              @else if (a.path && a.headless) { <span class="tag">chưa rõ đăng nhập</span> }
              @else if (a.path) { <span class="tag" title="Agent này chưa có chế độ chỉ-đọc; dùng được ở Sửa code, Thử với nhiều agent và Theo các bước">chỉ Sửa code</span> }
              @else { <span class="tag warn">chưa cài</span> }
            </div>
            @if (a.path) {
              <div class="mono dim ellipsis" [title]="a.path">{{ a.version ?? 'không rõ phiên bản' }}</div>
              @if (a.auth === 'none') { <code class="mono hint">{{ meta[a.id].login }}</code> }
            } @else {
              <code class="mono hint">{{ meta[a.id].install }}</code>
            }
          </div>
        </li>
      } @empty {
        <li class="dim pad">Chưa dò. Bấm “Dò lại”.</li>
      }
    </ul>
  `,
})
export class AgentsPanel implements OnInit {
  protected readonly agents = inject(AgentsService);
  protected readonly meta = AGENT_META;
  protected readonly ui = inject(UiService);
  ngOnInit() {
    if (!this.agents.agents().length && !this.agents.loading()) void this.agents.refresh();
  }
}
