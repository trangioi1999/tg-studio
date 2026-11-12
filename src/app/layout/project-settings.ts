import { Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { AgentBackend } from '../core/backend';
import { ProjectSettings } from '../core/protocol';
import { errorText } from '../shared/utils/errors';
import { IS_MAC } from '../shared/utils/keys';

const SETUP_EXAMPLE = IS_MAC
  ? 'cp "$TG_ROOT_PATH/.env" . && npm install'
  : 'Copy-Item "$env:TG_ROOT_PATH\\.env" . ; npm install';

/** A project's hooks: the setup script of new drafts and the check after each agent turn. */
@Component({
  selector: 'tg-project-settings',
  template: `
    <form class="hk-form" (submit)="$event.preventDefault(); save()" aria-label="Thiết lập dự án">
      <label class="field">
        <span>Script chuẩn bị bản nháp</span>
        <textarea class="mono" rows="2" [placeholder]="setupExample" [value]="value().setup" (input)="patch({ setup: $any($event.target).value })"></textarea>
        <small class="dim">Chạy một lần trong mỗi bản nháp mới, trước khi agent bắt đầu. Bản nháp chỉ có tệp đã commit; dùng <code>TG_ROOT_PATH</code> để chép tệp như .env từ thư mục dự án.</small>
      </label>
      <label class="field">
        <span>Lệnh kiểm tra</span>
        <input class="mono" placeholder="npm test" [value]="value().check" (input)="patch({ check: $any($event.target).value })" />
        <small class="dim">Chạy sau mỗi lượt agent có sửa tệp.</small>
      </label>
      <label class="hk-row">
        <input type="checkbox" [checked]="value().autoFix" (change)="patch({ autoFix: $any($event.target).checked })" />
        <span>Kiểm tra hỏng thì gửi lỗi cho agent tự sửa, tối đa</span>
        <input class="hk-rounds" type="number" min="1" max="5" [value]="value().maxFixRounds" [disabled]="!value().autoFix"
          (input)="patch({ maxFixRounds: +$any($event.target).value })" aria-label="Số lần tự sửa tối đa" />
        <span>lần</span>
      </label>
      @if (error()) { <p class="error-text" role="alert">{{ error() }}</p> }
      <div class="hk-actions">
        @if (saved()) { <span class="ok-text" role="status">Đã lưu</span> }
        <button type="button" class="btn ghost sm" (click)="closed.emit()">Đóng</button>
        <button type="button" class="btn primary sm hk-save" [disabled]="busy()" (click)="save()">Lưu</button>
      </div>
    </form>
  `,
})
export class ProjectSettingsForm {
  private readonly backend = inject(AgentBackend);
  readonly root = input.required<string>();
  readonly closed = output<void>();
  protected readonly setupExample = SETUP_EXAMPLE;
  protected readonly value = signal<ProjectSettings>({ setup: '', check: '', autoFix: true, maxFixRounds: 2 });
  protected readonly busy = signal(false);
  protected readonly saved = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const root = this.root();
      untracked(() => {
        this.backend.projectSettings(root)
          .then((s) => root === this.root() && this.value.set(s))
          .catch((e) => this.error.set(errorText(e)));
      });
    });
  }

  protected patch(p: Partial<ProjectSettings>): void {
    this.value.update((v) => ({ ...v, ...p }));
    this.saved.set(false);
  }

  protected async save(): Promise<void> {
    const v = this.value();
    const rounds = Number.isFinite(v.maxFixRounds) ? Math.min(5, Math.max(1, Math.round(v.maxFixRounds))) : 2;
    const settings = { ...v, maxFixRounds: rounds };
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.backend.setProjectSettings(this.root(), settings);
      this.value.set(settings);
      this.saved.set(true);
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
