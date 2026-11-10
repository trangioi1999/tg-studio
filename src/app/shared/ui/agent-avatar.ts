import { Component, computed, input } from '@angular/core';
import { AgentId } from '../../core/protocol';
import { AGENT_META } from '../../services/agents/agent-meta';

/** The agent's own logo on a neutral tile, so every agent reads the same way at a glance. */
@Component({
  selector: 'tg-agent-avatar',
  template: `<span class="avatar" [style.width.px]="size()" [style.height.px]="size()" [style.border-radius.px]="radius()" [attr.title]="meta().name"><img [src]="'agents/' + agent() + '.svg'" [alt]="meta().name" [style.width.px]="logo()" [style.height.px]="logo()" /></span>`,
})
export class AgentAvatar {
  readonly agent = input.required<AgentId>();
  readonly size = input(18);
  protected readonly meta = computed(() => AGENT_META[this.agent()]);
  protected readonly logo = computed(() => Math.round(this.size() * 0.72));
  protected readonly radius = computed(() => Math.max(4, Math.round(this.size() * 0.28)));
}
