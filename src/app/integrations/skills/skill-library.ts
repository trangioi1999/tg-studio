import { Component, inject } from '@angular/core';
import { AgentAvatar } from '../../shared/agent-avatar';
import { IntegrationsState } from '../integrations.state';

/** The Skill tab: the SKILL.md library, where each is installed, and the skills agents already see. */
@Component({
  selector: 'tg-skill-library',
  imports: [AgentAvatar],
  template: `
<section id="conn-skills" role="tabpanel" aria-labelledby="conn-skills-tab">
  <div class="conn-filters">
    <div class="conn-chips">
      @for (f of conn.filters; track f.id) {
        <button
          class="fchip"
          [attr.aria-pressed]="conn.skillFilter() === f.id"
          (click)="conn.skillFilter.set(f.id)"
        >
          {{ f.label }}
        </button>
      }
    </div>
    <span class="dim">{{
      conn.folderName()
        ? 'Dự án: ' + conn.folderName() + ' · đọc từ agent, không tốn token'
        : 'Mở một thư mục để xem skill của dự án.'
    }}</span>
  </div>
  <div class="pg-card conn-skills">
    <div class="conn-skill-row conn-skill-head">
      <span>Skill</span>
      @for (a of conn.skillAgents; track a) {
        <div class="conn-row">
          <tg-agent-avatar [agent]="a" [size]="16" />{{ conn.meta[a].name }}
          @if (conn.loading(a)) {
            <span class="dim"><span class="spin"></span> đang đọc…</span>
          }
        </div>
      }
      <span></span>
    </div>
    @for (row of conn.skillRows(); track row.name) {
      <div class="conn-skill-row" [class.conn-seen-only]="!row.library">
        <div>
          <strong class="mono">{{ row.name }}</strong>
          <p class="conn-description dim">{{ row.description }}</p>
        </div>
        @for (a of conn.skillAgents; track a) {
          <div class="conn-chips conn-skill-status" [attr.aria-label]="conn.meta[a].name">
            @if (row.visible.includes(a)) {
              <span class="tag ok">● đang thấy</span>
            }
            @if (row.library; as k) {
              @if (a === 'claude') {
                @for (t of conn.targets()[k.name] ?? []; track t.scope) {
                  @if (t.state === 'same') {
                    <span class="tag ok" [title]="t.path"
                      >✓ {{ t.scope === 'project' ? 'repo' : 'máy' }}</span
                    >
                  } @else {
                    <button
                      class="btn sm"
                      [class.conn-update]="t.state === 'different'"
                      [title]="t.path"
                      [disabled]="conn.busy()"
                      (click)="conn.install(k, t)"
                    >
                      {{ t.state === 'different' ? '↑ cập nhật ' : 'Cài vào '
                      }}{{ t.scope === 'project' ? 'repo' : 'máy' }}
                    </button>
                  }
                }
                @if (!conn.targets()[k.name]?.length) {
                  <span class="dim">Chưa đọc được nơi cài</span>
                }
              } @else {
                <span
                  class="dim"
                  title="Chưa có vị trí chuẩn đã kiểm chứng để đặt SKILL.md cho agent này"
                  >chưa hỗ trợ</span
                >
              }
            } @else if (!row.visible.includes(a)) {
              <span class="dim">—</span>
            }
          </div>
        }
        <div class="conn-chips">
          @if (row.library; as k) {
            @if (conn.confirming() === 'skill:' + k.name) {
              <div
                class="conn-confirm"
                role="group"
                [attr.aria-label]="'Xoá skill ' + k.name"
              >
                <span>Xoá skill?</span
                ><button class="btn sm" (click)="conn.confirming.set(null)">Huỷ</button
                ><button
                  class="btn sm conn-danger"
                  [disabled]="conn.busy()"
                  (click)="conn.removeSkill(k)"
                >
                  Xoá
                </button>
              </div>
            } @else {
              <button class="btn sm" (click)="conn.editSkill(k.content)">Sửa</button
              ><button class="btn sm" (click)="conn.confirming.set('skill:' + k.name)">
                Xoá
              </button>
            }
          }
        </div>
      </div>
    } @empty {
      <p class="conn-empty dim">
        {{
          conn.skillFilter() === 'library'
            ? 'Thư viện trống. Thêm skill để bắt đầu.'
            : 'Chưa có skill trong bộ lọc này.'
        }}
      </p>
    }
    <footer class="conn-legend dim">
      <span>✓ đã cài, trùng thư viện</span
      ><span class="conn-update">↑ bản cài khác thư viện</span
      ><span>● agent tự tìm thấy</span
      ><span
        title="Claude đọc .claude/skills trong repo và ~/.claude/skills; bản cũ được sao lưu trước khi cập nhật. Codex đọc .agents/skills và skill của máy."
        >Gõ / ở ô chat (Codex: $) để gọi</span
      >
    </footer>
  </div>
</section>
  `,
})
export class SkillLibrary {
  protected readonly conn = inject(IntegrationsState);
}
