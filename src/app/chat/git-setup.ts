import { Component, inject } from '@angular/core';
import { ChatState } from './chat.state';

/** Makes a plain folder ready for code tasks: git init, a .gitignore and a first commit. */
@Component({
  selector: 'tg-git-setup',
  imports: [],
  template: `
@if (chat.needsGit(); as label) {
  @if (chat.gitPlan(); as plan) {
    <div class="cmp-card" role="group" aria-label="Chuẩn bị Git">
      <p>Sẽ tạo commit đầu tiên gồm {{ plan.files }} tệp.</p>
      @if (plan.ignore.length) {
        <p class="dim">Thêm vào <code>.gitignore</code> để không commit nhầm bí mật và thư viện:</p>
        <pre class="mono ap-git-ignore">{{ plan.ignore.join('\\n') }}</pre>
      }
      @if (!chat.workspace.project()?.gitUser) {
        <input aria-label="Tên trong Git" placeholder="Tên của bạn" [value]="chat.gitName()" (input)="chat.gitName.set($any($event.target).value)" />
        <input aria-label="Email trong Git" placeholder="Email" [value]="chat.gitEmail()" (input)="chat.gitEmail.set($any($event.target).value)" />
      }
      <div class="permission-actions">
        <button class="btn ghost sm" (click)="chat.gitPlan.set(null)">Hủy</button>
        <button class="btn primary sm" [disabled]="chat.gitBusy()" (click)="chat.prepareGit()">Đồng ý</button>
      </div>
    </div>
  } @else {
    <div class="cmp-hint"><button class="btn ghost sm" [disabled]="chat.gitBusy()" (click)="chat.planGit()">{{ label }}</button></div>
  }
}
  `,
})
export class GitSetup {
  protected readonly chat = inject(ChatState);
}
