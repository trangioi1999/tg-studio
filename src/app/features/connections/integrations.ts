import { Component, HostListener, OnInit, inject } from '@angular/core';
import { IntegrationsState } from './integrations.state';
import { McpEditor } from './mcp/mcp-editor';
import { McpServers } from './mcp/mcp-servers';
import { SkillEditor } from './skills/skill-editor';
import { SkillLibrary } from './skills/skill-library';

/** MCP servers (enabled once, handed to every agent's sessions) and the SKILL.md library. */
@Component({
  selector: 'tg-integrations',
  imports: [McpEditor, McpServers, SkillEditor, SkillLibrary],
  providers: [IntegrationsState],
  template: `
    <div class="conn-page">
      <p class="dim set-lead">Công cụ và kỹ năng TG Studio đưa vào phiên của agent, không sửa file cấu hình của agent.</p>
      <div class="conn-bar">
        <div class="segmented" role="tablist" aria-label="Loại kết nối">
          <button
            id="conn-mcp-tab"
            role="tab"
            aria-controls="conn-mcp"
            [class.active]="conn.tab() === 'mcp'"
            [attr.aria-selected]="conn.tab() === 'mcp'"
            (click)="conn.tab.set('mcp')"
          >
            MCP server <span class="pg-count">{{ conn.servers().length }}</span>
          </button>
          <button
            id="conn-skills-tab"
            role="tab"
            aria-controls="conn-skills"
            [class.active]="conn.tab() === 'skills'"
            [attr.aria-selected]="conn.tab() === 'skills'"
            (click)="conn.tab.set('skills')"
          >
            Skill <span class="pg-count">{{ conn.skills().length }}</span>
          </button>
        </div>
        <div class="conn-actions">
          @if (conn.tab() === 'skills') {
            <button class="btn sm icon-text" (click)="conn.rescan()"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5"/></svg>Đọc lại</button>
          }
          <button
            class="btn primary sm"
            (click)="conn.tab() === 'mcp' ? conn.preset('custom') : conn.editSkill(conn.skillTemplate)"
          >
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>{{ conn.tab() === 'mcp' ? 'Thêm server' : 'Thêm skill' }}
          </button>
        </div>
      </div>
      @if (conn.tab() === 'mcp') {
        <tg-mcp-servers />
      } @else {
        <tg-skill-library />
      }
    </div>
    <tg-mcp-editor />
    <tg-skill-editor />
    <div class="conn-toasts">
      @if (conn.error()) {
        <div class="conn-toast conn-toast-error" role="alert">
          <span>{{ conn.error() }}</span
          ><button class="icon-btn" aria-label="Đóng thông báo lỗi" (click)="conn.error.set(null)">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>
          </button>
        </div>
      }
      @if (conn.info()) {
        <div class="conn-toast" role="status">
          <span>{{ conn.info() }}</span
          ><button class="icon-btn" aria-label="Đóng thông báo" (click)="conn.info.set(null)"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button>
        </div>
      }
    </div>
  `,
})
export class Integrations implements OnInit {
  protected readonly conn = inject(IntegrationsState);

  ngOnInit(): void {
    this.conn.init();
  }

  @HostListener('document:keydown.escape')
  protected closeDrawer(): void {
    this.conn.closeDrawer();
  }
}
