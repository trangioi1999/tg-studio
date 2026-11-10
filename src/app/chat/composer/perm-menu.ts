import { Component, inject } from '@angular/core';
import { ChatState } from '../chat.state';

/** What the agent may do: answer only, edit asking first, or edit on its own. */
@Component({
  selector: 'tg-perm-menu',
  imports: [],
  host: { class: 'pop-anchor' },
  template: `
      <button class="chip-btn" [class.open]="chat.menu() === 'perm'" aria-haspopup="true" [attr.aria-expanded]="chat.menu() === 'perm'" title="Agent được phép làm gì" (click)="chat.toggleMenu('perm')">
        @switch (chat.perm()) {
          @case ('read') { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>Chỉ hỏi }
          @case ('auto') { <svg class="ic perm-auto" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>Tự động }
          @default { <svg class="ic perm-edit" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Hỏi trước }
        }
        <svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      @if (chat.menu() === 'perm') {
        <div class="pop perm-pop" role="listbox" aria-label="Quyền của agent" (keydown.escape)="chat.menu.set(null)">
          <button role="option" class="opt tall" [class.on]="chat.perm() === 'read'" [attr.aria-selected]="chat.perm() === 'read'" [disabled]="chat.team() !== 'single'" (click)="chat.setPerm('read')">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
            <span class="grow"><strong>Chỉ hỏi</strong><span class="opt-desc">Agent đọc code rồi trả lời, không sửa tệp nào. Dùng để hỏi, giải thích, lên kế hoạch.@if (chat.team() !== 'single') { Không dùng được khi giao cho nhiều agent hoặc theo các bước. }</span></span>
            @if (chat.perm() === 'read') { <span aria-hidden="true">✓</span> }
          </button>
          <button role="option" class="opt tall" [class.on]="chat.perm() === 'ask'" [attr.aria-selected]="chat.perm() === 'ask'" (click)="chat.setPerm('ask')">
            <svg class="ic perm-edit" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
            <span class="grow"><strong>Sửa code · hỏi trước <span class="dim">· cần repo Git</span></strong><span class="opt-desc">Agent sửa tệp và chạy lệnh. Lệnh nhạy cảm hiện thẻ duyệt để bạn cho phép hoặc từ chối.</span></span>
            @if (chat.perm() === 'ask') { <span aria-hidden="true">✓</span> }
          </button>
          <button role="option" class="opt tall" [class.on]="chat.perm() === 'auto'" [attr.aria-selected]="chat.perm() === 'auto'" (click)="chat.setPerm('auto')">
            <svg class="ic perm-auto" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>
            <span class="grow"><strong>Tự động <span class="dim">· cần repo Git</span></strong><span class="opt-desc">Agent tự sửa tệp và chạy lệnh, không xin phép. Lệnh bị cấm (git push, merge) vẫn bị chặn. Mọi việc vẫn ghi trong Nhật ký làm việc.</span></span>
            @if (chat.perm() === 'auto') { <span aria-hidden="true">✓</span> }
          </button>
        </div>
      }
  `,
})
export class PermMenu {
  protected readonly chat = inject(ChatState);
}
