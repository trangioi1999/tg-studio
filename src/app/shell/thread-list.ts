import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { KEYS } from '../core/keys';
import { AGENT_META } from '../core/protocol';
import { RunsService } from '../core/runs.service';
import { THREAD_STATUS_LABEL, Thread, ThreadsService } from '../core/threads.service';
import { Screen, UiService } from '../core/ui.service';
import { WorkspaceService } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';

/** Left column: projects and their conversations, then the screens beyond the chat. */
@Component({
  selector: 'tg-thread-list',
  imports: [AgentAvatar],
  template: `
    <div class="tl-top">
      <button class="tl-new" (click)="startNew()">
        <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        Trò chuyện mới<span class="spacer"></span><span class="kbd">{{ keys.newChat }}</span>
      </button>
    </div>
    <nav class="tl-tree" aria-label="Dự án và cuộc trò chuyện">
      @for (p of threads.projects(); track p.root) {
        <section class="tl-project">
          <div class="tl-project-head" [class.current]="p.root === workspace.folder()">
            <button class="tl-project-name" [attr.aria-expanded]="!hidden().has(p.root)" [title]="p.root" (click)="toggle(p.root)">
              <svg class="ic folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
              <span class="ellipsis">{{ p.name }}</span>
              @if (hidden().has(p.root) && waitingIn(p.threads); as n) { <span class="needs" [title]="n + ' cần bạn'">{{ n }}</span> }
            </button>
            <button class="tl-add" [attr.aria-label]="'Trò chuyện mới trong ' + p.name" title="Trò chuyện mới trong dự án này" (click)="startNew(p.root)">+</button>
            @if (!p.threads.length && p.root !== workspace.folder()) {
              <button class="tl-add" [attr.aria-label]="'Bỏ ' + p.name + ' khỏi danh sách'" title="Bỏ khỏi danh sách" (click)="threads.forget(p.root)">×</button>
            }
          </div>
          @if (!hidden().has(p.root)) {
            @for (t of p.threads; track t.id) {
              <button class="tl-thread" [class.active]="t.id === threads.selectedId() && ui.screen() === 'chat'" [title]="t.title + ' · ' + label[t.status]" (click)="open(t)">
                <span class="tl-agents" aria-hidden="true">
                  @for (a of t.agents.slice(0, 3); track a) { <tg-agent-avatar [agent]="a" [size]="20" /> }
                </span>
                <span class="tl-title ellipsis">{{ t.title }}</span>
                <span class="pill" [attr.data-status]="t.status">
                  @switch (t.status) {
                    @case ('running') { <span class="spin" aria-hidden="true"></span> }
                    @case ('needs_you') { <span aria-hidden="true">●</span> }
                    @case ('failed') { <span aria-hidden="true">✕</span> }
                    @default { <span aria-hidden="true">✓</span> }
                  }
                  {{ label[t.status] }}
                </span>
              </button>
            } @empty {
              @if (p.root === workspace.folder() && !p.scopes.length) { <p class="dim tl-empty">Chưa có cuộc trò chuyện. Gõ yêu cầu ở ô chat để bắt đầu.</p> }
            }
            @for (g of p.scopes; track g.scope) {
              <div class="tl-scope mono ellipsis" [title]="g.scope">{{ g.scope }}/</div>
              @for (t of g.threads; track t.id) {
                <button class="tl-thread" [class.active]="t.id === threads.selectedId() && ui.screen() === 'chat'" [title]="t.title + ' · ' + label[t.status]" (click)="open(t)">
                <span class="tl-agents" aria-hidden="true">
                  @for (a of t.agents.slice(0, 3); track a) { <tg-agent-avatar [agent]="a" [size]="20" /> }
                </span>
                <span class="tl-title ellipsis">{{ t.title }}</span>
                <span class="pill" [attr.data-status]="t.status">
                  @switch (t.status) {
                    @case ('running') { <span class="spin" aria-hidden="true"></span> }
                    @case ('needs_you') { <span aria-hidden="true">●</span> }
                    @case ('failed') { <span aria-hidden="true">✕</span> }
                    @default { <span aria-hidden="true">✓</span> }
                  }
                  {{ label[t.status] }}
                </span>
              </button>
              }
            }
          }
        </section>
      } @empty {
        <div class="tl-empty">
          <p class="dim">Chưa mở dự án nào.</p>
        </div>
      }
    </nav>
    <button class="tl-open" (click)="workspace.pickFolder()">
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      Mở thư mục…
    </button>
    <nav class="tl-screens" aria-label="Màn hình">
      @for (s of screens; track s.id) {
        <button class="tl-screen" [class.active]="ui.screen() === s.id" [attr.aria-label]="s.label" [title]="s.label" (click)="toggleScreen(s.id)">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="s.icon"/></svg>
          @if (s.id === 'mission' && waiting()) { <span class="dot-badge" aria-hidden="true">{{ waiting() }}</span> }
        </button>
      }
    </nav>
  `,
})
export class ThreadList {
  protected readonly threads = inject(ThreadsService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly ui = inject(UiService);
  private readonly runs = inject(RunsService);
  protected readonly meta = AGENT_META;
  protected readonly label = THREAD_STATUS_LABEL;
  protected readonly hidden = signal(new Set<string>());
  protected readonly keys = KEYS;
  protected readonly screens: { id: Screen; label: string; icon: string }[] = [
    { id: 'mission', label: 'Giám sát', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
    { id: 'usage', label: 'Chi phí', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
    { id: 'agents', label: 'Agent', icon: 'M8 8h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zM12 8V4M9.5 13.5h.01M14.5 13.5h.01' },
    { id: 'integrations', label: 'Kết nối', icon: 'M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5' },
  ];

  /** Ctrl/⌘+N starts a new conversation from anywhere. */
  @HostListener('window:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      void this.startNew();
    }
  }
  /** Approval cards open in any conversation. */
  protected readonly waiting = computed(() => this.runs.runs().reduce((n, r) => n + r.permissions.length, 0));

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
  }

  protected async open(t: Thread): Promise<void> {
    this.ui.screen.set('chat');
    await this.threads.select(t);
  }

  protected async startNew(root?: string): Promise<void> {
    this.ui.screen.set('chat');
    await this.threads.newChat(root);
  }
}
