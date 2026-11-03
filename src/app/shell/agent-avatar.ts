import { Component, computed, input } from '@angular/core';
import { AGENT_META, AgentId } from '../core/protocol';

@Component({
  selector: 'tg-agent-avatar',
  template: `<span class="avatar" [style.background]="meta().color" [style.width.px]="size()" [style.height.px]="size()" [attr.title]="meta().name">{{ meta().mono }}</span>`,
})
export class AgentAvatar {
  readonly agent = input.required<AgentId>();
  readonly size = input(18);
  protected readonly meta = computed(() => AGENT_META[this.agent()]);
}
