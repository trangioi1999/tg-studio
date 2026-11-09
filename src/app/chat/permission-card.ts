import { Component, ElementRef, afterNextRender, computed, inject, input, signal } from '@angular/core';
import { AgentId, PermissionOption, PermissionRequest } from '../core/protocol';
import { KEYS } from '../shared/keys';
import { RunsService } from '../runs/runs.service';
import { AgentAvatar } from '../shared/agent-avatar';

/**
 * An approval card. "Always allow" always answers with the once-only option and
 * asks the core to save its own narrow rule. The agent's `allow_always` option is
 * never sent, because the agent decides what that covers, often a whole tool.
 */
@Component({
  selector: 'tg-permission-card',
  imports: [AgentAvatar],
  template: `
    <section class="permission" tabindex="-1" role="alertdialog" [attr.aria-label]="'Xin duyệt: ' + title()"
      (keydown.meta.enter)="allowOnce()" (keydown.control.enter)="allowOnce()"
      (keydown.meta.backspace)="deny()" (keydown.control.backspace)="deny()">
      <div class="permission-head">
        <tg-agent-avatar [agent]="agent()" [size]="16" />
        <span>Cần bạn duyệt</span>
      </div>
      <div>{{ title() }}</div>
      @if (command(); as c) { <code>{{ c }}</code> }
      <div class="permission-actions">
        @if (reject(); as o) {
          <button class="btn ghost sm" [disabled]="busy()" (click)="answer(o, false)">Từ chối<span class="kbd">{{ keys.backspace }}</span></button>
        }
        @if (once(); as o) {
          @if (request().rule; as rule) {
            <button class="btn ghost sm" [disabled]="busy()" (click)="answer(o, true)">Luôn cho phép <span class="mono">{{ rule }}</span></button>
          }
          <button class="btn warn sm" [disabled]="busy()" (click)="answer(o, false)">Cho phép lần này<span class="kbd">{{ keys.enter }}</span></button>
        }
      </div>
      @if (error()) { <p class="error-text">{{ error() }}</p> }
    </section>
  `,
})
export class PermissionCard {
  protected readonly keys = KEYS;
  private readonly runs = inject(RunsService);
  readonly runId = input.required<string>();
  readonly agent = input.required<AgentId>();
  readonly request = input.required<PermissionRequest>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly title = computed(() => this.request().toolCall.title ?? 'Agent muốn dùng một công cụ');
  protected readonly command = computed(() => {
    const c = this.request().toolCall.rawInput?.command;
    return Array.isArray(c) ? c.join(' ') : (c ?? null);
  });
  protected readonly once = computed(() => this.find('allow_once'));
  protected readonly reject = computed(() => this.find('reject_once') ?? this.find('reject_always'));

  constructor() {
    // Takes keyboard focus so the shortcuts work without reaching for the mouse.
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    afterNextRender(() => host.nativeElement.querySelector<HTMLElement>('.permission')?.focus());
  }

  protected allowOnce(): void {
    const option = this.once();
    if (option) void this.answer(option, false);
  }

  protected deny(): void {
    const option = this.reject();
    if (option) void this.answer(option, false);
  }

  protected async answer(option: PermissionOption, always: boolean): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.runs.respondPermission(this.runId(), this.request().requestId, option.optionId, always);
    } catch (e) {
      this.error.set(String(e));
      this.busy.set(false);
    }
  }

  private find(kind: PermissionOption['kind']): PermissionOption | undefined {
    return this.request().options.find((o) => o.kind === kind);
  }
}
