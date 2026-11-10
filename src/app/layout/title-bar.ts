import { Component, computed, inject, signal } from '@angular/core';
import { AgentBackend } from '../core/backend';
import { fmtTokens, fmtUsd } from '../shared/utils/format';
import { IS_MAC } from '../shared/utils/keys';
import { costOf } from '../services/usage/pricing';
import { RunsService } from '../services/runs/runs.service';
import { UiService } from '../services/app/ui.service';
import { WorkspaceService } from '../services/workspace.service';

/**
 * The app's own title bar: project, branch and conversation on the left, cost and the
 * side panel toggle on the right, then the window buttons (Windows and Linux).
 */
@Component({
  selector: 'tg-title-bar',
  template: `
    <header class="titlebar" data-tauri-drag-region [class.mac]="isMac">
      <span class="brand-mark" aria-hidden="true" data-tauri-drag-region>TG</span>
      @if (editing()) {
        <form class="repo-edit" (submit)="$event.preventDefault(); apply()">
          <input class="mono" aria-label="Thư mục làm việc" [value]="draft()" (input)="draft.set($any($event.target).value)" (keydown.escape)="cancelEdit()" spellcheck="false" />
          <button class="btn primary sm" type="submit">Mở</button>
          <button class="btn ghost sm" type="button" (click)="cancelEdit()">Hủy</button>
        </form>
      } @else {
        <nav class="crumbs" aria-label="Vị trí" data-tauri-drag-region>
          <button class="crumb-btn" (click)="startEdit()" [title]="(workspace.repo()?.root ?? workspace.folder()) || 'Nhập đường dẫn'">
            @if (workspace.repo(); as r) {
              <span>{{ r.name }}</span>
              <span class="branch mono">
                <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/></svg>{{ r.branch ?? 'HEAD tách rời' }}
              </span>
            } @else if (workspace.folder()) {
              <span class="ellipsis">{{ folderName() }}</span>
              <span class="tag warn">không phải repo Git</span>
            } @else {
              <span class="dim">TG Studio</span>
            }
            @if (workspace.project()?.git === 'no_commits') { <span class="tag warn">chưa có commit</span> }
          </button>
          @if (title(); as t) { <span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-title ellipsis" [title]="t">{{ t }}</span> }
        </nav>
      }
      @if (workspace.folderError(); as e) { <span class="error-text ellipsis" role="alert" [title]="e">{{ e }}</span> }
      <span class="spacer" data-tauri-drag-region></span>
      @if (cost(); as c) { <span class="tb-cost mono" title="Chi phí của cuộc trò chuyện này">{{ c }}</span> }
      @if (ui.screen() === 'chat') {
        <button class="icon-btn" [class.on]="ui.sideOpen()" [attr.aria-pressed]="ui.sideOpen()" aria-label="Tệp và thay đổi" title="Tệp và thay đổi" (click)="ui.sideOpen.set(!ui.sideOpen())">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>
        </button>
      }
      @if (!isMac) {
        <div class="win-controls">
          <button aria-label="Thu nhỏ" (click)="win('minimize')"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button>
          <button aria-label="Phóng to" (click)="win('maximize')"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>
          <button class="close" aria-label="Đóng" (click)="win('close')"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button>
        </div>
      }
    </header>
  `,
})
export class TitleBar {
  private readonly backend = inject(AgentBackend);
  protected readonly runs = inject(RunsService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly ui = inject(UiService);
  protected readonly isMac = IS_MAC;
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly folderName = computed(() => this.workspace.folder().split(/[\\/]/).filter(Boolean).at(-1) ?? this.workspace.folder());
  protected readonly title = computed(() => {
    if (this.ui.screen() !== 'chat') return null;
    const r = this.runs.selected();
    return r ? r.prompt.split('\n')[0] : 'Trò chuyện mới';
  });
  /** Cost and tokens of the open conversation. */
  protected readonly cost = computed(() => {
    const r = this.runs.selected();
    if (!r || this.ui.screen() !== 'chat') return null;
    const all = this.runs.runs().filter((x) => (r.group ? x.group === r.group : x.thread === r.thread) && x.usage);
    if (!all.length) return null;
    const usd = all.reduce((n, x) => n + (costOf(x.agent, x.usage, x.startedAt).usd ?? 0), 0);
    const tok = all.reduce((n, x) => n + x.usage!.inputTokens + x.usage!.cachedInputTokens + x.usage!.outputTokens, 0);
    return `${fmtUsd(usd)} · ${fmtTokens(tok)} tok`;
  });

  protected win(action: 'minimize' | 'maximize' | 'close'): void {
    void this.backend.windowAction(action).catch((e) => console.warn('Không điều khiển được cửa sổ', e));
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
