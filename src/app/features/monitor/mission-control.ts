import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { fmtTokens, fmtUsd } from '../../shared/utils/format';
import { RunsService } from '../../services/runs/runs.service';
import { Run } from '../../services/runs/run';
import { ConsoleView } from '../../services/app/ui.service';

interface QueueItem {
  key: string;
  kind: 'approve' | 'review' | 'commit';
  run: Run;
  detail: string;
  view: ConsoleView;
}

/** The previous monitor's session KPIs, kept as one compact row on the board. */
@Component({
  selector: 'tg-mission-control',
  template: `
    @if (stats().length) {
      <dl class="ab-stats" aria-label="Tổng quan phiên">
        @for (s of stats(); track s.label) {
          <div [class.ab-attention]="s.attention"><dt>{{ s.label }}</dt><dd>{{ s.value }}</dd></div>
        }
      </dl>
    }
  `,
})
export class MissionControl {
  protected readonly runs = inject(RunsService);
  private readonly pending = signal<Record<string, number>>({});
  protected readonly waiting = computed(() => this.runs.sessionRuns().reduce((n, r) => n + r.permissions.length, 0));
  protected readonly reviewCount = computed(() => this.queue().filter(q => q.kind === 'review').length);
  protected readonly stats = computed(() => {
    const t = this.runs.totals();
    return [
      { label: 'Đang chạy', n: this.runs.running().length, value: String(this.runs.running().length), attention: false },
      { label: 'Chờ duyệt', n: this.waiting(), value: String(this.waiting()), attention: true },
      { label: 'Chờ xem', n: this.reviewCount(), value: String(this.reviewCount()), attention: false },
      { label: 'Lượt chạy', n: this.runs.sessionRuns().length, value: String(this.runs.sessionRuns().length), attention: false },
      { label: 'Token', n: t.tokens, value: fmtTokens(t.tokens), attention: false },
      { label: 'Chi phí', n: t.costUsd ?? 0, value: fmtUsd(t.costUsd), attention: false },
    ].filter(s => s.n > 0);
  });
  protected readonly queue = computed<QueueItem[]>(() => {
    const items: QueueItem[] = [];
    const session = this.runs.sessionRuns();
    for (const r of session) {
      if (r.permissions.length) {
        const title = r.permissions[0].toolCall.title ?? 'công cụ';
        items.push({ key: `a:${r.id}`, kind: 'approve', run: r, detail: title, view: 'log' });
      }
    }
    const choices = this.runs.choices();
    const chosen = new Set(Object.values(choices).map((c) => c.runId));
    for (const r of [...session].sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))) {
      const files = this.pending()[r.id] ?? 0;
      const decided = r.group && choices[r.group];
      if (files > 0 && !decided && r.status !== 'running') {
        items.push({ key: `r:${r.id}`, kind: 'review', run: r, detail: `${files} tệp`, view: r.group ? 'compare' : 'changes' });
      }
    }
    for (const [group, choice] of Object.entries(choices)) {
      // A composite has no run of its own: show it under the group's first run.
      const run = session.find((r) => (choice.runId ? r.id === choice.runId : r.group === group));
      if (run && !choice.commit) {
        const what = choice.compositeId ? 'bản ghép' : 'đã áp dụng';
        items.push({ key: `c:${group}`, kind: 'commit', run, detail: `${choice.files} tệp ${what}`, view: 'compare' });
      }
    }
    // A parallel group needs one review, not one per agent.
    const seen = new Set<string>();
    return items.filter((q) => {
      if (q.kind !== 'review' || !q.run.group) return true;
      if (seen.has(q.run.group) || chosen.has(q.run.id)) return false;
      seen.add(q.run.group);
      const ready = items.filter((i) => i.kind === 'review' && i.run.group === q.run.group).length;
      q.detail = `${ready} bản để so sánh`;
      return true;
    });
  });

  constructor() {
    effect(() => {
      const key = this.runs.sessionRuns().map(r => `${r.id}:${r.status}:${r.task}`).join();
      this.runs.choices();
      untracked(() => void this.loadPending(key));
    });
  }

  private loads = 0;

  private async loadPending(_key: string): Promise<void> {
    const ticket = ++this.loads;
    const done = this.runs.sessionRuns().filter((r) => r.task && r.status !== 'running');
    const counts = await Promise.all(done.map(async (r) => {
      try {
        return [r.id, (await this.runs.getDiff(r.id)).length] as const;
      } catch {
        return [r.id, 0] as const;
      }
    }));
    if (ticket === this.loads) this.pending.set(Object.fromEntries(counts));
  }
}
