import { Component, computed, inject, signal } from '@angular/core';
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
      <button class="btn primary sm tl-new" (click)="startNew()">+ Trò chuyện mới</button>
      <button class="btn ghost sm" (click)="workspace.pickFolder()">Mở thư mục</button>
    </div>
    <nav class="tl-tree" aria-label="Dự án và cuộc trò chuyện">
      @for (p of threads.projects(); track p.root) {
        <section class="tl-project">
          <div class="tl-project-head" [class.current]="p.root === workspace.folder()">
            <button class="tl-project-name" [attr.aria-expanded]="!hidden().has(p.root)" [title]="p.root" (click)="toggle(p.root)">
              <span class="twisty" aria-hidden="true">{{ hidden().has(p.root) ? '▸' : '▾' }}</span>
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
              <button class="tl-thread" [class.active]="t.id === threads.selectedId() && ui.screen() === 'chat'" [title]="t.title" (click)="open(t)">
                <span class="tl-agents" aria-hidden="true">
                  @for (a of t.agents; track a) { <tg-agent-avatar [agent]="a" [size]="14" /> }
                </span>
                <span class="ellipsis">{{ t.title }}</span>
                <span class="spacer"></span>
                <span class="tl-status" [attr.data-status]="t.status">{{ label[t.status] }}</span>
              </button>
            } @empty {
              @if (p.root === workspace.folder()) { <p class="dim tl-empty">Chưa có cuộc trò chuyện. Gõ yêu cầu ở ô chat để bắt đầu.</p> }
            }
          }
        </section>
      } @empty {
        <div class="tl-empty">
          <p class="dim">Chưa mở dự án nào.</p>
          <button class="btn primary sm" (click)="workspace.pickFolder()">Mở thư mục</button>
        </div>
      }
    </nav>
    <nav class="tl-screens" aria-label="Màn hình">
      @for (s of screens; track s.id) {
        <button class="tl-screen" [class.active]="ui.screen() === s.id" (click)="toggleScreen(s.id)">
          {{ s.label }}
          @if (s.id === 'mission' && waiting()) { <span class="needs">{{ waiting() }}</span> }
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
  protected readonly screens: { id: Screen; label: string }[] = [
    { id: 'mission', label: 'Giám sát' },
    { id: 'usage', label: 'Chi phí' },
    { id: 'agents', label: 'Agent' },
    { id: 'integrations', label: 'Kết nối' },
  ];
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
