import { Component, inject } from '@angular/core';
import { AgentAvatar } from '../../shared/agent-avatar';
import { ChatState } from '../chat.state';

/** The agent and prompt template of each pipeline step, remembered for the next task. */
@Component({
  selector: 'tg-pipeline-steps',
  imports: [AgentAvatar],
  template: `
  <ol class="pipe-steps" aria-label="Các bước">
    @for (s of chat.steps(); track $index; let i = $index) {
      <li>
        <div class="pipe-step">
          <span class="pipe-num">{{ i + 1 }}</span>
          <span class="pipe-name">{{ s.name }}</span>
          <tg-agent-avatar [agent]="s.agent" [size]="18" />
          <select [attr.aria-label]="'Agent cho bước ' + s.name" (change)="chat.setStep(i, { agent: $any($event.target).value })">
            @for (a of chat.choices(); track a.id) { <option [value]="a.id" [selected]="a.id === s.agent">{{ a.name }}</option> }
          </select>
        </div>
        @if (chat.editSteps()) {
          <textarea class="mono" rows="4" [attr.aria-label]="'Mẫu prompt bước ' + s.name" [value]="s.template" (input)="chat.setStep(i, { template: $any($event.target).value })"></textarea>
        }
      </li>
    }
  </ol>
  @if (chat.editSteps()) {
    <p class="dim cmp-hint"><code>{{ '{{task}}' }}</code> yêu cầu · <code>{{ '{{previous}}' }}</code> tin nhắn cuối của bước trước · <code>{{ '{{diff}}' }}</code> diff hiện tại. <button class="link" (click)="chat.resetSteps()">Khôi phục mặc định</button></p>
  }
  `,
})
export class PipelineSteps {
  protected readonly chat = inject(ChatState);
}
