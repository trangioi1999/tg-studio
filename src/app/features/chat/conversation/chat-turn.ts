import { Component, inject } from '@angular/core';
import { input } from '@angular/core';
import { Run } from '../../../services/runs/run';
import { computed, signal } from '@angular/core';
import { AgentAvatar } from '../../../shared/ui/agent-avatar';
import { AGENT_META } from '../../../services/agents/agent-meta';
import { copyText } from '../../../shared/utils/clipboard';
import { fmtDuration, fmtUsd } from '../../../shared/utils/format';
import { Markdown, plainText } from '../../../shared/ui/markdown';
import { costOf } from '../../../services/usage/pricing';
import { turnStart } from '../../../services/runs/run';
import { Delegations } from './delegations';
import { UserMessage } from './user-message';
import { segmentsOf } from './timeline';
import { TurnStatus, turnStatus } from './turn-status';
import { ChatState } from '../chat.state';

/** One run of the conversation: the user's message, then what the agent said and did. */
@Component({
  selector: 'tg-chat-turn',
  imports: [AgentAvatar, Delegations, Markdown, UserMessage],
  template: `
@let tr = run();
<tg-user-message [text]="tr.prompt" />
<article class="turn">
  <header class="turn-who">
    <tg-agent-avatar [agent]="tr.agent" [size]="24" />
    <strong>{{ meta[tr.agent].name }}</strong>
    <span class="dim">{{ tr.model ? '· ' + tr.model + ' ' : '' }}· {{ permLabel(tr) }} · {{ duration(tr) }}@if (tr.credits; as c) { · <span [title]="creditsTitle(tr)">{{ fmtCredits(c.turn) }} credit</span> } @else if (costOf(tr) !== null) { · {{ usd(costOf(tr)) }} }</span>
    <span class="spacer"></span>
    <span class="pill" [attr.data-status]="turnStatus(tr)">
      @switch (turnStatus(tr)) {
        @case ('running') { <span class="spin" aria-hidden="true"></span> }
        @case ('needs_you') { <span aria-hidden="true">●</span> }
        @case ('failed') { <span aria-hidden="true">✕</span> }
        @case ('stopped') { <span aria-hidden="true">■</span> }
        @default { <span aria-hidden="true">✓</span> }
      }
      {{ turnLabel[turnStatus(tr)] }}
    </span>
  </header>
  @if (tr.progress; as p) {
    <div class="turn-progress" [attr.title]="p.note ?? ''">
      <span class="ellipsis">{{ p.step }}</span>
      @if (p.pct !== null) {
        <span class="meter" role="meter" aria-label="Tiến độ agent báo" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="p.pct"><span [style.width.%]="p.pct"></span></span>
        <span class="mono dim">{{ p.pct }}%</span>
      }
    </div>
  }
  @for (seg of segments(); track $index; let last = $last) {
    @switch (seg.kind) {
      @case ('user') { <tg-user-message [text]="seg.text" /> }
      @case ('text') { <tg-markdown [animate]="last && tr.status === 'running'" class="msg-agent" [class.typing]="last && tr.status === 'running'" [text]="seg.text" /> }
      @case ('work') {
        <details class="worklog" [open]="seg.live" [class.live]="seg.live">
          <summary>
            <svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
            @if (seg.live && tr.permissions.length) {
              <span class="wait-dot" aria-hidden="true">●</span><span class="ellipsis">Chờ bạn duyệt · {{ seg.steps.at(-1)?.text }}</span>
            } @else if (seg.live) {
              <span class="spin" aria-hidden="true"></span><span class="ellipsis">{{ seg.steps.at(-1)?.text }}</span>
            } @else {
              <span>Nhật ký làm việc · {{ seg.steps.length }} bước</span>
            }
            @if (seg.failed) { <span class="err-text">· {{ seg.failed }} lỗi</span> }
          </summary>
          <ol>
            @for (st of seg.steps; track $index) {
              <li [attr.data-state]="st.state">
                <span class="step-mark" aria-hidden="true">@switch (st.state) { @case ('done') { ✓ } @case ('failed') { ✕ } @case ('note') { ! } @default { <span class="spin"></span> } }</span>
                <span class="mono ellipsis" [title]="st.text">{{ st.text }}</span>
              </li>
            }
          </ol>
        </details>
      }
      @case ('delegate') { <tg-delegations [parent]="tr" [only]="seg.refs" /> }
    }
    @if (answers()[$index]; as answer) {
      <div class="answer-actions">
        <button class="act-btn" [class.done]="copied() === tr.id + ':' + $index + ':plain'" (click)="copyAnswer(tr.id, $index, answer, false)">
          @if (copied() === tr.id + ':' + $index + ':plain') { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>Đã chép } @else { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>Chép }
        </button>
        <button class="act-btn" [class.done]="copied() === tr.id + ':' + $index + ':md'" (click)="copyAnswer(tr.id, $index, answer, true)">
          @if (copied() === tr.id + ':' + $index + ':md') { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>Đã chép } @else { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>Chép Markdown }
        </button>
      </div>
    }
  }
  <tg-delegations [parent]="tr" [except]="placed()" />
  @if (turnStatus(tr) === 'failed') { <div class="turn-error" role="alert">{{ failureOf(tr) }}</div> }
</article>
  `,
})
export class ChatTurn {
  protected readonly chat = inject(ChatState);
  protected readonly meta = AGENT_META;
  readonly run = input.required<Run>();
  protected readonly usd = fmtUsd;
  protected readonly turnLabel: Record<TurnStatus, string> = { running: 'Đang làm', needs_you: 'Chờ duyệt', waiting: 'Xong', failed: 'Lỗi', stopped: 'Đã dừng' };
  protected readonly turnStatus = turnStatus;
  protected readonly segments = computed(() => segmentsOf(this.run().lines, this.run().status === 'running'));
  /** Delegations shown where they were made, so the block at the end of the run skips them. */
  protected readonly placed = computed(() => this.segments().flatMap((s) => (s.kind === 'delegate' ? s.refs : [])));
  /** Where each finished answer ends (the text since the last user message), by segment. */
  protected readonly answers = computed(() => {
    const segs = this.segments();
    const ends: Record<number, string> = {};
    let texts: string[] = [];
    segs.forEach((seg, i) => {
      if (seg.kind === 'user') texts = [];
      if (seg.kind !== 'text') return;
      texts.push(seg.text);
      const next = segs.slice(i + 1).find((x) => x.kind !== 'work' && x.kind !== 'delegate');
      const finished = next ? next.kind === 'user' : this.run().status !== 'running';
      if (finished && (!next || next.kind === 'user')) {
        ends[i] = texts.join('\n\n');
        texts = [];
      }
    });
    return ends;
  });
  protected readonly copied = signal<string | null>(null);

  protected async copyAnswer(runId: string, index: number, markdown: string, asMarkdown: boolean): Promise<void> {
    if (!(await copyText(asMarkdown ? markdown : plainText(markdown)))) return;
    const key = `${runId}:${index}:${asMarkdown ? 'md' : 'plain'}`;
    this.copied.set(key);
    setTimeout(() => this.copied() === key && this.copied.set(null), 1500);
  }

  protected permLabel(r: Run): string {
    if (!r.task || r.perm === 'read') return 'Chỉ hỏi';
    const where = r.place === 'direct' ? 'thư mục hiện tại' : 'bản nháp';
    return `${r.perm === 'auto' ? 'Tự động' : 'Sửa code'} · ${where}`;
  }

  protected failureOf(r: Run): string {
    const last = [...r.lines].reverse().find((l) => l.tone === 'error');
    return last?.text ?? 'Lượt chạy thất bại. Xem chi tiết ở Cài đặt → Chẩn đoán.';
  }

  protected fmtCredits(n: number): string {
    return n.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  }

  /** Kiro shows credits per answer; the session total and its rough USD stay in the tooltip. */
  protected creditsTitle(r: Run): string {
    const c = r.credits!;
    const usd = this.costOf(r);
    return `Credit ước tính của lượt này: ${this.fmtCredits(c.turn)}\nCả cuộc trò chuyện: ${this.fmtCredits(c.total)} credit${usd !== null ? ` (≈ ${this.usd(usd)})` : ''}`;
  }

  protected costOf(r: Run): number | null {
    return costOf(r.agent, r.usage, r.startedAt).usd;
  }

  protected duration(r: Run): string {
    return fmtDuration(Math.max(0, (r.endedAt ?? this.chat.runs.now()) - turnStart(r)));
  }
}
