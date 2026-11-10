import { Component, HostListener, computed, inject } from '@angular/core';
import { AGENT_META } from '../agents/agent-meta';
import { isQuiet } from '../runs/run';
import { AgentAvatar } from '../shared/agent-avatar';
import { Approvals } from './dock/approvals';
import { ChangesCard } from './conversation/changes-card';
import { ChatHome } from './home/chat-home';
import { ChatState } from './chat.state';
import { ChatTurn } from './conversation/chat-turn';
import { Composer } from './composer/composer';
import { HandoffCards } from './conversation/handoff-cards';
import { LiveStatus } from './dock/live-status';
import { PendingMessage } from './conversation/pending-message';
import { PipelineStepper } from './conversation/pipeline-stepper';
import { PlanTab } from './plan/plan-tab';
import { ProposalCard } from './dock/proposal-card';

/**
 * The middle of the window: the selected conversation (its turns, plan and notes), what is
 * pinned above the composer (approvals, a plan to carry out, what the agent does now), and
 * the composer. The parts share one ChatState.
 */
@Component({
  selector: 'tg-agent-panel',
  imports: [AgentAvatar, Approvals, ChangesCard, ChatHome, ChatTurn, Composer, HandoffCards, LiveStatus, PendingMessage, PipelineStepper, PlanTab, ProposalCard],
  providers: [ChatState],
  template: `
    @if (chat.menu()) { <div class="pop-backdrop" (click)="chat.menu.set(null)"></div> }

    @if (chat.run(); as r) {
      <div class="chat-tabs" role="tablist" aria-label="Nội dung cuộc trò chuyện">
        @for (t of panelTabs; track t.id) {
          <button role="tab" class="chat-tab" [class.active]="chat.tab() === t.id" [attr.aria-selected]="chat.tab() === t.id" (click)="chat.tab.set(t.id)">{{ t.label }}</button>
        }
      </div>
      <div class="chat-scroll">
        <div class="chat-col">
          @switch (chat.tab()) {
            @case ('thread') {
              <tg-pipeline-stepper />
              @if (chat.otherApprovals().length) {
                <div class="chat-notice">
                  @for (o of chat.otherApprovals(); track o.id) {
                    <button class="pill-btn" (click)="chat.runs.selectedId.set(o.id)"><tg-agent-avatar [agent]="o.agent" [size]="16" /> {{ meta[o.agent].name }} ở cuộc trò chuyện khác đang chờ duyệt</button>
                  }
                </div>
              }
              @for (tr of chat.threadRuns(); track tr.id) {
                <tg-chat-turn [run]="tr" />
              }
              @if (quiet()) {
                <div class="chat-notice" role="status">
                  <span>Agent chưa phản hồi 30 giây. Có thể vẫn đang xử lý.</span>
                  <button class="btn ghost sm" (click)="chat.runs.stop(r.id)">Dừng</button>
                </div>
              }
              <tg-changes-card [run]="r" />
              <tg-handoff-cards />
              <tg-pending-message />
            }
            @case ('plan') {
              <tg-plan-tab />
            }
          }
        </div>
      </div>
      <div class="chat-dock"><div class="dock-col">
        <!-- Pinned above the composer: an approval must never scroll out of sight. -->
        <tg-approvals />
        <tg-proposal-card />
        <tg-live-status />
        <tg-composer />
      </div></div>
    } @else {
      <tg-chat-home />
    }
  `,
})
export class AgentPanel {
  protected readonly chat = inject(ChatState);
  protected readonly meta = AGENT_META;
  protected readonly panelTabs = [{ id: 'thread', label: 'Trò chuyện' }, { id: 'plan', label: 'Kế hoạch & ghi chú' }] as const;
  protected readonly quiet = computed(() => {
    const r = this.chat.run();
    return !!r && isQuiet(r, this.chat.runs.lastEvent()[r.id], this.chat.runs.now());
  });

  /** Ctrl/⌘+Shift+M opens the agent and model picker; Esc closes a menu, or stops the agent. */
  @HostListener('window:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    const chat = this.chat;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      chat.toggleMenu('agent');
    } else if (e.key === 'Escape' && chat.menu()) {
      chat.menu.set(null);
    } else if (e.key === 'Escape' && chat.run()?.status === 'running' && !(e.target as HTMLElement | null)?.closest('input, .repo-edit')) {
      // Esc stops the agent, as the status line says.
      e.preventDefault();
      void chat.runs.stop(chat.run()!.id);
    }
  }
}
