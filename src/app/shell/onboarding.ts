import { Component, computed, inject, linkedSignal, output, signal } from '@angular/core';
import { AgentsService } from '../core/agents.service';
import { AGENT_META } from '../agents/agent-meta';
import { RunsService } from '../core/runs.service';
import { WorkspaceService } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';
import { errorText } from '../shared/errors';
import { copyText } from '../shared/clipboard';

export const ONBOARDED_KEY = 'tg.onboarded';

const SAMPLE = 'Giải thích cấu trúc thư mục này trong 5 gạch đầu dòng.';

/** First run: find the CLIs, log in, pick a repo, run a read-only sample. Under five minutes. */
@Component({
  selector: 'tg-onboarding',
  imports: [AgentAvatar],
  template: `
    <div class="onb-backdrop">
      <section class="onb" role="dialog" aria-modal="true" aria-labelledby="onb-title">
        <header class="onb-head">
          <h1 id="onb-title">Bắt đầu với TG Studio</h1>
          <span class="spacer"></span>
          <button class="btn ghost sm" (click)="finish()">Bỏ qua</button>
        </header>
        <ol class="onb-steps" aria-label="Các bước">
          @for (s of steps; track s; let i = $index) {
            <li [class.active]="i === step()" [class.done]="i < step()"><button (click)="step.set(i)">{{ i + 1 }}. {{ s }}</button></li>
          }
        </ol>

        <div class="onb-body">
          @switch (step()) {
            @case (0) {
              <p>TG Studio điều khiển các agent CLI đã cài trên máy bạn. Cần ít nhất một agent.</p>
              <ul class="onb-agents">
                @for (a of agents.agents(); track a.id) {
                  <li>
                    <tg-agent-avatar [agent]="a.id" [size]="20" />
                    <strong>{{ a.name }}</strong>
                    @if (a.path) {
                      <span class="tag ok">đã cài</span><span class="dim mono ellipsis">{{ a.version }}</span>
                    } @else {
                      <span class="tag warn">chưa cài</span>
                      <code class="mono">{{ meta[a.id].install }}</code>
                      <button class="btn ghost sm" (click)="copy(meta[a.id].install)">Chép</button>
                    }
                  </li>
                } @empty {
                  <li class="dim">Đang dò…</li>
                }
              </ul>
              <div class="onb-actions">
                <button class="btn ghost sm" [disabled]="agents.checking()" (click)="agents.refresh()">{{ agents.checking() ? 'Đang dò…' : 'Dò lại' }}</button>
                <span class="spacer"></span>
                <button class="btn primary sm" [disabled]="!installed().length" (click)="step.set(1)">Tiếp</button>
              </div>
              @if (!installed().length && !agents.checking()) { <p class="dim">Cài một agent trong terminal, rồi bấm Dò lại.</p> }
            }
            @case (1) {
              <p>Mỗi agent dùng tài khoản của chính nó. Đăng nhập một lần trong terminal; TG Studio không lưu mật khẩu hay khóa nào.</p>
              <ul class="onb-agents">
                @for (a of installed(); track a.id) {
                  <li>
                    <tg-agent-avatar [agent]="a.id" [size]="20" />
                    <strong>{{ a.name }}</strong>
                    @if (a.auth === 'ok') {
                      <span class="tag ok">đã đăng nhập</span>
                    } @else {
                      @if (a.auth === 'none') { <span class="tag warn">cần đăng nhập</span> }
                      <code class="mono">{{ meta[a.id].login }}</code>
                      <button class="btn ghost sm" (click)="copy(meta[a.id].login)">Chép</button>
                    }
                  </li>
                }
              </ul>
              <p class="dim">Claude Code: chạy <code>claude</code> rồi làm theo hướng dẫn đăng nhập (gói Pro/Max hoặc API key). Nếu đã dùng agent trong terminal thì bỏ qua bước này.</p>
              <div class="onb-actions"><button class="btn ghost sm" (click)="step.set(0)">Quay lại</button><span class="spacer"></span><button class="btn primary sm" (click)="step.set(2)">Tiếp</button></div>
            }
            @case (2) {
              <p>Chọn thư mục dự án. Chế độ Sửa code cần một repo Git có ít nhất một commit; agent làm trong bản nháp riêng nên code thật chỉ đổi khi bạn Nhận.</p>
              <div class="onb-actions"><button class="btn primary sm" (click)="workspace.pickFolder()">Chọn thư mục…</button></div>
              <form class="onb-folder" (submit)="$event.preventDefault(); check()">
                <input class="mono" aria-label="Thư mục dự án" [value]="folder()" (input)="folder.set($any($event.target).value)" spellcheck="false" />
                <button class="btn ghost sm" type="submit">Kiểm tra</button>
              </form>
              @if (workspace.folderError(); as e) {
                <p class="error-text" role="alert">{{ e }}</p>
              } @else {
                @switch (workspace.project()?.git) {
                  @case ('ready') { <p class="ok-text">Repo Git: <strong>{{ workspace.project()!.name }}</strong> · nhánh {{ workspace.project()!.branch ?? '(HEAD tách rời)' }}</p> }
                  @case ('no_commits') { <p class="dim">Repo Git này chưa có commit, nên chưa dùng được chế độ Sửa code. Hãy commit trong dự án trước, hoặc dùng Chỉ đọc.</p> }
                  @case ('none') { <p class="dim">Không phải repo Git, nên chỉ dùng được chế độ Chỉ hỏi ở đây.</p> }
                }
              }
              <div class="onb-actions"><button class="btn ghost sm" (click)="step.set(1)">Quay lại</button><span class="spacer"></span><button class="btn primary sm" [disabled]="!workspace.folder()" (click)="step.set(3)">Tiếp</button></div>
            }
            @case (3) {
              <p>Chạy thử một yêu cầu <strong>chỉ đọc</strong> (không sửa tệp nào) với {{ sampleAgent()?.name ?? 'agent' }}:</p>
              <blockquote class="onb-sample">{{ sample }}</blockquote>
              @if (error()) { <p class="error-text">{{ error() }}</p> }
              <div class="onb-actions">
                <button class="btn ghost sm" (click)="step.set(2)">Quay lại</button>
                <span class="spacer"></span>
                <button class="btn ghost sm" (click)="finish()">Xong, không chạy thử</button>
                <button class="btn primary sm" [disabled]="!sampleAgent() || busy()" (click)="runSample()">Chạy thử</button>
              </div>
              @if (!sampleAgent()) { <p class="dim">Chạy thử cần một agent có chế độ chỉ-đọc (Claude Code, Codex hoặc Gemini CLI).</p> }
            }
          }
        </div>
      </section>
    </div>
  `,
})
export class Onboarding {
  protected readonly agents = inject(AgentsService);
  protected readonly workspace = inject(WorkspaceService);
  private readonly runs = inject(RunsService);
  readonly done = output<void>();

  protected readonly meta = AGENT_META;
  protected readonly sample = SAMPLE;
  protected readonly steps = ['Agent', 'Đăng nhập', 'Chọn repo', 'Chạy thử'];
  protected readonly step = signal(0);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Follows the workspace folder (loaded asynchronously) until the user types. */
  protected readonly folder = linkedSignal(() => this.workspace.folder());
  protected readonly installed = computed(() => this.agents.agents().filter((a) => a.path));
  protected readonly sampleAgent = computed(() => this.agents.runnable()[0] ?? null);

  protected async copy(text: string): Promise<void> {
    await copyText(text); // if it fails, the text is on screen
  }

  protected async check(): Promise<void> {
    await this.workspace.setFolder(this.folder());
  }

  protected async runSample(): Promise<void> {
    const agent = this.sampleAgent();
    if (!agent) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.runs.start(agent.id, SAMPLE, this.workspace.folder());
      this.finish();
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected finish(): void {
    try {
      localStorage.setItem(ONBOARDED_KEY, '1');
    } catch {
      /* it will show again next time; harmless */
    }
    this.done.emit();
  }
}
