import { Component, computed, inject, signal } from '@angular/core';
import { fmtTokens, fmtUsd } from '../core/format';
import { IS_MAC } from '../core/keys';
import { AGENT_META } from '../core/protocol';
import { Run, RunsService } from '../core/runs.service';
import { WorkspaceService } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';

/** Repository and branch on the left, what each live agent is doing on the right. */
@Component({
  selector: 'tg-title-bar',
  imports: [AgentAvatar],
  template: `
    <header class="titlebar" data-tauri-drag-region [class.mac]="isMac">
      <span class="brand" data-tauri-drag-region>TG Studio</span>
      @if (editing()) {
        <form class="repo-edit" (submit)="$event.preventDefault(); apply()">
          <input class="mono" aria-label="Thư mục làm việc" [value]="draft()" (input)="draft.set($any($event.target).value)" (keydown.escape)="cancelEdit()" spellcheck="false" />
          <button class="btn primary sm" type="submit">Mở</button>
          <button class="btn ghost sm" type="button" (click)="cancelEdit()">Hủy</button>
        </form>
      } @else {
        <button class="repo" (click)="startEdit()" [title]="workspace.repo()?.root ?? workspace.folder()">
          @if (workspace.repo(); as r) {
            <strong>{{ r.name }}</strong>
            <span class="dim">/</span>
            <span class="mono branch">{{ r.branch ?? '(HEAD tách rời)' }}</span>
          } @else {
            <span class="mono ellipsis">{{ workspace.folder() || 'Nhập đường dẫn…' }}</span>
            @if (workspace.folder()) { <span class="tag warn">không phải repo Git</span> }
          }
          @if (workspace.project()?.git === 'no_commits') { <span class="tag warn">chưa có commit</span> }
        </button>
      }
      <button class="btn ghost sm" (click)="pick()">Mở thư mục</button>
      @if (workspace.folderError(); as e) { <span class="error-text ellipsis" role="alert" [title]="e">{{ e }}</span> }
      <span class="spacer" data-tauri-drag-region></span>
      <div class="presence">
        @for (r of live(); track r.id) {
          <button class="chip" [style.--agent]="meta[r.agent].color" [class.attention]="r.permissions.length" (click)="runs.selectedId.set(r.id)">
            <tg-agent-avatar [agent]="r.agent" [size]="16" />
            {{ state(r) }}
            @if (r.usage) { <span class="dim">· {{ tok(r.usage.inputTokens + r.usage.cachedInputTokens + r.usage.outputTokens) }}</span> }
            @if (r.usage?.costUsd != null) { <span class="dim">{{ usd(r.usage!.costUsd) }}</span> }
          </button>
        }
      </div>
    </header>
  `,
})
export class TitleBar {
  protected readonly runs = inject(RunsService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly isMac = IS_MAC;
  protected readonly meta = AGENT_META;
  protected readonly tok = fmtTokens;
  protected readonly usd = fmtUsd;
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly live = computed(() => this.runs.runs().filter((r) => r.status === 'running'));

  protected state(r: Run): string {
    if (r.permissions.length) return 'cần bạn';
    const a = this.runs.activity()[r.id];
    if (a && !a.done) return a.editing ? 'đang sửa' : 'đang đọc';
    return 'đang chạy';
  }

  protected async pick(): Promise<void> {
    await this.workspace.pickFolder();
    if (!this.workspace.folderError()) this.editing.set(false);
  }

  protected cancelEdit(): void {
    this.editing.set(false);
    this.workspace.folderError.set(null);
  }

  protected startEdit(): void {
    this.draft.set(this.workspace.folder());
    this.editing.set(true);
  }

  protected async apply(): Promise<void> {
    // A failed path stays in the box so it can be corrected.
    if (await this.workspace.setFolder(this.draft())) this.editing.set(false);
  }
}
