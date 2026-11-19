import { Component, OnInit, inject } from '@angular/core';
import { AgentsService } from '../../services/agents/agents.service';
import { AGENT_META } from '../../services/agents/agent-meta';
import { AgentAvatar } from '../../shared/ui/agent-avatar';
import { copyText } from '../../shared/utils/clipboard';

/** Cài đặt > Agent: the CLIs found on this machine, with the command to install or log in. */
@Component({
  selector: 'tg-agents-panel',
  imports: [AgentAvatar],
  template: `
    <div class="set-section">
      <div class="set-bar">
        <p class="dim set-lead">TG Studio điều khiển các agent CLI đã cài trên máy. Mỗi agent dùng tài khoản của chính nó; đăng nhập một lần trong terminal.</p>
        <button class="btn sm" (click)="agents.refresh()" [disabled]="agents.checking()">
          {{ agents.checking() ? 'Đang dò…' : 'Dò lại' }}
        </button>
      </div>
      <ul class="agent-list pg-card">
        @for (a of agents.agents(); track a.id) {
          <li class="agent-row" [class.missing]="!a.path">
            <tg-agent-avatar [agent]="a.id" [size]="24" />
            <div class="agent-info grow">
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
            @if (!a.path) {
              <button class="btn ghost sm" (click)="copy(meta[a.id].install)">Chép lệnh cài</button>
            } @else if (a.auth === 'none') {
              <button class="btn ghost sm" (click)="copy(meta[a.id].login)">Chép lệnh đăng nhập</button>
            }
          </li>
        } @empty {
          <li class="dim pad">{{ agents.checking() ? 'Đang dò agent…' : 'Chưa dò. Bấm “Dò lại”.' }}</li>
        }
      </ul>
    </div>
  `,
})
export class AgentsPanel implements OnInit {
  protected readonly agents = inject(AgentsService);
  protected readonly meta = AGENT_META;
  ngOnInit() {
    if (!this.agents.agents().length && !this.agents.loading()) void this.agents.refresh();
  }

  protected async copy(text: string): Promise<void> {
    await copyText(text); // if it fails, the command is on screen
  }
}
