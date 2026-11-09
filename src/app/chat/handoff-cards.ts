import { Component, inject } from '@angular/core';
import { computed, signal } from '@angular/core';
import { AgentId } from '../core/protocol';
import { AgentAvatar } from '../shared/agent-avatar';
import { AGENT_META } from '../agents/agent-meta';
import { errorText } from '../shared/errors';
import { ChatState } from './chat.state';

/** Work an agent proposed to hand over to another agent (tg-bridge handoff_to). */
@Component({
  selector: 'tg-handoff-cards',
  imports: [AgentAvatar],
  template: `
@for (h of taskHandoffs(); track h.id) {
  <section class="handoff" aria-label="Đề xuất chuyển việc">
    <div class="handoff-head"><tg-agent-avatar [agent]="h.from" [size]="18" /> {{ meta[h.from].name }} đề xuất chuyển cho <tg-agent-avatar [agent]="h.agent" [size]="18" /> <strong>{{ meta[h.agent].name }}</strong></div>
    <p>{{ h.task }}</p>
    @if (h.files.length) { <p class="mono dim">{{ h.files.join(', ') }}</p> }
    <div class="permission-actions">
      <button class="btn ghost sm" (click)="chat.runs.dismissHandoff(h.id)">Bỏ qua</button>
      <button class="btn primary sm" [disabled]="handoffBusy() || !hasAgent(h.agent)" [title]="hasAgent(h.agent) ? '' : 'Agent này chưa cài'" (click)="acceptHandoff(h.id)">Giao cho {{ meta[h.agent].name }}</button>
    </div>
  </section>
}
  `,
})
export class HandoffCards {
  protected readonly chat = inject(ChatState);
  protected readonly meta = AGENT_META;
  protected readonly taskHandoffs = computed(() => {
    const ids = new Set(this.chat.taskRuns().map((r) => r.id));
    return this.chat.runs.handoffs().filter((h) => ids.has(h.runId));
  });
  protected readonly handoffBusy = signal(false);

  protected hasAgent(id: AgentId): boolean {
    return this.chat.agents.agents().some((a) => a.id === id && a.path);
  }

  protected async acceptHandoff(id: string): Promise<void> {
    const repo = this.chat.workspace.repo()?.root ?? this.chat.run()?.cwd ?? '';
    this.handoffBusy.set(true);
    this.chat.error.set(null);
    try {
      await this.chat.runs.acceptHandoff(id, repo);
    } catch (e) {
      this.chat.error.set(errorText(e));
    } finally {
      this.handoffBusy.set(false);
    }
  }
}
