import { Component, inject } from '@angular/core';
import { AgentAvatar } from '../../shared/agent-avatar';
import { AGENT_META } from '../../agents/agent-meta';
import { KEYS } from '../../shared/keys';
import { ChatState } from '../chat.state';

/** Who works: one agent and its model and effort, several agents to compare, or pipeline steps. */
@Component({
  selector: 'tg-agent-menu',
  imports: [AgentAvatar],
  host: { class: 'pop-anchor' },
  template: `
      <button class="chip-btn" [class.open]="chat.menu() === 'agent'" aria-haspopup="true" [attr.aria-expanded]="chat.menu() === 'agent'" [title]="'Chọn agent và model (' + keys.model + ')'" (click)="chat.toggleMenu('agent')">
        @switch (chat.team()) {
          @case ('parallel') {
            <span class="av-stack">@for (a of chat.picked(); track a) { <tg-agent-avatar [agent]="a" [size]="20" /> }</span>
            {{ chat.picked().length }} agent<span class="dim">· so sánh</span>
          }
          @case ('pipeline') {
            <span class="av-stack">@for (s of chat.steps(); track $index) { <tg-agent-avatar [agent]="s.agent" [size]="20" /> }</span>
            Theo các bước
          }
          @default {
            @if (chat.agent(); as a) {
              <tg-agent-avatar [agent]="a" [size]="20" />{{ meta[a].name }}
              @if (chat.agents.modelLabel(a); as m) { <span class="dim">· {{ m }}</span> }
            } @else { Chưa có agent }
          }
        }
        <svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      @if (chat.menu() === 'agent') {
        <div class="pop agent-pop" role="dialog" aria-label="Chọn agent và model" (keydown.escape)="chat.menu.set(null)">
          <div class="pop-col agents-col" role="listbox" aria-label="Agent">
            @for (a of chat.agents.agents(); track a.id) {
              <button role="option" class="opt" [class.on]="chat.team() === 'single' && chat.agent() === a.id" [attr.aria-selected]="chat.team() === 'single' && chat.agent() === a.id"
                [disabled]="!chat.usable(a.id)" (click)="chat.pickAgent(a.id)">
                <tg-agent-avatar [agent]="a.id" [size]="20" /><span class="ellipsis grow">{{ a.name }}</span>
                @if (!a.path) { <span class="dim">chưa cài</span> } @else { <span class="dim">›</span> }
              </button>
            }
            <hr />
            <button class="opt" [class.on]="chat.team() === 'parallel'" (click)="chat.setTeam('parallel')">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/><path d="M13 7h4a2 2 0 0 1 2 2v2M11 17H7a2 2 0 0 1-2-2v-2"/></svg>
              <span class="grow">Giao cho nhiều agent…</span>
            </button>
            <button class="opt" [class.on]="chat.team() === 'pipeline'" (click)="chat.setTeam('pipeline')">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h4M15 6h4M5 18h14M9 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0M12 9v6"/></svg>
              <span class="grow">Theo các bước…</span>
            </button>
          </div>
          <div class="pop-col detail-col">
            @switch (chat.team()) {
              @case ('parallel') {
                <p class="pop-note">Cùng một việc, mỗi agent làm một bản nháp riêng. Xong thì so sánh và chọn bản tốt nhất.</p>
                @for (a of chat.choices(); track a.id) {
                  <label class="opt" [class.on]="chat.picked().includes(a.id)">
                    <input type="checkbox" [checked]="chat.picked().includes(a.id)" (change)="chat.toggle(a.id)" />
                    <tg-agent-avatar [agent]="a.id" [size]="20" /><span class="grow">{{ a.name }}</span>
                    <span class="dim">{{ chat.agents.modelLabel(a.id) ?? 'mặc định' }}</span>
                  </label>
                }
              }
              @case ('pipeline') {
                <p class="pop-note">Các agent làm nối tiếp trong cùng một bản nháp: lên kế hoạch → viết code → review. Chọn agent cho từng bước ngay dưới ô chat.</p>
              }
              @default {
                @if (chat.agent(); as a) {
                  <div class="pop-title">Model của {{ meta[a].name }}</div>
                  @switch (chat.optionsState(a)) {
                    @case ('loading') { <p class="pop-note"><span class="spin"></span> Đang hỏi {{ meta[a].name }}…</p> }
                    @case ('error') {
                      <p class="pop-note">Không đọc được danh sách model. <button class="link" (click)="chat.retryOptions(a)">Thử lại</button></p>
                      @if (chat.agents.optionsError()[a]; as why) { <pre class="pop-error mono">{{ why }}</pre> }
                    }
                    @case ('none') { <p class="pop-note">{{ meta[a].name }} không cho chọn model ở đây; dùng cài đặt của CLI.</p> }
                    @default {
                      @for (o of chat.modelOptions(a); track o.value) {
                        <button class="opt" [class.on]="chat.currentModel(a) === o.value" (click)="chat.agents.setPref(a, { model: o.value, effort: null })">
                          <span class="grow">{{ o.name }}</span>
                          @if (o.description) { <span class="dim ellipsis">{{ o.description }}</span> }
                          @if (chat.currentModel(a) === o.value) { <span aria-hidden="true">✓</span> }
                        </button>
                      }
                      @if (chat.effortOptions(a).length) {
                        <hr />
                        <div class="effort-row">
                          <span class="dim">Mức suy nghĩ</span>
                          <div class="segbar" role="group" aria-label="Mức suy nghĩ">
                            @for (o of chat.effortOptions(a); track o.value) {
                              <button [class.on]="chat.currentEffort(a) === o.value" [attr.aria-pressed]="chat.currentEffort(a) === o.value" (click)="chat.agents.setPref(a, { effort: o.value })">{{ chat.effortLabel(o) }}</button>
                            }
                          </div>
                        </div>
                      }
                    }
                  }
                }
              }
            }
          </div>
        </div>
      }
  `,
})
export class AgentMenu {
  protected readonly chat = inject(ChatState);
  protected readonly meta = AGENT_META;
  protected readonly keys = KEYS;
}
