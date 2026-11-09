import { Component, inject } from '@angular/core';
import { computed } from '@angular/core';
import { AgentAvatar } from '../shared/agent-avatar';
import { AGENT_META } from '../agents/agent-meta';
import { turnStart, Run } from '../runs/run';
import { fmtDuration } from '../shared/format';
import { segmentsOf } from './timeline';
import { ChatState } from './chat.state';

/** What the selected run is doing right now, with its clock and a stop button. */
@Component({
  selector: 'tg-live-status',
  imports: [AgentAvatar],
  template: `
@if (live(); as l) {
  <div class="live-status" role="status" [class.waiting]="l.waiting">
    <tg-agent-avatar [agent]="l.run.agent" [size]="20" />
    <strong>{{ meta[l.run.agent].name }} {{ l.verb }}</strong>
    @if (!l.waiting) { <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> }
    <span class="sep">·</span><span class="mono clock">{{ duration(l.run) }}</span>
    <span class="sep">·</span><span class="ellipsis step" [title]="l.step">{{ l.step }}</span>
    <button class="act-btn bordered" [title]="'Dừng (Esc)'" (click)="chat.runs.stop(l.run.id)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>Dừng<span class="kbd">Esc</span>
    </button>
  </div>
}
  `,
})
export class LiveStatus {
  protected readonly chat = inject(ChatState);
  protected readonly meta = AGENT_META;
  protected readonly live = computed(() => {
    const r = this.chat.run();
    if (!r || r.status !== 'running') return null;
    const last = segmentsOf(r.lines, true).at(-1);
    const waiting = r.permissions.length > 0;
    let step = 'đang suy nghĩ…';
    if (waiting) step = `chờ bạn duyệt: ${r.permissions[0].toolCall.title ?? 'một thao tác'}`;
    else if (r.progress) step = r.progress.step;
    else if (last?.kind === 'work') step = last.steps.at(-1)?.text ?? step;
    else if (last?.kind === 'text') step = 'đang viết câu trả lời…';
    return { run: r, waiting, step, verb: waiting ? 'đang chờ bạn' : r.task && r.perm !== 'read' ? 'đang làm' : 'đang trả lời' };
  });

  protected duration(r: Run): string {
    return fmtDuration(Math.max(0, (r.endedAt ?? this.chat.runs.now()) - turnStart(r)));
  }
}
