import { Component, computed, inject } from '@angular/core';
import { AGENT_META } from '../../../services/agents/agent-meta';
import { ContextCategory } from '../../../core/protocol';
import { AgentAvatar } from '../../../shared/ui/agent-avatar';
import { canCompact, CATEGORY_COLORS, categoryName } from '../../../shared/utils/context';
import { fmtTokens } from '../../../shared/utils/format';
import { ChatState } from '../chat.state';

interface Row { name: string; tokens: string; share: string; color: string; kind: ContextCategory['kind']; pct: number }

const pctText = (n: number) => n.toFixed(1).replace('.', ',') + '%';
const tok = (n: number) => fmtTokens(n).replace('.', ',');

/** The floating breakdown of the context window above the composer. */
@Component({
  selector: 'tg-context-panel',
  imports: [AgentAvatar],
  template: `
@if (chat.run(); as r) {
  @if (r.context; as c) {
    <section class="ctx-panel" role="dialog" [attr.aria-label]="'Context của ' + meta[r.agent].name">
      <header class="ctx-head">
        <tg-agent-avatar [agent]="r.agent" [size]="18" />
        <strong>Context</strong>
        <span class="dim">· {{ meta[r.agent].name }}@if (r.model) { · {{ r.model }} }</span>
        <span class="spacer"></span>
        <button class="chip-btn icon-only" aria-label="Đóng" (click)="chat.menu.set(null)"><svg class="ic xs" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button>
      </header>
      @if (c.percent !== null) {
        <div class="ctx-big">
          <span class="ctx-pct">{{ round(c.percent) }}%</span>
          <span class="dim">đã dùng</span>
          <span class="spacer"></span>
          @if (c.used !== null && c.size !== null) { <span class="mono ctx-count">{{ tok(c.used) }} / {{ tok(c.size) }}</span> }
        </div>
      }
      @if (rows().length) {
        <div class="ctx-bar" aria-hidden="true">
          @for (x of rows(); track x.name) {
            @if (x.kind !== 'free') { <span [class.buffer]="x.kind === 'buffer'" [style.width.%]="x.pct" [style.background]="x.kind === 'buffer' ? null : x.color"></span> }
          }
        </div>
        <ul class="ctx-rows">
          @for (x of rows(); track x.name) {
            <li class="ctx-row"><span class="ctx-sw" aria-hidden="true" [style.background]="x.color"></span><span class="ctx-name">{{ x.name }}</span><span class="mono dim">{{ x.tokens }}</span><span class="mono dim ctx-share">{{ x.share }}</span></li>
          }
        </ul>
        @if (c.memoryFiles?.length) {
          <details class="ctx-more"><summary>Tệp ghi nhớ · {{ c.memoryFiles!.length }}</summary>
            <div class="mono ctx-list">@for (f of c.memoryFiles!; track f.path) { <div><span class="ctx-name">{{ f.path }}</span><span>{{ tok(f.tokens) }}</span></div> }</div>
          </details>
        }
        @if (c.mcpTools?.length) {
          <details class="ctx-more"><summary>Tool MCP · {{ mcpCount() }}</summary>
            <div class="mono ctx-list">@for (m of c.mcpTools!; track m.server) { <div><span class="ctx-name">{{ m.server }} · {{ m.count }} tool</span><span>{{ tok(m.tokens) }}</span></div> }</div>
          </details>
        }
      } @else {
        <p class="dim ctx-note">{{ r.agent === 'kiro' ? 'Kiro chỉ báo phần trăm.' : meta[r.agent].name + ' chỉ báo tổng đang dùng.' }}</p>
      }
      <footer class="ctx-foot">
        <span class="dim">Cập nhật sau mỗi lượt@if (c.autoCompactAt) { · tự thu gọn ở {{ c.autoCompactAt }}% }</span>
        <span class="spacer"></span>
        @if (compactable() && r.status === 'idle') { <button class="btn ghost sm" (click)="compact(r.id)">Thu gọn ngay (/compact)</button> }
      </footer>
    </section>
  }
}
  `,
})
export class ContextPanel {
  protected readonly chat = inject(ChatState);
  protected readonly meta = AGENT_META;
  protected readonly tok = tok;
  protected readonly round = Math.round;

  protected readonly rows = computed<Row[]>(() => {
    const c = this.chat.run()?.context;
    const cats = c?.categories ?? [];
    const total = c?.size || cats.reduce((n, x) => n + x.tokens, 0);
    if (!cats.length || !total) return [];
    let i = 0;
    return cats.map((x) => {
      const used = !x.kind || x.kind === 'used' || x.kind === 'deferred';
      return { name: categoryName(x), tokens: tok(x.tokens), share: pctText((x.tokens / total) * 100), kind: x.kind, pct: (x.tokens / total) * 100,
        color: used ? CATEGORY_COLORS[i++ % CATEGORY_COLORS.length] : x.kind === 'free' ? 'var(--line)' : 'var(--line-strong)' };
    });
  });
  protected readonly mcpCount = computed(() => (this.chat.run()?.context?.mcpTools ?? []).reduce((n, m) => n + m.count, 0));
  protected readonly compactable = computed(() => {
    const r = this.chat.run();
    if (!r) return false;
    const list = this.chat.agents.commandsFor(r.agent, r.cwd);
    return canCompact(r.agent, Array.isArray(list) ? list : []);
  });

  protected compact(id: string): void {
    this.chat.menu.set(null);
    void this.chat.runs.sendMessage(id, '/compact');
  }
}
