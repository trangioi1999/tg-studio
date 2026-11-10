import { Component, inject } from '@angular/core';
import { ChatState } from '../chat.state';

/** Where a new code task works: the user's folder, or a draft from a branch. */
@Component({
  selector: 'tg-place-menu',
  imports: [],
  host: { class: 'pop-anchor' },
  template: `
      <button class="chip-btn" [class.open]="chat.menu() === 'place'" aria-haspopup="true" [attr.aria-expanded]="chat.menu() === 'place'" [disabled]="chat.team() === 'parallel'" [title]="chat.team() === 'parallel' ? 'Nhiều agent luôn làm trong bản nháp riêng' : 'Agent làm ở đâu'" (click)="chat.toggleMenu('place')">
        @if (chat.effectivePlace() === 'direct') { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>Thư mục hiện tại }
        @else { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/></svg>Bản nháp<span class="dim">· {{ chat.base() ?? chat.workspace.repo()?.branch ?? 'HEAD' }}</span> }
        <svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      @if (chat.menu() === 'place') {
        <div class="pop place-pop" role="listbox" aria-label="Agent làm ở đâu" (keydown.escape)="chat.menu.set(null)">
          <button role="option" class="opt tall" [class.on]="chat.place() === 'direct'" [attr.aria-selected]="chat.place() === 'direct'" (click)="chat.setPlace('direct')">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
            <span class="grow"><strong>Thư mục hiện tại</strong><span class="opt-desc">Agent sửa thẳng code của bạn, thấy cả phần bạn đang sửa dở. Tab Thay đổi chỉ hiện phần agent sửa; commit hoặc hoàn tác theo tệp.</span></span>
            @if (chat.place() === 'direct') { <span aria-hidden="true">✓</span> }
          </button>
          <div class="pop-title">Bản nháp riêng từ nhánh</div>
          @for (b of chat.branches(); track b) {
            <button role="option" class="opt" [class.on]="chat.place() === 'draft' && (chat.base() ?? chat.workspace.repo()?.branch) === b" (click)="chat.setPlace('draft', b)">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/></svg><span class="grow mono ellipsis">{{ b }}</span>
              @if (b === chat.workspace.repo()?.branch) { <span class="dim">đang mở</span> }
            </button>
          } @empty {
            <button role="option" class="opt" [class.on]="chat.place() === 'draft'" (click)="chat.setPlace('draft')"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/></svg><span class="grow">Từ commit đang mở (HEAD)</span></button>
          }
          <p class="pop-note">Bản nháp là bản sao riêng của repo: code thật chỉ đổi khi bạn bấm Nhận. Agent chỉ thấy code đã commit.</p>
        </div>
      }
  `,
})
export class PlaceMenu {
  protected readonly chat = inject(ChatState);
}
