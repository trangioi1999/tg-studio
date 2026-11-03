import { Component, OnInit, inject } from '@angular/core';
import { AgentsService } from '../core/agents.service';
import { AGENT_META } from '../core/protocol';
import { AgentAvatar } from './agent-avatar';

@Component({
  selector: 'tg-agents-panel',
  imports: [AgentAvatar],
  template: `
    <div class="panel-head">
      <span class="label">AGENTS</span>
      <button class="btn ghost sm" (click)="agents.refresh()" [disabled]="agents.loading()">
        {{ agents.loading() ? 'Đang dò…' : 'Dò lại' }}
      </button>
    </div>
    <ul class="agent-list">
      @for (a of agents.agents(); track a.id) {
        <li class="agent-row" [class.missing]="!a.path">
          <tg-agent-avatar [agent]="a.id" [size]="24" />
          <div class="agent-info">
            <div class="agent-name">
              {{ a.name }}
              @if (a.path && a.headless) { <span class="tag ok">sẵn sàng</span> }
              @else if (a.path) { <span class="tag">ACP · giai đoạn 1</span> }
              @else { <span class="tag warn">chưa cài</span> }
            </div>
            @if (a.path) {
              <div class="mono dim ellipsis" [title]="a.path">{{ a.version ?? 'không rõ phiên bản' }}</div>
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
  ngOnInit() {
    void this.agents.refresh();
  }
}
