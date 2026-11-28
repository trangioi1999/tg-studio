import { ProjectSettingsForm } from './project-settings';
import { NgTemplateOutlet } from '@angular/common';
import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { KEYS } from '../shared/utils/keys';
import { AGENT_META } from '../services/agents/agent-meta';
import { RunsService } from '../services/runs/runs.service';
import { THREAD_STATUS_LABEL, Thread, ThreadsService } from '../services/runs/threads.service';
import { Screen, UiService } from '../services/app/ui.service';
import { WorkspaceService } from '../services/workspace.service';
import { AgentAvatar } from '../shared/ui/agent-avatar';
import { errorText } from '../shared/utils/errors';
import { runningRows } from './running-group';

/** Left column: projects and their conversations, then the screens beyond the chat. */
@Component({
  selector: 'tg-thread-list',
  imports: [AgentAvatar, NgTemplateOutlet, ProjectSettingsForm],
  template: `
    @if (ui.sidebarCollapsed()) {
      <div class="rail-nav" role="navigation" aria-label="Thanh bên thu gọn">
        <button class="rail-btn" [disabled]="!workspace.folder()" aria-label="Trò chuyện mới"
          [title]="workspace.folder() ? 'Trò chuyện mới (' + keys.newChat + ')' : 'Mở một thư mục trước'" (click)="startNew()">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <button class="rail-btn" aria-label="Hiện danh sách cuộc trò chuyện" [title]="'Dự án và cuộc trò chuyện (' + keys.sidebar + ')'" (click)="ui.toggleSidebar()">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
          @if (needsAll(); as n) { <span class="dot-badge" [attr.aria-label]="n + ' cần bạn'">{{ n }}</span> }
        </button>
        <span class="spacer"></span>
        @for (s of screens; track s.id) {
          <button class="rail-btn" [class.active]="ui.screen() === s.id" [attr.aria-label]="s.label" [title]="s.label" (click)="toggleScreen(s.id)">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="s.icon"/></svg>
            @if (s.id === 'mission' && waiting()) { <span class="dot-badge" aria-hidden="true">{{ waiting() }}</span> }
          </button>
        }
      </div>
    } @else {
    <div class="tl-top">
      <button class="tl-new" [disabled]="!workspace.folder()" [title]="workspace.folder() ? '' : 'Mở một thư mục trước'" (click)="startNew()">
        <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        Trò chuyện mới<span class="spacer"></span><span class="kbd">{{ keys.newChat }}</span>
      </button>
    </div>
    <ng-template #row let-t>
      @if (confirming() === t.id) {
        <div class="tl-confirm" role="group" [attr.aria-label]="'Xoá ' + t.title">
          <span class="grow">{{ confirmText(t) }}</span>
          <button class="btn ghost sm" (click)="confirming.set(null)">Huỷ</button>
          <button class="btn danger sm" [disabled]="removing()" (click)="remove(t)">Xoá</button>
        </div>
      } @else {
        <div class="tl-item">
            <button class="tl-thread" [class.active]="t.id === threads.selectedId() && ui.screen() === 'chat'" [title]="t.title + ' · ' + labelOf(t)" (click)="open(t)">
                <span class="tl-agents" aria-hidden="true">
                  @for (a of t.agents.slice(0, 3); track a) { <tg-agent-avatar [agent]="a" [size]="20" /> }
                </span>
                <span class="tl-title ellipsis">{{ t.title }}</span>
                <span class="pill" [attr.data-status]="t.status">
                  @switch (t.status) {
                    @case ('running') { <span class="spin" aria-hidden="true"></span> }
                    @default { <span class="pill-dot" aria-hidden="true"></span> }
                  }
                  {{ labelOf(t) }}
                </span>
              </button>
          <button class="tl-del" [attr.aria-label]="'Xoá ' + t.title"
            [disabled]="t.status === 'running' || t.status === 'needs_you'"
            [title]="t.status === 'running' || t.status === 'needs_you' ? 'Dừng agent trước khi xoá' : 'Xoá cuộc trò chuyện'"
            (click)="ask(t)">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
          </button>
        </div>
      }
      @if (failed()?.id === t.id) { <p class="error-text tl-err">{{ failed()!.message }}</p> }
    </ng-template>
    <nav class="tl-tree" aria-label="Dự án và cuộc trò chuyện">
      @if (running().rows.length) {
        <section class="rn-group" aria-label="Đang chạy">
          <h2 class="rn-heading">Đang chạy · {{ running().rows.length + running().more }}</h2>
          @for (r of running().rows; track r.id) {
            <button class="rn-row" [class.rn-child]="r.child"
              [title]="r.title + ' · ' + r.project + ' · ' + (r.status === 'needs_you' ? 'Cần bạn' : 'Đang chạy')"
              (click)="ui.openRun(r.open)">
              <tg-agent-avatar [agent]="r.agent" [size]="20" />
              <span class="rn-title">{{ r.title }}</span>
              <span class="rn-dot" [attr.data-status]="r.status" role="img"
                [attr.aria-label]="r.status === 'needs_you' ? 'Cần bạn' : 'Đang chạy'"></span>
            </button>
          }
          @if (running().more) { <p class="rn-more">+{{ running().more }} nữa</p> }
        </section>
      }
      <!-- On the welcome screen its big button opens a folder; a second one here would only repeat it. -->
      @if (workspace.folder() || threads.projects().length || ui.screen() !== 'chat') {
        <div class="tl-group-head">
          <span class="tl-group-name">Dự án</span>
          <button class="tl-add" aria-label="Mở thư mục" title="Mở thư mục…" (click)="workspace.pickFolder()">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6"/></svg>
          </button>
        </div>
      }
      @for (p of threads.projects(); track p.root) {
        <section class="tl-project">
          <div class="tl-project-head" [class.current]="p.root === workspace.folder()">
            <button class="tl-project-name" [attr.aria-expanded]="!hidden().has(p.root)" [title]="p.root" (click)="toggle(p.root)">
              <svg class="ic folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
              <span class="ellipsis">{{ p.name }}</span>
              @if (hidden().has(p.root) && waitingIn(p.threads); as n) { <span class="needs" [title]="n + ' cần bạn'">{{ n }}</span> }
            </button>
            @if (p.root === workspace.folder()) {
              <button class="tl-add" [class.active]="settingsOpen()" [attr.aria-label]="'Thiết lập dự án ' + p.name" [attr.aria-expanded]="settingsOpen()"
                title="Thiết lập dự án: script chuẩn bị, lệnh kiểm tra" (click)="settingsOpen.set(!settingsOpen())"><svg class="ic sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>
            }
            <button class="tl-add" [attr.aria-label]="'Trò chuyện mới trong ' + p.name" title="Trò chuyện mới trong dự án này" (click)="startNew(p.root)"><svg class="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
            @if (!p.threads.length && p.root !== workspace.folder()) {
              <button class="tl-add" [attr.aria-label]="'Bỏ ' + p.name + ' khỏi danh sách'" title="Bỏ khỏi danh sách" (click)="threads.forget(p.root)"><svg class="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button>
            }
          </div>
          @if (settingsOpen() && p.root === workspace.folder()) {
            <tg-project-settings [root]="p.root" (closed)="settingsOpen.set(false)" />
          }
          @if (!hidden().has(p.root)) {
            @for (t of p.threads; track t.id) {
              <ng-container *ngTemplateOutlet="row; context: { $implicit: t }" />
            } @empty {
              @if (p.root === workspace.folder() && !p.scopes.length) { <p class="dim tl-empty">Chưa có cuộc trò chuyện. Gõ yêu cầu ở ô chat để bắt đầu.</p> }
            }
            @for (g of p.scopes; track g.scope) {
              <div class="tl-scope mono ellipsis" [title]="g.scope">{{ g.scope }}/</div>
              @for (t of g.threads; track t.id) {
                <ng-container *ngTemplateOutlet="row; context: { $implicit: t }" />
              }
            }
          }
        </section>
      } @empty {
        <div class="tl-empty">
          <p class="dim">Chưa mở dự án nào</p>
        </div>
      }
    </nav>
    <nav class="tl-screens" aria-label="Màn hình">
      @for (s of screens; track s.id) {
        <button class="tl-screen" [class.active]="ui.screen() === s.id" [attr.aria-label]="s.label" [title]="s.label" (click)="toggleScreen(s.id)">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="s.icon"/></svg>
          <span class="tl-screen-label">{{ s.label }}</span>
          @if (s.id === 'mission' && waiting()) { <span class="dot-badge" aria-hidden="true">{{ waiting() }}</span> }
        </button>
      }
    </nav>
    }
  `,
})
export class ThreadList {
  protected readonly threads = inject(ThreadsService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly ui = inject(UiService);
  private readonly runs = inject(RunsService);
  protected readonly running = computed(() => runningRows(this.runs.runs()));
  protected readonly settingsOpen = signal(false);
  protected readonly meta = AGENT_META;
  protected readonly label = THREAD_STATUS_LABEL;
  protected readonly hidden = signal(new Set<string>());
  protected readonly keys = KEYS;
  protected readonly screens: { id: Screen; label: string; icon: string }[] = [
    { id: 'mission', label: 'Giám sát', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
    { id: 'usage', label: 'Chi phí', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
    { id: 'settings', label: 'Cài đặt', icon: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6' },
  ];

  /** Ctrl/⌘+N starts a new conversation from anywhere; Ctrl/⌘+B folds the sidebar. */
  @HostListener('window:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    // The agent window is modal: no new conversation or sidebar change behind it.
    if (this.ui.agentWindow()) return;
    const key = e.key.toLowerCase();
    if (key === 'n') {
      e.preventDefault();
      if (this.workspace.folder()) void this.startNew();
    } else if (key === 'b') {
      e.preventDefault();
      this.ui.toggleSidebar();
    }
  }
  /** Approval cards open in any conversation. */
  protected readonly waiting = computed(() => this.runs.runs().reduce((n, r) => n + r.permissions.length, 0));
  /** Conversations waiting on the user, across projects: the rail keeps them in sight. */
  protected readonly needsAll = computed(() => this.threads.projects().reduce((n, p) => n + this.waitingIn([...p.threads, ...p.scopes.flatMap((g) => g.threads)]), 0));

  protected waitingIn(list: Thread[]): number {
    return list.filter((t) => t.status === 'needs_you').length;
  }

  protected toggle(root: string): void {
    const next = new Set(this.hidden());
    if (!next.delete(root)) next.add(root);
    this.hidden.set(next);
  }

  protected toggleScreen(id: Screen): void {
    this.ui.screen.set(this.ui.screen() === id ? 'chat' : id);
    this.ui.closePeek();
  }

  protected async open(t: Thread): Promise<void> {
    this.ui.screen.set('chat');
    this.ui.closePeek();
    await this.threads.select(t);
  }

  /** The conversation waiting for the user to confirm its deletion. */
  protected readonly confirming = signal<string | null>(null);
  protected readonly removing = signal(false);
  protected readonly failed = signal<{ id: string; message: string } | null>(null);

  /** The row template's context is untyped, so the label goes through a typed method. */
  protected labelOf(t: Thread): string {
    return this.label[t.status];
  }

  /** Only a draft loses work; changes made in the folder itself stay there. */
  protected confirmText(t: Thread): string {
    const drafts = this.runs.runs().some((r) => r.thread === t.id && r.task && r.perm !== 'read' && r.place !== 'direct');
    return drafts ? 'Xoá cuộc trò chuyện? Bản nháp chưa nhận sẽ mất.' : 'Xoá cuộc trò chuyện? Code của bạn giữ nguyên.';
  }

  protected ask(t: Thread): void {
    this.failed.set(null);
    this.confirming.set(t.id);
  }

  protected async remove(t: Thread): Promise<void> {
    this.removing.set(true);
    try {
      await this.threads.remove(t.id);
    } catch (e) {
      this.failed.set({ id: t.id, message: errorText(e) });
    } finally {
      this.removing.set(false);
      this.confirming.set(null);
    }
  }

  protected async startNew(root?: string): Promise<void> {
    this.ui.screen.set('chat');
    this.ui.closePeek();
    // A new conversation has no changes yet: the previous one's code would only be in the way.
    this.ui.sideOpen.set(false);
    await this.threads.newChat(root);
  }
}
