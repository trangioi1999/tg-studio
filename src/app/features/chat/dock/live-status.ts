import { Component, inject } from '@angular/core';
import { computed } from '@angular/core';
import { LiveTokens } from '../../../core/protocol';
import { turnStart, Run } from '../../../services/runs/run';
import { fmtDuration, fmtTokens } from '../../../shared/utils/format';
import { segmentsOf } from '../conversation/timeline';
import { ChatState } from '../chat.state';

/** What the selected run is doing right now, as the strip on top of the composer block. */
@Component({
  selector: 'tg-live-status',
  imports: [],
  template: `
@if (live(); as l) {
  <div class="cx-tray mono" role="status">
    <span class="cx-mark" aria-hidden="true">✻</span>
    <span class="ellipsis step" [title]="l.step">{{ l.step }}</span>
    <span class="dim clock">{{ duration(l.run) }}@if (l.run.live; as t) { · {{ tokens(t) }} }</span>
    <span class="grow"></span>
    <span class="dim esc">Esc để dừng</span>
  </div>
}
  `,
})
export class LiveStatus {
  protected readonly chat = inject(ChatState);
  protected readonly live = computed(() => {
    const r = this.chat.run();
    // While an approval card is up it says what is waiting; a second line would repeat it.
    if (!r || r.status !== 'running' || r.permissions.length) return null;
    const last = segmentsOf(r.lines, true).at(-1);
    let step = 'đang suy nghĩ…';
    if (r.progress) step = r.progress.step;
    else if (last?.kind === 'work') step = last.steps.at(-1)?.text ?? step;
    else if (last?.kind === 'text') step = 'đang viết câu trả lời…';
    return { run: r, step };
  });

  /** `~` marks a count the core estimated from the text; the input side is unknown for ACP agents. */
  protected tokens(t: LiveTokens): string {
    const mark = t.estimated ? '~' : '';
    return `${t.inputTokens === null ? '' : `↑ ${mark}${fmtTokens(t.inputTokens)} · `}↓ ${mark}${fmtTokens(t.outputTokens)} token`;
  }

  protected duration(r: Run): string {
    return fmtDuration(Math.max(0, (r.endedAt ?? this.chat.runs.now()) - turnStart(r)));
  }
}
