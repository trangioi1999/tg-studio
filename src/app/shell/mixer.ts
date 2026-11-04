import { Component, computed, inject, input, signal } from '@angular/core';
import { AGENT_IDS, AGENT_META, AgentId, CheckResult, FileDiff, Hunk } from '../core/protocol';
import { Run, RunsService } from '../core/runs.service';
import { AgentAvatar } from './agent-avatar';

interface Entry {
  key: string;
  path: string;
  run: Run;
  hunk: Hunk;
}

/**
 * Hand-pick hunks from several runs of a group, build them into a composite worktree,
 * run a check command there, then use the mix as the group's result.
 */
@Component({
  selector: 'tg-mixer',
  imports: [AgentAvatar],
  template: `
    <section class="mixer" aria-label="Ghép thay đổi từ nhiều bản">
      <div class="block-head">
        <span class="label">GHÉP THỦ CÔNG</span>
        <span class="dim ellipsis">Lấy từng thay đổi từ các bản khác nhau, kiểm tra rồi mới áp</span>
        <span class="spacer"></span>
        <button class="btn ghost sm" [attr.aria-expanded]="open()" (click)="open.set(!open())">{{ open() ? 'Thu gọn' : 'Mở' }}</button>
      </div>
      @if (open()) {
        <div class="mix-body">
          @for (file of files(); track file.path) {
            <div class="mix-file mono">{{ file.path }}</div>
            @for (e of file.entries; track e.key) {
              <div class="mix-hunk" [style.--agent]="meta[e.run.agent].color">
                <label class="mix-pick">
                  <input type="checkbox" [checked]="picked().has(e.key)" [disabled]="locked()" (change)="toggle(e.key)" />
                  <tg-agent-avatar [agent]="e.run.agent" [size]="14" />
                  <span class="mono dim ellipsis">{{ e.hunk.header }}</span>
                  <span class="spacer"></span>
                  <span class="hunk-count"><span class="plus">+{{ e.hunk.added }}</span> <span class="minus">−{{ e.hunk.removed }}</span></span>
                </label>
                <button class="btn ghost sm" [attr.aria-expanded]="previewing() === e.key" (click)="previewing.set(previewing() === e.key ? null : e.key)">Xem</button>
              </div>
              @if (previewing() === e.key) {
                <div class="hunk-body" [style.--agent]="meta[e.run.agent].color">
                  @for (line of e.hunk.lines; track $index) { <div class="diff-line" [attr.data-kind]="kindOf(line)">{{ line }}</div> }
                </div>
              }
            }
          } @empty {
            <p class="dim pad">Chưa có thay đổi nào để ghép.</p>
          }

          @if (error()) { <p class="error-text pad" role="alert">{{ error() }}</p> }

          @if (composite(); as c) {
            <div class="mix-result">
              <div class="mix-line">
                <strong>Bản ghép</strong>
                <span class="dim">{{ c.files.length }} tệp · <span class="plus">+{{ totals(c.files).added }}</span> <span class="minus">−{{ totals(c.files).removed }}</span></span>
                <span class="spacer"></span>
                <button class="btn ghost sm" [disabled]="busy() || locked()" (click)="drop()">Bỏ bản ghép</button>
              </div>
              <div class="mix-line">
                <label class="field grow">
                  <span>Lệnh kiểm tra, chạy trong bản ghép</span>
                  <input class="mono" placeholder="npm test" [value]="command()" (input)="command.set($any($event.target).value)" (keydown.enter)="check()" spellcheck="false" />
                </label>
                <button class="btn ghost" [disabled]="busy() || !command().trim()" (click)="check()">{{ checking() ? 'Đang chạy…' : 'Chạy kiểm tra' }}</button>
              </div>
              @if (result(); as r) {
                <div class="check-result" [attr.data-ok]="r.code === 0">
                  <div class="mix-line">
                    <strong>{{ r.code === 0 ? 'Đạt' : r.code === null ? 'Bị dừng' : 'Không đạt (mã ' + r.code + ')' }}</strong>
                    <span class="dim">{{ (r.durationMs / 1000).toFixed(1) }} s</span>
                    @if (r.truncated) { <span class="dim">· chỉ giữ phần cuối output</span> }
                  </div>
                  <pre class="mono">{{ r.output || '(không có output)' }}</pre>
                </div>
              }
              @if (!locked()) {
                <div class="mix-line">
                  <span class="spacer"></span>
                  @if (confirming()) {
                    <button class="btn ghost sm" [disabled]="busy()" (click)="confirming.set(false)">Thôi</button>
                    <button class="btn warn sm" [disabled]="busy()" (click)="use()">Áp bản ghép vào repo</button>
                  } @else {
                    <button class="btn primary sm" [disabled]="busy()" (click)="confirming.set(true)">Dùng bản ghép</button>
                  }
                </div>
              }
            </div>
          } @else {
            <div class="mix-line pad">
              <span class="dim">{{ picked().size }} thay đổi được chọn</span>
              <span class="spacer"></span>
              <button class="btn primary sm" [disabled]="busy() || !picked().size || locked()" (click)="build()">Tạo bản ghép</button>
            </div>
          }
        </div>
      }
    </section>
  `,
})
export class Mixer {
  private readonly runsService = inject(RunsService);
  readonly group = input.required<string>();
  readonly runs = input.required<Run[]>();
  /** Pending diffs per run id, loaded by the compare view. */
  readonly diffs = input.required<Record<string, FileDiff[]>>();

  protected readonly meta = AGENT_META;
  protected readonly open = signal(false);
  protected readonly picked = signal(new Set<string>());
  protected readonly previewing = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly checking = signal(false);
  protected readonly confirming = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<CheckResult | null>(null);
  protected readonly command = signal(this.runsService.checkCommand());
  protected readonly composite = computed(() => this.runsService.composites()[this.group()] ?? null);
  /** Once the group has a choice, the mix can no longer change. */
  protected readonly locked = computed(() => !!this.runsService.choices()[this.group()]);

  /** Every hunk of every run, grouped by file, agents in the usual order. */
  protected readonly files = computed(() => {
    const byPath = new Map<string, Entry[]>();
    const runs = [...this.runs()].sort((a, b) => AGENT_IDS.indexOf(a.agent as AgentId) - AGENT_IDS.indexOf(b.agent as AgentId));
    for (const run of runs) {
      for (const f of this.diffs()[run.id] ?? []) {
        if (f.binary) continue;
        const list = byPath.get(f.path) ?? [];
        for (const hunk of f.hunks) list.push({ key: `${run.id}|${f.path}|${hunk.id}`, path: f.path, run, hunk });
        byPath.set(f.path, list);
      }
    }
    return [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, entries]) => ({ path, entries }));
  });

  protected kindOf(line: string): string {
    return line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('\\') ? 'meta' : 'ctx';
  }

  protected totals(files: FileDiff[]) {
    const hunks = files.flatMap((f) => f.hunks);
    return { added: hunks.reduce((n, h) => n + h.added, 0), removed: hunks.reduce((n, h) => n + h.removed, 0) };
  }

  protected toggle(key: string): void {
    const next = new Set(this.picked());
    if (!next.delete(key)) next.add(key);
    this.picked.set(next);
  }

  protected async build(): Promise<void> {
    // Keep file order, then the order hunks appear in, so patches apply top to bottom.
    const picks = this.files().flatMap((f) => f.entries).filter((e) => this.picked().has(e.key))
      .map((e) => ({ runId: e.run.id, path: e.path, hunkId: e.hunk.id }));
    await this.guard(async () => {
      this.result.set(null);
      await this.runsService.compose(this.group(), picks);
    });
  }

  protected async check(): Promise<void> {
    if (!this.command().trim() || this.busy()) return;
    this.checking.set(true);
    await this.guard(async () => this.result.set(await this.runsService.checkComposite(this.group(), this.command().trim())));
    this.checking.set(false);
  }

  protected async use(): Promise<void> {
    await this.guard(async () => {
      await this.runsService.useComposite(this.group());
      this.confirming.set(false);
    });
  }

  protected async drop(): Promise<void> {
    await this.guard(async () => {
      await this.runsService.dropComposite(this.group());
      this.result.set(null);
    });
  }

  private async guard(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
