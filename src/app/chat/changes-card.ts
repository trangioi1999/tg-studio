import { Component, inject } from '@angular/core';
import { input } from '@angular/core';
import { Run } from '../runs/run';
import { computed } from '@angular/core';
import { UiService } from '../shell/ui.service';
import { ChatState } from './chat.state';
import { diffStats } from '../shared/diff-stats';

/** What this conversation's agent changed, waiting on the user. */
@Component({
  selector: 'tg-changes-card',
  imports: [],
  template: `
@let r = run();
@if (changed(); as c) {
  <section class="changes-card" aria-label="Thay đổi của agent">
    <header>
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/></svg>
      <strong>{{ c.files }} tệp đã đổi</strong><span class="ok-text mono">+{{ c.added }}</span><span class="err-text mono">−{{ c.removed }}</span>
      <span class="spacer"></span><span class="dim">{{ r.place === 'direct' ? 'đã ở trong code của bạn · hoàn tác được' : 'trong bản nháp · code thật chưa đổi' }}</span>
    </header>
    <ul>
      @for (f of c.list.slice(0, 5); track f.path) {
        <li class="mono"><span class="file-status" [attr.data-status]="f.status">{{ f.status }}</span><span class="ellipsis grow">{{ f.path }}</span></li>
      }
      @if (c.list.length > 5) { <li class="dim">và {{ c.list.length - 5 }} tệp khác</li> }
    </ul>
    <footer><button class="btn primary sm" (click)="review(r.id)">Xem thay đổi</button></footer>
  </section>
}
  `,
})
export class ChangesCard {
  protected readonly chat = inject(ChatState);
  readonly run = input.required<Run>();
  private readonly ui = inject(UiService);
  protected readonly changed = computed(() => {
    const r = this.run();
    if (!r.task || r.perm === 'read' || r.status === 'running') return null;
    const files = this.chat.workspace.diffs()[r.id] ?? [];
    if (!files.length) return null;
    return { files: files.length, list: files, ...diffStats(files) };
  });

  protected review(runId: string): void {
    this.ui.openRun(runId, 'changes');
  }
}
