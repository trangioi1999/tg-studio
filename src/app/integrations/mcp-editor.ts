import { Component, inject, ElementRef, ViewChild } from '@angular/core';
import { AgentAvatar } from '../shared/agent-avatar';
import { IntegrationsState } from './integrations.state';

/** The drawer that adds or edits an MCP server. */
@Component({
  selector: 'tg-mcp-editor',
  imports: [AgentAvatar],
  template: `
@if (conn.draft(); as d) {
  <div class="sheet-backdrop" (click)="conn.closeDrawer()">
    <form
      class="sheet conn-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conn-server-title"
      (click)="$event.stopPropagation()"
      (keydown)="conn.trapFocus($event)"
      (submit)="$event.preventDefault(); conn.save()"
    >
      <div class="sheet-head">
        <h3 id="conn-server-title">{{ d.id ? 'Sửa MCP server' : 'Thêm MCP server' }}</h3>
        <span class="spacer"></span
        ><button
          type="button"
          class="icon-btn"
          aria-label="Đóng ngăn kéo"
          (click)="conn.closeDrawer()"
        >
          ×
        </button>
      </div>
      <div class="conn-segment" role="group" aria-label="Kiểu kết nối">
        <button
          type="button"
          [attr.aria-pressed]="d.transport === 'stdio'"
          (click)="conn.patch({ transport: 'stdio' })"
        >
          stdio · chạy lệnh</button
        ><button
          type="button"
          [attr.aria-pressed]="d.transport === 'http'"
          (click)="conn.patch({ transport: 'http' })"
        >
          http · URL
        </button>
      </div>
      <label class="field"
        >Tên<input
          #drawerFocus
          class="mono"
          [value]="d.name"
          (input)="conn.patch({ name: $any($event.target).value })"
          required
      /></label>
      @if (d.transport === 'stdio') {
        <label class="field"
          >Lệnh<input
            class="mono"
            [value]="d.command ?? ''"
            (input)="conn.patch({ command: $any($event.target).value })"
            placeholder="npx"
        /></label>
        <label class="field"
          >Tham số (mỗi dòng một tham số)<textarea
            class="mono"
            rows="3"
            [value]="d.args.join('\\n')"
            (input)="conn.patch({ args: conn.lines($any($event.target).value) })"
          ></textarea>
        </label>
      } @else {
        <label class="field"
          >URL<input
            class="mono"
            [value]="d.url ?? ''"
            (input)="conn.patch({ url: $any($event.target).value })"
            placeholder="https://…/mcp"
        /></label>
      }
      <div class="field">
        <span>{{ d.transport === 'stdio' ? 'Biến môi trường' : 'Header' }}</span>
        @for (
          pair of d.transport === 'stdio' ? d.env : d.headers;
          track $index;
          let i = $index
        ) {
          <div class="conn-pair">
            <input
              class="mono"
              aria-label="Tên biến hoặc header"
              placeholder="Tên"
              [value]="pair.name"
              (input)="conn.patchPair(i, { name: $any($event.target).value })"
            /><input
              [type]="d.transport === 'stdio' ? 'password' : 'text'"
              aria-label="Giá trị"
              placeholder="Giá trị"
              autocomplete="off"
              [value]="pair.value"
              (input)="conn.patchPair(i, { value: $any($event.target).value })"
            /><button
              class="icon-btn"
              type="button"
              [attr.aria-label]="'Xoá dòng ' + (i + 1)"
              (click)="conn.removePair(i)"
            >
              ×
            </button>
          </div>
        }
        <button type="button" class="btn sm conn-pair-add" (click)="conn.addPair()">
          {{ d.transport === 'stdio' ? '＋ Thêm biến' : '＋ Thêm header' }}
        </button>
      </div>
      <div class="field">
        <span>Bật cho</span>
        <div class="conn-chips">
          @for (a of conn.agents; track a) {
            <button
              type="button"
              class="fchip"
              [attr.aria-pressed]="d.agents.includes(a)"
              (click)="conn.patch({ agents: conn.flip(d.agents, a) })"
            >
              <tg-agent-avatar [agent]="a" [size]="14" />{{ conn.meta[a].name }}
            </button>
          }
        </div>
      </div>
      <p class="dim">ⓘ Lưu trong máy này, không mã hoá.</p>
      <div class="sheet-foot">
        <span class="spacer"></span
        ><button class="btn" type="button" (click)="conn.closeDrawer()">Huỷ</button
        ><button class="btn primary" type="submit" [disabled]="conn.busy()">Lưu server</button>
      </div>
    </form>
  </div>
}
  `,
})
export class McpEditor {
  protected readonly conn = inject(IntegrationsState);
  /** The drawer takes the focus when it opens. */
  @ViewChild('drawerFocus') set drawerFocus(element: ElementRef<HTMLElement> | undefined) {
    if (element) element.nativeElement.focus();
  }
}
