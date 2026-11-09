import { Component, inject } from '@angular/core';
import { computed } from '@angular/core';
import { AgentAvatar } from '../shared/agent-avatar';
import { AGENT_META } from '../agents/agent-meta';
import { copyText } from '../shared/clipboard';
import { Composer } from './composer';
import { PendingMessage } from './pending-message';
import { ChatState } from './chat.state';

/** The start screen: open a folder, then ask; the agents found on this machine. */
@Component({
  selector: 'tg-chat-home',
  imports: [AgentAvatar, Composer, PendingMessage],
  template: `
<div class="chat-scroll home">
  <div class="home-col">
    @if (!chat.workspace.folder()) {
      <div class="hero">
        <span class="brand-mark big" aria-hidden="true">TG</span>
        <h1>Chào mừng đến TG Studio</h1>
        <p class="dim">Điều khiển các agent code đã cài trên máy bạn, trong một cửa sổ.</p>
        <button class="btn primary lg" (click)="chat.workspace.pickFolder()">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          Mở thư mục dự án…
        </button>
      </div>
    } @else if (chat.pending()) {
      <div class="pending-col"><tg-pending-message /></div>
      <tg-composer />
    } @else {
      <div class="hero">
        <h1>Hôm nay làm gì với {{ projectName() }}?</h1>
        <p class="dim">
          @switch (chat.workspace.project()?.git) {
            @case ('ready') { <span class="ok-text">●</span> Repo Git · nhánh {{ chat.workspace.project()!.branch ?? 'HEAD tách rời' }} }
            @case ('no_commits') { <span class="warn-text">●</span> Repo Git chưa có commit: Sửa code cần ít nhất một commit }
            @default { <span class="warn-text">●</span> Không phải repo Git: chỉ dùng được Chỉ hỏi }
          }
        </p>
      </div>
      <tg-composer />
      <div class="suggest">
        @for (s of suggestions; track s.label) {
          <button class="pill-btn" (click)="chat.prompt.set(s.prompt)">{{ s.label }}</button>
        }
      </div>
    }
    <section class="agent-list" aria-label="Agent trên máy" [hidden]="!!chat.pending()">
      <div class="label">AGENT TRÊN MÁY</div>
      @for (a of chat.agents.agents(); track a.id) {
        <div class="agent-line">
          <tg-agent-avatar [agent]="a.id" [size]="26" />
          <strong>{{ a.name }}</strong>
          @if (a.version) { <span class="dim mono ellipsis">{{ a.version }}</span> }
          <span class="spacer"></span>
          @if (!a.path) {
            <button class="btn ghost sm" [title]="meta[a.id].install" (click)="copy(meta[a.id].install)">Chép lệnh cài</button>
          } @else if (a.auth === 'none') {
            <span class="pill" data-status="needs_you">Cần đăng nhập</span>
          } @else {
            <span class="pill" data-status="waiting">✓ Sẵn sàng</span>
          }
        </div>
      } @empty {
        <p class="dim">{{ chat.agents.checking() ? 'Đang dò agent…' : 'Chưa thấy agent nào.' }}</p>
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
  protected readonly projectName = computed(() => this.chat.workspace.project()?.name ?? this.chat.workspace.folder().split(/[\\/]/).filter(Boolean).at(-1) ?? '');

  protected async copy(text: string): Promise<void> {
    await copyText(text); // if it fails, the command is still in the tooltip
  }
}
