import { Component, inject } from '@angular/core';
import { ChatState } from '../chat.state';

/** Skills and commands of the agent, offered after "/" (or "$" for Codex) in the composer. */
@Component({
  selector: 'tg-command-menu',
  imports: [],
  template: `
    @if (chat.cmdMenu(); as cm) {
      <div class="pop cmd-pop" role="listbox" id="cmd-list" aria-label="Skill và lệnh của agent">
        @if (cm.loading) {
          <p class="pop-note"><span class="spin"></span> Đang đọc skill của {{ cm.agent }}…</p>
        } @else {
          @for (g of cm.groups; track g.group) {
            <div class="cmd-group">{{ chat.groupLabel[g.group] }}</div>
            @for (c of g.items; track c.name) {
              <button role="option" class="cmd-opt" [class.on]="cm.active === c" [attr.aria-selected]="cm.active === c"
                (mousedown)="$event.preventDefault()" (click)="chat.pickCommand(c)">
                <span class="cmd-name mono">{{ c.insert.trim() }}</span>
                @if (c.hint) { <span class="cmd-hint mono">{{ c.hint }}</span> }
                <span class="cmd-desc ellipsis">{{ c.description }}</span>
              </button>
            }
          } @empty {
            <p class="pop-note">{{ cm.agent }} không có skill hay lệnh nào khớp "{{ cm.query }}".</p>
          }
        }
      </div>
    }
  `,
})
export class CommandMenu {
  protected readonly chat = inject(ChatState);
}
