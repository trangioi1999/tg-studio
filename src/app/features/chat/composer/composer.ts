import { Component, inject } from '@angular/core';
import { ElementRef, effect, viewChild } from '@angular/core';
import { AgentMenu } from './agent-menu';
import { CommandMenu } from './command-menu';
import { GitSetup } from './git-setup';
import { PermMenu } from './perm-menu';
import { PipelineSteps } from './pipeline-steps';
import { PlaceMenu } from './place-menu';
import { ChatState } from '../chat.state';

/** The box that hands out work, with who works, what it may do and where. */
@Component({
  selector: 'tg-composer',
  imports: [AgentMenu, CommandMenu, GitSetup, PermMenu, PipelineSteps, PlaceMenu],
  template: `
<section class="cmp" [class.big]="!chat.run()" [class.dropping]="chat.dragging()" aria-label="Giao việc"
  (dragover)="chat.onDragOver($event)" (dragleave)="chat.dragging.set(false)" (drop)="chat.onDrop($event)">
  @if (chat.scopeShown(); as scope) {
    <div class="cmp-scope dim">Trong thư mục <code>{{ scope }}/</code>
      @if (!chat.run()) { <button class="link" (click)="chat.threads.draftScope.set(null)">Bỏ</button> }
    </div>
  }
  <tg-command-menu />
  @if (chat.attachments().length) {
    <ul class="cmp-attach" aria-label="Tệp đính kèm">
      @for (a of chat.attachments(); track a.id) {
        <li class="attach-item" [class.image]="a.image" [title]="a.name">
          @if (a.url) { <img [src]="a.url" [alt]="a.name" /> }
          @else { <span class="attach-name"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>{{ a.name }}</span> }
          <button class="attach-x" [attr.aria-label]="'Bỏ ' + a.name" title="Bỏ" (click)="chat.removeAttachment(a.id)">×</button>
        </li>
      }
    </ul>
  }
  <label class="sr-only" for="prompt">Yêu cầu cho agent</label>
  <textarea id="prompt" #box [rows]="chat.run() ? 2 : 3" [placeholder]="chat.placeholder()"
    [value]="chat.prompt()" (input)="chat.onInput($any($event.target))"
    (click)="chat.caret.set($any($event.target).selectionStart)" (keyup)="chat.onKeyUp($any($event))"
    [attr.aria-controls]="chat.cmdMenu() ? 'cmd-list' : null" [attr.aria-expanded]="!!chat.cmdMenu()"
    (keydown)="chat.onKeyDown($any($event))" (paste)="chat.onPaste($event)"></textarea>
  @if (chat.resumeChoice(); as rc) {
    <div class="cmp-resume" role="radiogroup" aria-label="Phiên trước đã đóng, gửi tin này bằng">
      <span class="dim">Phiên trước đã đóng ({{ rc.turns }} lượt):</span>
      <button role="radio" class="lg-chip" [class.active]="chat.resumeMode() === 'resume'" [attr.aria-checked]="chat.resumeMode() === 'resume'"
        title="Agent nhớ đủ mọi thứ, nhưng tin đầu phải đọc lại cả cuộc trò chuyện (kể cả tệp đã đọc, kết quả lệnh): càng dài càng tốn token."
        (click)="chat.resumePick.set('resume')">Tiếp tục phiên cũ</button>
      <button role="radio" class="lg-chip" [class.active]="chat.resumeMode() === 'fresh'" [attr.aria-checked]="chat.resumeMode() === 'fresh'"
        title="Mở phiên mới, chỉ gửi kèm bản tóm tắt cuộc trò chuyện: ít token hơn nhiều, nhưng agent không nhớ chi tiết và có thể phải đọc lại tệp."
        (click)="chat.resumePick.set('fresh')">Bắt đầu mới kèm tóm tắt · ~{{ rc.recapTokens }} token</button>
    </div>
  }
  <div class="cmp-bar">
    <input #picker type="file" multiple hidden (change)="pick(picker)" />
    <button class="chip-btn icon-only" aria-label="Đính kèm tệp hoặc ảnh" title="Đính kèm tệp hoặc ảnh (hoặc dán, kéo thả vào đây)" (click)="picker.click()"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg></button>
    <tg-agent-menu />
    <tg-perm-menu />
    @if (chat.perm() !== 'read' && !chat.run()?.task) {
      <tg-place-menu />
    }
    @if (chat.team() === 'pipeline') {
      <button class="chip-btn" [attr.aria-expanded]="chat.editSteps()" (click)="chat.editSteps.set(!chat.editSteps())">{{ chat.editSteps() ? 'Xong' : 'Sửa mẫu' }}</button>
    }
    <span class="spacer"></span>
    @if (chat.run()?.status === 'running') {
      <button class="send" aria-label="Dừng agent" title="Dừng" (click)="chat.runs.stop(chat.run()!.id)"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>
    } @else {
      <button class="send" aria-label="Gửi" [disabled]="!chat.canRun()" [title]="chat.blocked() ?? 'Gửi (Enter)'" (click)="chat.send()"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
    }
  </div>
</section>
@if (chat.team() === 'pipeline') {
  <tg-pipeline-steps />
}
<tg-git-setup />
@if (chat.dirtyWarning(); as n) {
  <div class="cmp-card warn" role="alert">
    <span>Bạn có {{ n }} tệp chưa commit. Bản nháp bắt đầu từ commit mới nhất nên agent sẽ không thấy chúng.</span>
    <span class="permission-actions">
      <button class="btn ghost sm" (click)="chat.dirtyWarning.set(null)">Hủy</button>
      <button class="btn primary sm" (click)="chat.sendAnyway()">Tiếp tục</button>
    </span>
  </div>
}
@if (chat.perm() === 'auto' && (chat.run()?.task ? chat.run()?.place === 'direct' : chat.effectivePlace() === 'direct')) {
  <p class="cmp-hint warn-text">Tự động + Thư mục hiện tại: agent sửa thẳng code của bạn mà không hỏi. Hoàn tác được theo tệp ở tab Thay đổi.</p>
}
@if (chat.blocked(); as b) { @if (chat.prompt().trim() || chat.run()?.status !== 'running') { <p class="dim cmp-hint">{{ b }}</p> } }
@else if (chat.loginHint(); as h) { <p class="cmp-hint warn-text">{{ h }}</p> }
@if (chat.error()) { <p class="error-text cmp-hint">{{ chat.error() }}</p> }
  `,
})
export class Composer {
  protected readonly chat = inject(ChatState);
  private readonly box = viewChild<ElementRef<HTMLTextAreaElement>>('box');
  /** A picked command moves the caret in this box. */
  private readonly shareBox = effect(() => {
    this.chat.box = this.box()?.nativeElement ?? null;
  });

  protected pick(input: HTMLInputElement): void {
    void this.chat.addFiles(Array.from(input.files ?? []));
    input.value = '';
  }
}
