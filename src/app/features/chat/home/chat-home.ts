import { Component, computed, inject } from '@angular/core';
import { AgentAvatar } from '../../../shared/ui/agent-avatar';
import { AGENT_META } from '../../../services/agents/agent-meta';
import { copyText } from '../../../shared/utils/clipboard';
import { Composer } from '../composer/composer';
import { PendingMessage } from '../conversation/pending-message';
import { ChatState } from '../chat.state';

/** The start screen: open a folder, then ask; the agents found on this machine. */
@Component({
  selector: 'tg-chat-home',
  imports: [AgentAvatar, Composer, PendingMessage],
  template: `
<div class="chat-scroll home">
  <div class="home-col">
    @if (!chat.workspace.folder()) {
      <header class="home-head">
        <h1>Mở một repo để bắt đầu</h1>
        <p class="dim">Giao việc cho các agent code đã cài trên máy, duyệt và gộp thay đổi trong một cửa sổ.</p>
        <button class="btn primary lg" (click)="chat.workspace.pickFolder()">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          Mở thư mục dự án…
        </button>
      </header>
    } @else if (chat.pending()) {
      <div class="pending-col"><tg-pending-message /></div>
      <tg-composer />
    } @else {
      <header class="home-head">
        <h1>{{ projectName() }}</h1>
        <p class="home-repo dim">
          @switch (chat.workspace.project()?.git) {
            @case ('ready') { <span class="status-dot" data-status="ok" aria-hidden="true"></span>Repo Git · nhánh {{ chat.workspace.project()!.branch ?? 'HEAD tách rời' }} }
            @case ('no_commits') { <span class="status-dot" data-status="warn" aria-hidden="true"></span>Repo Git chưa có commit: Sửa code cần ít nhất một commit }
            @default { <span class="status-dot" data-status="warn" aria-hidden="true"></span>Không phải repo Git: chỉ dùng được Chỉ hỏi }
          }
        </p>
      </header>
      <tg-composer />
      <div class="suggest">
        @for (s of suggestions; track s.label) {
          <button class="pill-btn" (click)="chat.prompt.set(s.prompt)">{{ s.label }}</button>
        }
      </div>
    }
    <section class="home-agents" aria-label="Agent trên máy" [hidden]="!!chat.pending()">
      @if (ready().length) {
        <p class="home-agents-line dim">
          <span class="status-dot" data-status="ok" aria-hidden="true"></span>{{ ready().length }} agent sẵn sàng · {{ readyNames() }}
        </p>
      } @else if (!problems().length) {
        <p class="home-agents-line dim">{{ chat.agents.checking() ? 'Đang dò agent…' : 'Chưa thấy agent nào' }}</p>
      }
      @for (a of problems(); track a.id) {
        <div class="home-agent">
          <tg-agent-avatar [agent]="a.id" [size]="20" />
          <span>{{ a.name }}</span>
          @if (a.version) { <span class="dim mono ellipsis">{{ a.version }}</span> }
          <span class="spacer"></span>
          @if (!a.path) {
            <span class="dim">chưa cài</span>
            <button class="btn ghost sm" [title]="meta[a.id].install" (click)="copy(meta[a.id].install)">Chép lệnh cài</button>
          } @else {
            <span class="pill" data-status="needs_you">Cần đăng nhập</span>
          }
        </div>
      }
    </section>
  </div>
</div>
  `,
})
export class ChatHome {
  protected readonly chat = inject(ChatState);
  protected readonly meta = AGENT_META;
  protected readonly suggestions = [
    { label: 'Giải thích dự án', prompt: 'Giải thích cấu trúc thư mục này trong 5 gạch đầu dòng.' },
    { label: 'Tìm lỗi tiềm ẩn', prompt: 'Đọc code và liệt kê 5 lỗi tiềm ẩn đáng sửa nhất, kèm vị trí tệp.' },
    { label: 'Viết test còn thiếu', prompt: 'Tìm phần code quan trọng chưa có test và viết test cho nó.' },
  ];
  /** Installed and signed in (or sign-in unknown): summed up in one line. */
  protected readonly ready = computed(() => this.chat.agents.agents().filter((a) => a.path && a.auth !== 'none'));
  protected readonly readyNames = computed(() => this.ready().map((a) => a.name).join(', '));
  /** Missing or signed out: these get a row each, since they need the user. */
  protected readonly problems = computed(() => this.chat.agents.agents().filter((a) => !a.path || a.auth === 'none'));
  protected readonly projectName = computed(() => this.chat.workspace.project()?.name ?? this.chat.workspace.folder().split(/[\\/]/).filter(Boolean).at(-1) ?? '');

  protected async copy(text: string): Promise<void> {
    await copyText(text); // if it fails, the command is still in the tooltip
  }
}
