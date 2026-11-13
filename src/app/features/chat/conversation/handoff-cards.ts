import { Component, inject } from '@angular/core';
import { computed, signal } from '@angular/core';
import { AgentId } from '../../../core/protocol';
import { Handoff } from '../../../services/runs/run';
import { AgentAvatar } from '../../../shared/ui/agent-avatar';
import { AGENT_META } from '../../../services/agents/agent-meta';
import { errorText } from '../../../shared/utils/errors';
import { ChatState } from '../chat.state';

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
      <button class="btn ghost sm" [disabled]="handoffBusy() || !hasAgent(h.agent)" [title]="hasAgent(h.agent) ? 'Cuộc trò chuyện chuyển hẳn sang ' + meta[h.agent].name : 'Agent này chưa cài'" (click)="acceptHandoff(h.id)">Chuyển hẳn sang {{ meta[h.agent].name }}</button>
      <button class="btn primary sm" [disabled]="handoffBusy() || !hasAgent(h.agent) || !!delegateBlocked(h)" [title]="delegateBlocked(h) ?? (meta[h.from].name + ' vẫn điều phối; ' + meta[h.agent].name + ' chạy như agent con, xong thì kết quả gộp về')" (click)="delegate(h)">Để {{ meta[h.from].name }} giao cho {{ meta[h.agent].name }}</button>
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

  /** Why the proposer cannot take the task back to delegate it, if it cannot. */
  protected delegateBlocked(h: Handoff): string | null {
    if (!this.hasAgent(h.agent)) return 'Agent này chưa cài';
    const source = this.chat.runs.runs().find((r) => r.id === h.runId);
    if (!source?.task || source.status === 'done' || source.status === 'failed' || source.status === 'stopped' || source.status === 'interrupted') return `Phiên của ${this.meta[h.from].name} đã đóng; chỉ chuyển hẳn được`;
    if (source.status === 'running') return `Chờ ${this.meta[h.from].name} xong lượt này`;
    return null;
  }

  /** The proposer gets the task back with the instruction to delegate it: it stays in charge. */
  protected async delegate(h: Handoff): Promise<void> {
    this.handoffBusy.set(true);
    this.chat.error.set(null);
    try {
      await this.chat.runs.sendMessage(h.runId, delegateMessage(h));
      this.chat.runs.dismissHandoff(h.id);
    } catch (e) {
      this.chat.error.set(errorText(e));
    } finally {
      this.handoffBusy.set(false);
    }
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

/** What the proposer is told when the user wants the task delegated, not the chat moved. */
export function delegateMessage(h: Handoff): string {
  const files = h.files.length ? `\nTệp liên quan: ${h.files.join(', ')}` : '';
  return `Đừng chuyển cuộc trò chuyện. Dùng tool delegate của tg-bridge giao việc này cho ${AGENT_META[h.agent].name} (agent: "${h.agent}"), đợi bằng wait_delegated rồi báo lại kết quả cho tôi:\n\n${h.task}${files}`;
}
