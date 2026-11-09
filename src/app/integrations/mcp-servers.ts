import { Component, inject } from '@angular/core';
import { AgentAvatar } from '../shared/agent-avatar';
import { IntegrationsState } from './integrations.state';

/** The MCP tab: tg-bridge, presets, and each server with the agents it is on for. */
@Component({
  selector: 'tg-mcp-servers',
  imports: [AgentAvatar],
  template: `
<section id="conn-mcp" role="tabpanel" aria-labelledby="conn-mcp-tab">
  <div class="pg-card conn-bridge">
    <div class="conn-bridge-icon" aria-hidden="true">
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <path d="M3 17c3-6 15-6 18 0M6 13.5V17M12 11.5V17M18 13.5V17M2 17h20" />
      </svg>
    </div>
    <div class="conn-grow">
      <h2>tg-bridge <span class="tag ok">Tích hợp sẵn</span></h2>
      <div class="dim" title="Chỉ nghe trên 127.0.0.1, mỗi task một token riêng">
        Kênh phối hợp giữa các agent. Tool có tác động đều phải qua bạn duyệt.
      </div>
      <div class="conn-chips">
        @for (tool of conn.bridgeTools; track tool.name) {
          <span class="conn-tool mono" [title]="tool.description">{{ tool.name }}</span>
        }
      </div>
    </div>
    <div class="conn-bridge-switch">
      <div class="conn-row">
        <span>Bật cho task Sửa code</span
        ><button
          class="switch"
          role="switch"
          aria-label="Bật cho task Sửa code"
          [attr.aria-checked]="conn.bridgeOn()"
          [disabled]="conn.busy()"
          (click)="conn.setBridge(!conn.bridgeOn())"
        ></button>
      </div>
      <span class="dim">Áp dụng cho lượt chạy mới</span>
    </div>
  </div>
  <div class="conn-section-head">
    <h2>Server của bạn</h2>
    <span
      class="dim"
      title="stdio chạy với mọi agent qua ACP và Claude ở chế độ Chỉ đọc; http chỉ gửi khi agent hỗ trợ, nếu không sẽ ghi log bỏ qua. Biến môi trường và header lưu trong máy này, không mã hoá."
      >stdio chạy lệnh · http khi agent hỗ trợ · lưu cục bộ, không mã hoá</span
    >
  </div>
  @if (!conn.servers().length) {
    <p class="dim">Chưa có server nào. Chọn mẫu bên dưới để thêm công cụ cho agent.</p>
  }
  <div class="conn-servers">
    @for (s of conn.servers(); track s.id) {
      <article class="pg-card conn-server">
        <div class="conn-row">
          <span class="conn-initials">{{ s.name.slice(0, 2).toUpperCase() }}</span>
          <div class="conn-grow">
            <strong>{{ s.name }}</strong>
            <div class="dim">
              {{ s.transport }} ·
              {{
                s.transport === 'stdio'
                  ? s.env.length + ' biến môi trường'
                  : s.headers.length + ' header'
              }}
            </div>
          </div>
          <button
            class="btn sm"
            (click)="conn.edit(s)"
            [attr.aria-label]="'Sửa server ' + s.name"
          >
            Sửa
          </button>
        </div>
        <div class="conn-command mono" [title]="conn.target(s)">{{ conn.target(s) }}</div>
        <div class="conn-chips">
          @for (a of conn.agents; track a) {
            <button
              class="fchip conn-agent"
              [attr.aria-pressed]="s.agents.includes(a)"
              [attr.aria-label]="s.name + ' cho ' + conn.meta[a].name"
              [disabled]="conn.busy()"
              (click)="conn.toggle(s, a)"
            >
              <tg-agent-avatar [agent]="a" [size]="14" />{{ conn.meta[a].name }}
            </button>
          }
        </div>
        @if (conn.confirming() === 'server:' + s.id) {
          <div class="conn-confirm" role="group" [attr.aria-label]="'Xoá ' + s.name">
            <span>Xoá server này?</span
            ><button class="btn sm" (click)="conn.confirming.set(null)">Huỷ</button
            ><button class="btn sm conn-danger" [disabled]="conn.busy()" (click)="conn.remove(s)">
              Xoá
            </button>
          </div>
        } @else {
          <button class="btn sm conn-delete" (click)="conn.confirming.set('server:' + s.id)">
            Xoá
          </button>
        }
      </article>
    }
    <article class="pg-card conn-server conn-add">
      <button class="conn-add-button" (click)="conn.preset('custom')">
        <span aria-hidden="true">＋</span>Thêm server
      </button>
      <div class="conn-chips">
        @for (p of conn.presets; track p.id) {
          <button class="fchip" (click)="conn.preset(p.id)">{{ p.label }}</button>
        }
      </div>
    </article>
  </div>
</section>
  `,
})
export class McpServers {
  protected readonly conn = inject(IntegrationsState);
}
