import { Component, ElementRef, HostListener, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AgentsService } from '../core/agents.service';
import { BudgetService } from '../core/budget.service';
import { fmtDuration, fmtTokens, fmtUsd } from '../core/format';
import { KEYS } from '../core/keys';
import { DEFAULT_TEMPLATES, PipelineService, PipelineStep } from '../core/pipeline.service';
import { estimateCost } from '../core/pricing';
import { AgentBackend } from '../core/backend';
import { AGENT_IDS, AGENT_META, AgentCommand, AgentId, BridgeNote, GitPlan } from '../core/protocol';
import { GROUP_LABEL, commandQuery, filterCommands, insertCommand } from '../core/commands';
import { Run, RunsService, isQuiet, recapOf, turnStart } from '../core/runs.service';
import { ThreadsService } from '../core/threads.service';
import { UiService } from '../core/ui.service';
import { WorkspaceService } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';
import { PermissionCard } from './permission-card';
import { Delegations } from './delegations';
import { Markdown, plainText } from './markdown';
import { copyText } from '../shared/clipboard';
import { NgTemplateOutlet } from '@angular/common';
import { segmentsOf, Segment } from '../core/timeline';
import { Approval, ConfigChoice, Place } from '../core/protocol';
import { errorText } from '../shared/errors';

type Mode = 'task' | 'parallel' | 'pipeline' | 'read';
type TurnStatus = 'running' | 'needs_you' | 'waiting' | 'failed' | 'stopped';

const PIPELINE_KEY = 'tg.pipeline';

const EFFORT_VI: Record<string, string> = { default: 'Mặc định', minimal: 'Rất thấp', low: 'Thấp', medium: 'Vừa', high: 'Cao', xhigh: 'Rất cao', max: 'Tối đa' };

/**
 * Right side of the IDE: the selected task's thread, plan and runs, its usage,
 * approval cards, and the composer that hands out work.
 */
@Component({
  selector: 'tg-agent-panel',
  imports: [AgentAvatar, PermissionCard, Markdown, NgTemplateOutlet, Delegations],
  template: `
    <ng-template #composer>
      <section class="cmp" [class.big]="!run()" aria-label="Giao việc">
        @if (scopeShown(); as scope) {
          <div class="cmp-scope dim">Trong thư mục <code>{{ scope }}/</code>
            @if (!run()) { <button class="link" (click)="threads.draftScope.set(null)">Bỏ</button> }
          </div>
        }
        @if (cmdMenu(); as cm) {
          <div class="pop cmd-pop" role="listbox" id="cmd-list" aria-label="Skill và lệnh của agent">
            @if (cm.loading) {
              <p class="pop-note"><span class="spin"></span> Đang đọc skill của {{ cm.agent }}…</p>
            } @else {
              @for (g of cm.groups; track g.group) {
                <div class="cmd-group">{{ groupLabel[g.group] }}</div>
                @for (c of g.items; track c.name) {
                  <button role="option" class="cmd-opt" [class.on]="cm.active === c" [attr.aria-selected]="cm.active === c"
                    (mousedown)="$event.preventDefault()" (click)="pickCommand(c)">
                    <span class="cmd-name mono">{{ c.insert.trim() }}</span>
                    @if (c.hint) { <span class="cmd-hint mono">{{ c.hint }}</span> }
                    <span class="cmd-desc ellipsis">{{ c.description }}</span>
                  </button>
                }
              } @empty {
                <p class="pop-note">{{ cm.agent }} không có skill hay lệnh nào khớp "{{ cm.query }}".</p>
              }
            }
          </div>
        }
        <label class="sr-only" for="prompt">Yêu cầu cho agent</label>
        <textarea id="prompt" #promptBox [rows]="run() ? 2 : 3" [placeholder]="placeholder()"
          [value]="prompt()" (input)="onInput($any($event.target))"
          (click)="caret.set($any($event.target).selectionStart)" (keyup)="onKeyUp($any($event))"
          [attr.aria-controls]="cmdMenu() ? 'cmd-list' : null" [attr.aria-expanded]="!!cmdMenu()"
          (keydown)="onKeyDown($any($event))"></textarea>
        <div class="cmp-bar">
          <div class="pop-anchor">
            <button class="chip-btn" [class.open]="menu() === 'agent'" aria-haspopup="true" [attr.aria-expanded]="menu() === 'agent'" [title]="'Chọn agent và model (' + keys.model + ')'" (click)="toggleMenu('agent')">
              @switch (team()) {
                @case ('parallel') {
                  <span class="av-stack">@for (a of picked(); track a) { <tg-agent-avatar [agent]="a" [size]="20" /> }</span>
                  {{ picked().length }} agent<span class="dim">· so sánh</span>
                }
                @case ('pipeline') {
                  <span class="av-stack">@for (s of steps(); track $index) { <tg-agent-avatar [agent]="s.agent" [size]="20" /> }</span>
                  Theo các bước
                }
                @default {
                  @if (agent(); as a) {
                    <tg-agent-avatar [agent]="a" [size]="20" />{{ meta[a].name }}
                    @if (agents.modelLabel(a); as m) { <span class="dim">· {{ m }}</span> }
                  } @else { Chưa có agent }
                }
              }
              <svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            @if (menu() === 'agent') {
              <div class="pop agent-pop" role="dialog" aria-label="Chọn agent và model" (keydown.escape)="menu.set(null)">
                <div class="pop-col agents-col" role="listbox" aria-label="Agent">
                  @for (a of agents.agents(); track a.id) {
                    <button role="option" class="opt" [class.on]="team() === 'single' && agent() === a.id" [attr.aria-selected]="team() === 'single' && agent() === a.id"
                      [disabled]="!usable(a.id)" (click)="pickAgent(a.id)">
                      <tg-agent-avatar [agent]="a.id" [size]="20" /><span class="ellipsis grow">{{ a.name }}</span>
                      @if (!a.path) { <span class="dim">chưa cài</span> } @else { <span class="dim">›</span> }
                    </button>
                  }
                  <hr />
                  <button class="opt" [class.on]="team() === 'parallel'" (click)="setTeam('parallel')">
                    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/><path d="M13 7h4a2 2 0 0 1 2 2v2M11 17H7a2 2 0 0 1-2-2v-2"/></svg>
                    <span class="grow">Giao cho nhiều agent…</span>
                  </button>
                  <button class="opt" [class.on]="team() === 'pipeline'" (click)="setTeam('pipeline')">
                    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h4M15 6h4M5 18h14M9 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0M12 9v6"/></svg>
                    <span class="grow">Theo các bước…</span>
                  </button>
                </div>
                <div class="pop-col detail-col">
                  @switch (team()) {
                    @case ('parallel') {
                      <p class="pop-note">Cùng một việc, mỗi agent làm một bản nháp riêng. Xong thì so sánh và chọn bản tốt nhất.</p>
                      @for (a of choices(); track a.id) {
                        <label class="opt" [class.on]="picked().includes(a.id)">
                          <input type="checkbox" [checked]="picked().includes(a.id)" (change)="toggle(a.id)" />
                          <tg-agent-avatar [agent]="a.id" [size]="20" /><span class="grow">{{ a.name }}</span>
                          <span class="dim">{{ agents.modelLabel(a.id) ?? 'mặc định' }}</span>
                        </label>
                      }
                    }
                    @case ('pipeline') {
                      <p class="pop-note">Các agent làm nối tiếp trong cùng một bản nháp: lên kế hoạch → viết code → review. Chọn agent cho từng bước ngay dưới ô chat.</p>
                    }
                    @default {
                      @if (agent(); as a) {
                        <div class="pop-title">Model của {{ meta[a].name }}</div>
                        @switch (optionsState(a)) {
                          @case ('loading') { <p class="pop-note"><span class="spin"></span> Đang hỏi {{ meta[a].name }}…</p> }
                          @case ('error') {
                            <p class="pop-note">Không đọc được danh sách model. <button class="link" (click)="retryOptions(a)">Thử lại</button></p>
                            @if (agents.optionsError()[a]; as why) { <pre class="pop-error mono">{{ why }}</pre> }
                          }
                          @case ('none') { <p class="pop-note">{{ meta[a].name }} không cho chọn model ở đây; dùng cài đặt của CLI.</p> }
                          @default {
                            @for (o of modelOptions(a); track o.value) {
                              <button class="opt" [class.on]="currentModel(a) === o.value" (click)="agents.setPref(a, { model: o.value, effort: null })">
                                <span class="grow">{{ o.name }}</span>
                                @if (o.description) { <span class="dim ellipsis">{{ o.description }}</span> }
                                @if (currentModel(a) === o.value) { <span aria-hidden="true">✓</span> }
                              </button>
                            }
                            @if (effortOptions(a).length) {
                              <hr />
                              <div class="effort-row">
                                <span class="dim">Mức suy nghĩ</span>
                                <div class="segbar" role="group" aria-label="Mức suy nghĩ">
                                  @for (o of effortOptions(a); track o.value) {
                                    <button [class.on]="currentEffort(a) === o.value" [attr.aria-pressed]="currentEffort(a) === o.value" (click)="agents.setPref(a, { effort: o.value })">{{ effortLabel(o) }}</button>
                                  }
                                </div>
                              </div>
                            }
                          }
                        }
                      }
                    }
                  }
                </div>
              </div>
            }
          </div>
          <div class="pop-anchor">
            <button class="chip-btn" [class.open]="menu() === 'perm'" aria-haspopup="true" [attr.aria-expanded]="menu() === 'perm'" title="Agent được phép làm gì" (click)="toggleMenu('perm')">
              @switch (perm()) {
                @case ('read') { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>Chỉ hỏi }
                @case ('auto') { <svg class="ic perm-auto" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>Tự động }
                @default { <svg class="ic perm-edit" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Hỏi trước }
              }
              <svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            @if (menu() === 'perm') {
              <div class="pop perm-pop" role="listbox" aria-label="Quyền của agent" (keydown.escape)="menu.set(null)">
                <button role="option" class="opt tall" [class.on]="perm() === 'read'" [attr.aria-selected]="perm() === 'read'" [disabled]="team() !== 'single'" (click)="setPerm('read')">
                  <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
                  <span class="grow"><strong>Chỉ hỏi</strong><span class="opt-desc">Agent đọc code rồi trả lời, không sửa tệp nào. Dùng để hỏi, giải thích, lên kế hoạch.@if (team() !== 'single') { Không dùng được khi giao cho nhiều agent hoặc theo các bước. }</span></span>
                  @if (perm() === 'read') { <span aria-hidden="true">✓</span> }
                </button>
                <button role="option" class="opt tall" [class.on]="perm() === 'ask'" [attr.aria-selected]="perm() === 'ask'" (click)="setPerm('ask')">
                  <svg class="ic perm-edit" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
                  <span class="grow"><strong>Sửa code · hỏi trước <span class="dim">· cần repo Git</span></strong><span class="opt-desc">Agent sửa tệp và chạy lệnh. Lệnh nhạy cảm hiện thẻ duyệt để bạn cho phép hoặc từ chối.</span></span>
                  @if (perm() === 'ask') { <span aria-hidden="true">✓</span> }
                </button>
                <button role="option" class="opt tall" [class.on]="perm() === 'auto'" [attr.aria-selected]="perm() === 'auto'" (click)="setPerm('auto')">
                  <svg class="ic perm-auto" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>
                  <span class="grow"><strong>Tự động <span class="dim">· cần repo Git</span></strong><span class="opt-desc">Agent tự sửa tệp và chạy lệnh, không xin phép. Lệnh bị cấm (git push, merge) vẫn bị chặn. Mọi việc vẫn ghi trong Nhật ký làm việc.</span></span>
                  @if (perm() === 'auto') { <span aria-hidden="true">✓</span> }
                </button>
              </div>
            }
          </div>
          @if (perm() !== 'read' && !run()?.task) {
            <div class="pop-anchor">
              <button class="chip-btn" [class.open]="menu() === 'place'" aria-haspopup="true" [attr.aria-expanded]="menu() === 'place'" [disabled]="team() === 'parallel'" [title]="team() === 'parallel' ? 'Nhiều agent luôn làm trong bản nháp riêng' : 'Agent làm ở đâu'" (click)="toggleMenu('place')">
                @if (effectivePlace() === 'direct') { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>Thư mục hiện tại }
                @else { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/></svg>Bản nháp<span class="dim">· {{ base() ?? workspace.repo()?.branch ?? 'HEAD' }}</span> }
                <svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
              </button>
              @if (menu() === 'place') {
                <div class="pop place-pop" role="listbox" aria-label="Agent làm ở đâu" (keydown.escape)="menu.set(null)">
                  <button role="option" class="opt tall" [class.on]="place() === 'direct'" [attr.aria-selected]="place() === 'direct'" (click)="setPlace('direct')">
                    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                    <span class="grow"><strong>Thư mục hiện tại</strong><span class="opt-desc">Agent sửa thẳng code của bạn, thấy cả phần bạn đang sửa dở. Panel Thay đổi chỉ hiện phần agent sửa; Hoàn tác từng đoạn được.</span></span>
                    @if (place() === 'direct') { <span aria-hidden="true">✓</span> }
                  </button>
                  <div class="pop-title">Bản nháp riêng từ nhánh</div>
                  @for (b of branches(); track b) {
                    <button role="option" class="opt" [class.on]="place() === 'draft' && (base() ?? workspace.repo()?.branch) === b" (click)="setPlace('draft', b)">
                      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/></svg><span class="grow mono ellipsis">{{ b }}</span>
                      @if (b === workspace.repo()?.branch) { <span class="dim">đang mở</span> }
                    </button>
                  } @empty {
                    <button role="option" class="opt" [class.on]="place() === 'draft'" (click)="setPlace('draft')"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/></svg><span class="grow">Từ commit đang mở (HEAD)</span></button>
                  }
                  <p class="pop-note">Bản nháp là bản sao riêng của repo: code thật chỉ đổi khi bạn bấm Nhận. Agent chỉ thấy code đã commit.</p>
                </div>
              }
            </div>
          }
          @if (team() === 'pipeline') {
            <button class="chip-btn" [attr.aria-expanded]="editSteps()" (click)="editSteps.set(!editSteps())">{{ editSteps() ? 'Xong' : 'Sửa mẫu' }}</button>
          }
          <span class="spacer"></span>
          @if (run()?.status === 'running') {
            <button class="send" aria-label="Dừng agent" title="Dừng" (click)="runs.stop(run()!.id)"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>
          } @else {
            <button class="send" aria-label="Gửi" [disabled]="!canRun()" [title]="blocked() ?? 'Gửi (Enter)'" (click)="send()"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
          }
        </div>
      </section>
      @if (team() === 'pipeline') {
        <ol class="pipe-steps" aria-label="Các bước">
          @for (s of steps(); track $index; let i = $index) {
            <li>
              <div class="pipe-step">
                <span class="pipe-num">{{ i + 1 }}</span>
                <span class="pipe-name">{{ s.name }}</span>
                <tg-agent-avatar [agent]="s.agent" [size]="18" />
                <select [attr.aria-label]="'Agent cho bước ' + s.name" (change)="setStep(i, { agent: $any($event.target).value })">
                  @for (a of choices(); track a.id) { <option [value]="a.id" [selected]="a.id === s.agent">{{ a.name }}</option> }
                </select>
              </div>
              @if (editSteps()) {
                <textarea class="mono" rows="4" [attr.aria-label]="'Mẫu prompt bước ' + s.name" [value]="s.template" (input)="setStep(i, { template: $any($event.target).value })"></textarea>
              }
            </li>
          }
        </ol>
        @if (editSteps()) {
          <p class="dim cmp-hint"><code>{{ '{{task}}' }}</code> yêu cầu · <code>{{ '{{previous}}' }}</code> tin nhắn cuối của bước trước · <code>{{ '{{diff}}' }}</code> diff hiện tại. <button class="link" (click)="resetSteps()">Khôi phục mặc định</button></p>
        }
      }
      @if (needsGit(); as label) {
        @if (gitPlan(); as plan) {
          <div class="cmp-card" role="group" aria-label="Chuẩn bị Git">
            <p>Sẽ tạo commit đầu tiên gồm {{ plan.files }} tệp.</p>
            @if (plan.ignore.length) {
              <p class="dim">Thêm vào <code>.gitignore</code> để không commit nhầm bí mật và thư viện:</p>
              <pre class="mono ap-git-ignore">{{ plan.ignore.join('\\n') }}</pre>
            }
            @if (!workspace.project()?.gitUser) {
              <input aria-label="Tên trong Git" placeholder="Tên của bạn" [value]="gitName()" (input)="gitName.set($any($event.target).value)" />
              <input aria-label="Email trong Git" placeholder="Email" [value]="gitEmail()" (input)="gitEmail.set($any($event.target).value)" />
            }
            <div class="permission-actions">
              <button class="btn ghost sm" (click)="gitPlan.set(null)">Hủy</button>
              <button class="btn primary sm" [disabled]="gitBusy()" (click)="prepareGit()">Đồng ý</button>
            </div>
          </div>
        } @else {
          <div class="cmp-hint"><button class="btn ghost sm" [disabled]="gitBusy()" (click)="planGit()">{{ label }}</button></div>
        }
      }
      @if (dirtyWarning(); as n) {
        <div class="cmp-card warn" role="alert">
          <span>Bạn có {{ n }} tệp chưa commit. Bản nháp bắt đầu từ commit mới nhất nên agent sẽ không thấy chúng.</span>
          <span class="permission-actions">
            <button class="btn ghost sm" (click)="dirtyWarning.set(null)">Hủy</button>
            <button class="btn primary sm" (click)="sendAnyway()">Tiếp tục</button>
          </span>
        </div>
      }
      @if (perm() === 'auto' && (run()?.task ? run()?.place === 'direct' : effectivePlace() === 'direct')) {
        <p class="cmp-hint warn-text">Tự động + Thư mục hiện tại: agent sửa thẳng code của bạn mà không hỏi. Hoàn tác được từng đoạn ở panel Thay đổi.</p>
      }
      @if (blocked(); as b) { @if (prompt().trim() || run()?.status !== 'running') { <p class="dim cmp-hint">{{ b }}</p> } }
      @else if (loginHint(); as h) { <p class="cmp-hint warn-text">{{ h }}</p> }
      @if (error()) { <p class="error-text cmp-hint">{{ error() }}</p> }
    </ng-template>

    <!-- The message shows the moment it is sent; starting an agent takes seconds. -->
    <ng-template #pendingMsg>
      @if (pending(); as p) {
        <div class="msg-user">{{ p.text }}</div>
        <div class="boot-status" role="status">
          @if (p.agent) { <tg-agent-avatar [agent]="p.agent" [size]="20" /> }
          <span>Đang khởi động {{ p.agent ? meta[p.agent].name : 'các agent' }}</span>
          <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
      }
    </ng-template>

    @if (menu()) { <div class="pop-backdrop" (click)="menu.set(null)"></div> }

    @if (run(); as r) {
      <div class="chat-tabs" role="tablist" aria-label="Nội dung cuộc trò chuyện">
        @for (t of panelTabs; track t.id) {
          <button role="tab" class="chat-tab" [class.active]="tab() === t.id" [attr.aria-selected]="tab() === t.id" (click)="tab.set(t.id)">{{ t.label }}</button>
        }
      </div>
      <div class="chat-scroll">
        <div class="chat-col">
          @switch (tab()) {
            @case ('thread') {
              @if (pipelineOf(); as po) {
                <ol class="stepper" aria-label="Các bước">
                  @for (s of po.pipeline.steps; track $index; let i = $index) {
                    <li [attr.data-state]="stepState(po.pipeline, i)" [class.current]="i === po.step">
                      <button [disabled]="!po.pipeline.runIds[i]" (click)="runs.selectedId.set(po.pipeline.runIds[i]!)">
                        <span class="stepper-bar"></span>
                        <tg-agent-avatar [agent]="s.agent" [size]="16" />
                        <span class="stepper-name ellipsis">{{ s.name }}</span>
                      </button>
                    </li>
                  }
                </ol>
                @if (po.pipeline.error) { <p class="error-text">{{ po.pipeline.error }}</p> }
              }
              @if (otherApprovals().length) {
                <div class="chat-notice">
                  @for (o of otherApprovals(); track o.id) {
                    <button class="pill-btn" (click)="runs.selectedId.set(o.id)"><tg-agent-avatar [agent]="o.agent" [size]="16" /> {{ meta[o.agent].name }} ở cuộc trò chuyện khác đang chờ duyệt</button>
                  }
                </div>
              }
              @for (tr of threadRuns(); track tr.id) {
                <div class="msg-user">{{ tr.prompt }}</div>
                <article class="turn">
                  <header class="turn-who">
                    <tg-agent-avatar [agent]="tr.agent" [size]="24" />
                    <strong>{{ meta[tr.agent].name }}</strong>
                    <span class="dim">{{ tr.model ? '· ' + tr.model + ' ' : '' }}· {{ permLabel(tr) }} · {{ duration(tr) }}@if (costOf(tr) !== null) { · {{ usd(costOf(tr)) }} }</span>
                    <span class="spacer"></span>
                    <span class="pill" [attr.data-status]="turnStatus(tr)">
                      @switch (turnStatus(tr)) {
                        @case ('running') { <span class="spin" aria-hidden="true"></span> }
                        @case ('needs_you') { <span aria-hidden="true">●</span> }
                        @case ('failed') { <span aria-hidden="true">✕</span> }
                        @case ('stopped') { <span aria-hidden="true">■</span> }
                        @default { <span aria-hidden="true">✓</span> }
                      }
                      {{ turnLabel[turnStatus(tr)] }}
                    </span>
                  </header>
                  @if (tr.progress; as p) {
                    <div class="turn-progress" [attr.title]="p.note ?? ''">
                      <span class="ellipsis">{{ p.step }}</span>
                      @if (p.pct !== null) {
                        <span class="meter" role="meter" aria-label="Tiến độ agent báo" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="p.pct"><span [style.width.%]="p.pct"></span></span>
                        <span class="mono dim">{{ p.pct }}%</span>
                      }
                    </div>
                  }
                  @for (seg of segments()[tr.id]; track $index; let last = $last) {
                    @switch (seg.kind) {
                      @case ('user') { <div class="msg-user">{{ seg.text }}</div> }
                      @case ('text') { <tg-markdown [animate]="last && tr.status === 'running'" class="msg-agent" [class.typing]="last && tr.status === 'running'" [text]="seg.text" /> }
                      @case ('work') {
                        <details class="worklog" [open]="seg.live" [class.live]="seg.live">
                          <summary>
                            <svg class="ic chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
                            @if (seg.live && tr.permissions.length) {
                              <span class="wait-dot" aria-hidden="true">●</span><span class="ellipsis">Chờ bạn duyệt · {{ seg.steps.at(-1)?.text }}</span>
                            } @else if (seg.live) {
                              <span class="spin" aria-hidden="true"></span><span class="ellipsis">{{ seg.steps.at(-1)?.text }}</span>
                            } @else {
                              <span>Nhật ký làm việc · {{ seg.steps.length }} bước</span>
                            }
                            @if (seg.failed) { <span class="err-text">· {{ seg.failed }} lỗi</span> }
                          </summary>
                          <ol>
                            @for (st of seg.steps; track $index) {
                              <li [attr.data-state]="st.state">
                                <span class="step-mark" aria-hidden="true">@switch (st.state) { @case ('done') { ✓ } @case ('failed') { ✕ } @case ('note') { ! } @default { <span class="spin"></span> } }</span>
                                <span class="mono ellipsis" [title]="st.text">{{ st.text }}</span>
                              </li>
                            }
                          </ol>
                        </details>
                      }
                      @case ('delegate') { <tg-delegations [parent]="tr" [only]="seg.refs" /> }
                    }
                    @if (answers()[tr.id]?.[$index]; as answer) {
                      <div class="answer-actions">
                        <button class="act-btn" [class.done]="copied() === tr.id + ':' + $index + ':plain'" (click)="copyAnswer(tr.id, $index, answer, false)">
                          @if (copied() === tr.id + ':' + $index + ':plain') { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>Đã chép } @else { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>Chép }
                        </button>
                        <button class="act-btn" [class.done]="copied() === tr.id + ':' + $index + ':md'" (click)="copyAnswer(tr.id, $index, answer, true)">
                          @if (copied() === tr.id + ':' + $index + ':md') { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>Đã chép } @else { <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>Chép Markdown }
                        </button>
                      </div>
                    }
                  }
                  <tg-delegations [parent]="tr" [except]="placed()[tr.id] ?? []" />
                  @if (turnStatus(tr) === 'failed') { <div class="turn-error" role="alert">{{ failureOf(tr) }}</div> }
                </article>
              }
              @if (quiet()) {
                <div class="chat-notice" role="status">
                  <span>Agent chưa phản hồi 30 giây. Có thể vẫn đang xử lý.</span>
                  <button class="btn ghost sm" (click)="runs.stop(r.id)">Dừng</button>
                </div>
              }
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
              @for (h of taskHandoffs(); track h.id) {
                <section class="handoff" aria-label="Đề xuất chuyển việc">
                  <div class="handoff-head"><tg-agent-avatar [agent]="h.from" [size]="18" /> {{ meta[h.from].name }} đề xuất chuyển cho <tg-agent-avatar [agent]="h.agent" [size]="18" /> <strong>{{ meta[h.agent].name }}</strong></div>
                  <p>{{ h.task }}</p>
                  @if (h.files.length) { <p class="mono dim">{{ h.files.join(', ') }}</p> }
                  <div class="permission-actions">
                    <button class="btn ghost sm" (click)="runs.dismissHandoff(h.id)">Bỏ qua</button>
                    <button class="btn primary sm" [disabled]="handoffBusy() || !hasAgent(h.agent)" [title]="hasAgent(h.agent) ? '' : 'Agent này chưa cài'" (click)="acceptHandoff(h.id)">Giao cho {{ meta[h.agent].name }}</button>
                  </div>
                </section>
              }
              <ng-container *ngTemplateOutlet="pendingMsg" />
            }
            @case ('plan') {
              @if (run()?.plan?.length) {
                <ul class="ap-plan">
                  @for (p of run()!.plan; track $index) {
                    <li [attr.data-status]="p.status">
                      <span class="plan-mark" aria-hidden="true"></span>
                      <span>{{ p.content }}</span>
                      <span class="sr-only">{{ planLabel[p.status] ?? p.status }}</span>
                    </li>
                  }
                </ul>
              } @else {
                <p class="dim">Agent chưa gửi kế hoạch cho cuộc trò chuyện này.</p>
              }
              <div class="ap-notes" aria-label="Ghi chú chung">
                <div class="label">GHI CHÚ CHUNG · TG-BRIDGE</div>
                @for (n of notes(); track $index) {
                  <article class="ap-note">
                    <div class="ap-note-head"><tg-agent-avatar [agent]="n.agent" [size]="16" /><strong>{{ n.topic }}</strong><span class="spacer"></span><span class="dim">{{ time(n.at) }}</span></div>
                    <p>{{ n.text }}</p>
                  </article>
                } @empty {
                  <p class="dim">Chưa có ghi chú. Agent ghi qua tool <code>write_note</code> của tg-bridge; mọi agent cùng việc đọc được.</p>
                }
              </div>
            }
          }
        </div>
      </div>
      <div class="chat-dock"><div class="dock-col">
        <!-- Pinned above the composer: an approval must never scroll out of sight. -->
        @if (r.permissions.length || childApprovals().length) {
          <div class="ap-approvals">
            @for (p of r.permissions; track p.requestId) { <tg-permission-card [runId]="r.id" [agent]="r.agent" [request]="p" /> }
            @for (c of childApprovals(); track c.id) {
              <p class="dim ap-child-label"><tg-agent-avatar [agent]="c.agent" [size]="14" /> {{ meta[c.agent].name }} (việc con) cần bạn duyệt:</p>
              @for (p of c.permissions; track p.requestId) { <tg-permission-card [runId]="c.id" [agent]="c.agent" [request]="p" /> }
            }
          </div>
        }
        @if (r.proposal && r.perm === 'read' && r.status !== 'running') {
          <section class="proposal-card" aria-label="Kế hoạch sửa code">
            <div class="proposal-head">
              <tg-agent-avatar [agent]="r.agent" [size]="18" />
              <strong>{{ meta[r.agent].name }} đã lên kế hoạch sửa code</strong>
              <span class="dim">· Chỉ hỏi nên chưa sửa gì</span>
            </div>
            <details><summary>Xem kế hoạch</summary><tg-markdown class="proposal-plan" [text]="r.proposal" /></details>
            <div class="permission-actions">
              <button class="btn ghost sm" (click)="runs.dismissProposal(r.id)">Không</button>
              <button class="btn primary sm" [disabled]="sending() || !!blockedForEdit()" [title]="blockedForEdit() ?? 'Chuyển sang Hỏi trước và làm theo kế hoạch'" (click)="actOnProposal(r)">Làm luôn</button>
            </div>
          </section>
        }
        @if (live(); as l) {
          <div class="live-status" role="status" [class.waiting]="l.waiting">
            <tg-agent-avatar [agent]="l.run.agent" [size]="20" />
            <strong>{{ meta[l.run.agent].name }} {{ l.verb }}</strong>
            @if (!l.waiting) { <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> }
            <span class="sep">·</span><span class="mono clock">{{ duration(l.run) }}</span>
            <span class="sep">·</span><span class="ellipsis step" [title]="l.step">{{ l.step }}</span>
            <button class="act-btn bordered" [title]="'Dừng (Esc)'" (click)="runs.stop(l.run.id)">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>Dừng<span class="kbd">Esc</span>
            </button>
          </div>
        }
        <ng-container *ngTemplateOutlet="composer" />
      </div></div>
    } @else {
      <div class="chat-scroll home">
        <div class="home-col">
          @if (!workspace.folder()) {
            <div class="hero">
              <span class="brand-mark big" aria-hidden="true">TG</span>
              <h1>Chào mừng đến TG Studio</h1>
              <p class="dim">Điều khiển các agent code đã cài trên máy bạn, trong một cửa sổ.</p>
              <button class="btn primary lg" (click)="workspace.pickFolder()">
                <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                Mở thư mục dự án…
              </button>
            </div>
          } @else if (pending()) {
            <div class="pending-col"><ng-container *ngTemplateOutlet="pendingMsg" /></div>
            <ng-container *ngTemplateOutlet="composer" />
          } @else {
            <div class="hero">
              <h1>Hôm nay làm gì với {{ projectName() }}?</h1>
              <p class="dim">
                @switch (workspace.project()?.git) {
                  @case ('ready') { <span class="ok-text">●</span> Repo Git · nhánh {{ workspace.project()!.branch ?? 'HEAD tách rời' }} }
                  @case ('no_commits') { <span class="warn-text">●</span> Repo Git chưa có commit: Sửa code cần ít nhất một commit }
                  @default { <span class="warn-text">●</span> Không phải repo Git: chỉ dùng được Chỉ hỏi }
                }
              </p>
            </div>
            <ng-container *ngTemplateOutlet="composer" />
            <div class="suggest">
              @for (s of suggestions; track s.label) {
                <button class="pill-btn" (click)="prompt.set(s.prompt)">{{ s.label }}</button>
              }
            </div>
          }
          <section class="agent-list" aria-label="Agent trên máy" [hidden]="!!pending()">
            <div class="label">AGENT TRÊN MÁY</div>
            @for (a of agents.agents(); track a.id) {
              <div class="agent-line">
                <tg-agent-avatar [agent]="a.id" [size]="26" />
                <strong>{{ a.name }}</strong>
                @if (a.version) { <span class="dim mono ellipsis">{{ a.version }}</span> }
                <span class="spacer"></span>
                @if (!a.path) {
                  <button class="btn ghost sm" [title]="meta[a.id].install" (click)="copy(meta[a.id].install)">Chép lệnh cài</button>
                } @else if (a.auth === 'none') {
                  <span class="pill" data-status="needs_you">Cần đăng nhập</span>
                } @else {
                  <span class="pill" data-status="waiting">✓ Sẵn sàng</span>
                }
              </div>
            } @empty {
              <p class="dim">{{ agents.checking() ? 'Đang dò agent…' : 'Chưa thấy agent nào.' }}</p>
            }
          </section>
        </div>
      </div>
    }
  `,
})
export class AgentPanel {
  protected readonly runs = inject(RunsService);
  protected readonly agents = inject(AgentsService);
  private readonly pipelines = inject(PipelineService);
  private readonly budget = inject(BudgetService);
  protected readonly workspace = inject(WorkspaceService);
  private readonly ui = inject(UiService);
  protected readonly threads = inject(ThreadsService);
  protected readonly meta = AGENT_META;
  protected readonly keys = KEYS;
  protected readonly tok = fmtTokens;
  protected readonly usd = fmtUsd;
  protected readonly panelTabs = [{ id: 'thread', label: 'Trò chuyện' }, { id: 'plan', label: 'Kế hoạch & ghi chú' }] as const;
  protected readonly turnLabel: Record<TurnStatus, string> = { running: 'Đang làm', needs_you: 'Chờ duyệt', waiting: 'Xong', failed: 'Lỗi', stopped: 'Đã dừng' };
  protected readonly suggestions = [
    { label: 'Giải thích dự án', prompt: 'Giải thích cấu trúc thư mục này trong 5 gạch đầu dòng.' },
    { label: 'Tìm lỗi tiềm ẩn', prompt: 'Đọc code và liệt kê 5 lỗi tiềm ẩn đáng sửa nhất, kèm vị trí tệp.' },
    { label: 'Viết test còn thiếu', prompt: 'Tìm phần code quan trọng chưa có test và viết test cho nó.' },
  ];
  protected readonly statusLabel = { running: 'đang chạy', idle: 'chờ bạn', done: 'xong', failed: 'lỗi', stopped: 'đã dừng', interrupted: 'gián đoạn' };
  protected readonly planLabel: Record<string, string> = { completed: 'xong', in_progress: 'đang làm', pending: 'chưa làm' };

  protected readonly tab = signal<'thread' | 'plan' | 'runs'>('thread');
  protected readonly run = computed(() => this.runs.selected());
  /** The selected run and, for a parallel task, the rest of its group. */
  /** What the conversation has said so far. Parallel runs are compared, so each shows alone. */
  protected readonly threadRuns = computed(() => {
    const r = this.run();
    if (!r) return [];
    if (r.group) return [r];
    // Delegated runs show nested in their parent's message, not as turns of their own.
    return this.runs.runs().filter((x) => x.thread === r.thread && !x.parent).sort((a, b) => a.startedAt - b.startedAt);
  });
  protected readonly taskRuns = computed(() => {
    const r = this.run();
    if (!r) return [];
    const group = this.runs.groupRuns(r.group);
    return group.length ? group : [r];
  });
  private noteLoads = 0;
  /** Notes reload when the Plan tab opens and whenever the task's runs change. */
  private readonly loadNotes = effect(() => {
    const id = this.run()?.id;
    if (this.tab() !== 'plan' || !id) return;
    this.run()?.lines.length;
    const ticket = ++this.noteLoads;
    // Only the latest load counts: switching conversations quickly must not show old notes.
    untracked(() => void this.runs.bridgeNotes(id).then((n) => ticket === this.noteLoads && this.notes.set(n), () => ticket === this.noteLoads && this.notes.set([])));
  });
  protected readonly taskHandoffs = computed(() => {
    const ids = new Set(this.taskRuns().map((r) => r.id));
    return this.runs.handoffs().filter((h) => ids.has(h.runId));
  });
  protected readonly handoffBusy = signal(false);
  protected readonly notes = signal<BridgeNote[]>([]);
  protected readonly pipelineOf = computed(() => this.pipelines.of(this.run()?.id));
  /** Agents this conversation delegated to that wait for an approval: pinned with the rest. */
  protected readonly childApprovals = computed(() => {
    const ids = new Set(this.threadRuns().map((r) => r.id));
    return this.runs.runs().filter((r) => r.parent && ids.has(r.parent) && r.permissions.length);
  });
  protected readonly otherApprovals = computed(() => {
    const mine = new Set(this.childApprovals().map((r) => r.id));
    return this.runs.runs().filter((r) => r.permissions.length && r.id !== this.run()?.id && !mine.has(r.id));
  });

  // Composer
  protected readonly mode = signal<Mode>('task');
  protected readonly prompt = signal('');
  protected readonly chosen = signal<AgentId | ''>('');
  /**
   * What the composer follows from the selected run. A string, so a streamed log line or
   * usage update (a new Run object) does not undo what the user just picked.
   */
  private readonly runSetup = computed(() => {
    const r = this.run();
    return r ? JSON.stringify([r.id, r.agent, r.task, r.perm ?? null, r.place ?? null]) : null;
  });
  /** A conversation keeps its agent until the user picks another. */
  private readonly followRun = effect(() => {
    if (!this.runSetup()) return;
    untracked(() => {
      const r = this.run();
      if (!r) return;
      this.chosen.set(r.agent);
      // A conversation keeps its permission and place: the next message works the same way.
      if (!r.task || r.perm === 'read') this.mode.set('read');
      else {
        if (this.mode() === 'read') this.mode.set('task');
        this.approval.set(r.perm === 'auto' ? 'auto' : 'ask');
        if (r.place) this.place.set(r.place);
      }
    });
  });
  /**
   * While the first message of a code conversation is being typed, the core opens the
   * agent's session (~5 s) so the answer starts as fast as in an open CLI. A string, so
   * the effect runs again only when agent, folder or scope change.
   */
  private readonly warmTarget = computed(() => {
    if (!this.prompt().trim() || this.mode() !== 'task' || this.effectivePlace() !== 'direct' || this.blocked()) return null;
    const agent = this.agent();
    const repo = this.workspace.folder();
    const current = this.run();
    // An open session takes the message, and a later task reuses its folder and session.
    if (!agent || !repo || (current?.task && current.perm !== 'read')) return null;
    return JSON.stringify([agent, repo, current ? current.scope : this.threads.draftScope()]);
  });
  private readonly warmUp = effect(() => {
    const target = this.warmTarget();
    if (!target) return;
    const [agent, repo, scope] = JSON.parse(target) as [AgentId, string, string | null];
    untracked(() => this.runs.warm(agent, repo, scope ?? null));
  });
  protected readonly error = signal<string | null>(null);
  /**
   * The message being sent, shown until the run it starts (or the `user` event of the
   * open session) reaches the conversation. Starting an agent takes seconds.
   */
  protected readonly pending = signal<{ text: string; agent: AgentId | null; at: number; before: string | null; sent: boolean } | null>(null);
  private readonly settlePending = effect(() => {
    const p = this.pending();
    const r = this.run();
    if (!p?.sent || !r) return;
    if (r.id !== p.before || (r.turnAt ?? 0) >= p.at) untracked(() => this.pending.set(null));
  });
  protected readonly picks = signal<AgentId[] | null>(null);
  /** Every installed agent takes every permission; questions to agents without a read-only
   * CLI flag run through ACP in a throwaway draft. */
  protected readonly choices = computed(() => this.agents.agents().filter((a) => a.path));
  /** Hỏi trước or Tự động, for code tasks. */
  protected readonly approval = signal<'ask' | 'auto'>('ask');
  protected readonly perm = computed<'read' | 'ask' | 'auto'>(() => (this.mode() === 'read' ? 'read' : this.approval()));
  /** Where a new code task works: the user's folder (default) or a draft from `base`. */
  protected readonly place = signal<Place>('direct');
  protected readonly base = signal<string | null>(null);
  protected readonly branches = signal<string[]>([]);
  /** Several agents at once always use drafts; so do questions to agents without a read-only flag. */
  protected readonly effectivePlace = computed<Place>(() => (this.team() === 'parallel' ? 'draft' : this.place()));
  /** Questions go through ACP for agents whose CLI has no verified read-only flag. */
  protected readonly readViaAcp = computed(() => {
    const a = this.agents.agents().find((x) => x.id === this.agent());
    return this.mode() === 'read' && !!a && !a.headless;
  });
  /** The picked agent only while it can work with the chosen permission (Kiro and Gemini have no Chỉ hỏi). */
  protected readonly agent = computed<AgentId | ''>(() => {
    const chosen = this.chosen();
    const fits = !!chosen && this.choices().some((a) => a.id === chosen);
    return this.mention()?.agent ?? (fits ? chosen : this.choices()[0]?.id || '');
  });
  protected readonly picked = computed(() => {
    const available = this.choices().map((a) => a.id);
    return (this.picks() ?? available).filter((id) => available.includes(id));
  });
  /** `@codex fix this` hands the task to Codex. */
  private readonly mention = computed(() => {
    const m = /^@(\w+)\s+/.exec(this.prompt());
    const id = m?.[1].toLowerCase() as AgentId | undefined;
    return id && this.choices().some((a) => a.id === id) ? { agent: id, rest: this.prompt().slice(m![0].length) } : null;
  });
  private readonly text = computed(() => (this.mention()?.rest ?? this.prompt()).trim());
  /** Why Run is disabled, in words. */
  protected readonly blocked = computed(() => {
    if (this.budget.blockReason()) return this.budget.blockReason();
    if (this.mode() === 'read' && this.run() && !this.run()!.task && this.run()!.status === 'running') return 'Agent đang trả lời. Hãy chờ, bấm Dừng, hoặc mở Trò chuyện mới.';
    if (this.mode() === 'task' && this.run()?.task && this.run()?.status === 'running') return 'Agent đang chạy. Hãy chờ, bấm Dừng, hoặc mở Trò chuyện mới.';
    if (!this.choices().length) return 'Chưa có agent nào chạy được. Cài một CLI ở cột Agents rồi bấm Dò lại.';
    if (!this.workspace.folder()) return 'Bấm Mở thư mục ở thanh trên cùng để chọn dự án.';
    if (this.mode() !== 'read' && !this.workspace.repo()) return 'Sửa code cần một repo Git: bấm Khởi tạo Git, hoặc dùng Chỉ hỏi.';
    if (this.mode() !== 'read' && this.workspace.project()?.git === 'no_commits') return 'Sửa code cần ít nhất một commit: bấm Tạo commit đầu tiên, hoặc dùng Chỉ hỏi.';
    if (this.readViaAcp() && this.workspace.project()?.git !== 'ready') return `${AGENT_META[this.agent() as AgentId].name} trả lời câu hỏi trong một bản nháp tạm, nên cần repo Git có ít nhất một commit.`;
    if (this.mode() === 'parallel' && this.picked().length < 2) return 'Cần chọn ít nhất 2 agent.';
    if (this.mode() === 'pipeline' && this.steps().some((s) => !this.choices().some((a) => a.id === s.agent))) return 'Có bước dùng agent chưa cài. Chọn agent khác cho bước đó.';
    return null;
  });
  /** The agent may still work (an API key, say), so this warns rather than blocks. */
  protected readonly loginHint = computed(() => {
    const id = this.agent();
    const found = id ? this.agents.agents().find((a) => a.id === id) : null;
    return found?.auth === 'none' ? `${found.name} có thể chưa đăng nhập. Chạy trong terminal: ${AGENT_META[found.id].login}` : null;
  });
  protected readonly gitPlan = signal<GitPlan | null>(null);
  protected readonly gitBusy = signal(false);
  protected readonly gitName = signal('');
  protected readonly gitEmail = signal('');
  protected readonly dirtyWarning = signal<number | null>(null);
  private readonly backend = inject(AgentBackend);
  private dirtyAccepted = false;
  /** The button that makes this folder usable for code tasks, if it needs one. */
  protected readonly needsGit = computed(() => {
    const project = this.workspace.project();
    if (!project || this.mode() === 'read') return null;
    return project.git === 'none' ? 'Khởi tạo Git…' : project.git === 'no_commits' ? 'Tạo commit đầu tiên…' : null;
  });

  // Chat timeline
  protected readonly segments = computed(() => {
    const out: Record<string, Segment[]> = {};
    for (const r of this.threadRuns()) out[r.id] = segmentsOf(r.lines, r.status === 'running');
    return out;
  });
  /** Delegations shown where they were made, so the block at the end of a run skips them. */
  protected readonly placed = computed(() => {
    const out: Record<string, (string | number)[]> = {};
    for (const [id, segs] of Object.entries(this.segments())) out[id] = segs.flatMap((s) => (s.kind === 'delegate' ? s.refs : []));
    return out;
  });
  /** What the selected run is doing right now, for the status line above the composer. */
  protected readonly live = computed(() => {
    const r = this.run();
    if (!r || r.status !== 'running') return null;
    const last = (this.segments()[r.id] ?? []).at(-1);
    const waiting = r.permissions.length > 0;
    let step = 'đang suy nghĩ…';
    if (waiting) step = `chờ bạn duyệt: ${r.permissions[0].toolCall.title ?? 'một thao tác'}`;
    else if (r.progress) step = r.progress.step;
    else if (last?.kind === 'work') step = last.steps.at(-1)?.text ?? step;
    else if (last?.kind === 'text') step = 'đang viết câu trả lời…';
    return { run: r, waiting, step, verb: waiting ? 'đang chờ bạn' : r.task && r.perm !== 'read' ? 'đang làm' : 'đang trả lời' };
  });
  /** Where each finished answer ends (the text since the last user message), keyed by run, then segment. */
  protected readonly answers = computed(() => {
    const out: Record<string, Record<number, string>> = {};
    for (const r of this.threadRuns()) {
      const segs = this.segments()[r.id] ?? [];
      const ends: Record<number, string> = {};
      let texts: string[] = [];
      segs.forEach((seg, i) => {
        if (seg.kind === 'user') texts = [];
        if (seg.kind !== 'text') return;
        texts.push(seg.text);
        const next = segs.slice(i + 1).find((x) => x.kind !== 'work' && x.kind !== 'delegate');
        const finished = next ? next.kind === 'user' : r.status !== 'running';
        if (finished && (!next || next.kind === 'user')) {
          ends[i] = texts.join('\n\n');
          texts = [];
        }
      });
      out[r.id] = ends;
    }
    return out;
  });
  protected readonly copied = signal<string | null>(null);

  protected async copyAnswer(runId: string, index: number, markdown: string, asMarkdown: boolean): Promise<void> {
    if (!(await copyText(asMarkdown ? markdown : plainText(markdown)))) return;
    const key = `${runId}:${index}:${asMarkdown ? 'md' : 'plain'}`;
    this.copied.set(key);
    setTimeout(() => this.copied() === key && this.copied.set(null), 1500);
  }

  protected readonly projectName = computed(() => this.workspace.project()?.name ?? this.workspace.folder().split(/[\\/]/).filter(Boolean).at(-1) ?? '');

  protected permLabel(r: Run): string {
    if (!r.task || r.perm === 'read') return 'Chỉ hỏi';
    const where = r.place === 'direct' ? 'thư mục hiện tại' : 'bản nháp';
    return `${r.perm === 'auto' ? 'Tự động' : 'Sửa code'} · ${where}`;
  }

  protected turnStatus(r: Run): TurnStatus {
    if (r.permissions.length) return 'needs_you';
    if (r.status === 'running') return 'running';
    // An open session waits after every turn; how that turn ended still shows.
    if (r.status === 'failed' || r.lastTurn === 'failed') return 'failed';
    if (r.status === 'stopped' || r.status === 'interrupted' || r.lastTurn === 'stopped') return 'stopped';
    return 'waiting';
  }

  protected failureOf(r: Run): string {
    const last = [...r.lines].reverse().find((l) => l.tone === 'error');
    return last?.text ?? 'Lượt chạy thất bại. Xem chi tiết ở Cài đặt → Chẩn đoán.';
  }

  protected async copy(text: string): Promise<void> {
    await copyText(text); // if it fails, the command is still in the tooltip
  }

  // Composer menus: who works (agent, model, team) and what it may do (permission).
  protected readonly menu = signal<'agent' | 'perm' | 'place' | null>(null);
  protected readonly team = computed<'single' | 'parallel' | 'pipeline'>(() => (this.mode() === 'parallel' ? 'parallel' : this.mode() === 'pipeline' ? 'pipeline' : 'single'));

  protected toggleMenu(which: 'agent' | 'perm' | 'place'): void {
    const opening = this.menu() !== which;
    this.menu.set(opening ? which : null);
    if (opening && which === 'place') void this.loadBranches();
    const a = this.agent();
    if (opening && which === 'agent' && a) void this.agents.loadOptions(a, this.workspace.folder());
  }

  /** Ctrl/⌘+Shift+M opens the agent and model picker. */
  @HostListener('window:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      this.toggleMenu('agent');
    } else if (e.key === 'Escape' && this.menu()) {
      this.menu.set(null);
    } else if (e.key === 'Escape' && this.run()?.status === 'running' && !(e.target as HTMLElement | null)?.closest('input, .repo-edit')) {
      // Esc stops the agent, as the status line says.
      e.preventDefault();
      void this.runs.stop(this.run()!.id);
    }
  }

  protected usable(id: AgentId): boolean {
    return !!this.agents.agents().find((x) => x.id === id)?.path;
  }

  protected pickAgent(id: AgentId): void {
    this.chosen.set(id);
    if (this.team() !== 'single') this.mode.set('task');
    void this.agents.loadOptions(id, this.workspace.folder());
  }

  protected setTeam(team: 'parallel' | 'pipeline'): void {
    this.mode.set(team);
  }

  protected setPerm(perm: 'read' | 'ask' | 'auto'): void {
    if (perm === 'read') this.mode.set('read');
    else {
      if (this.mode() === 'read') this.mode.set('task');
      this.approval.set(perm);
    }
    this.menu.set(null);
  }

  protected setPlace(place: Place, base: string | null = null): void {
    this.place.set(place);
    this.base.set(place === 'draft' ? base : null);
    this.menu.set(null);
  }

  protected async loadBranches(): Promise<void> {
    const repo = this.workspace.repo()?.root;
    if (!repo) return;
    try {
      this.branches.set(await this.backend.listBranches(repo));
    } catch {
      this.branches.set([]);
    }
  }

  protected optionsState(a: AgentId): 'loading' | 'error' | 'none' | 'ok' {
    const o = this.agents.options()[a];
    if (o === 'loading' || o === undefined) return 'loading';
    if (o === 'error') return 'error';
    return o.model ? 'ok' : 'none';
  }

  protected retryOptions(a: AgentId): void {
    void this.agents.loadOptions(a, this.workspace.folder());
  }

  protected modelOptions(a: AgentId): ConfigChoice[] {
    const o = this.agents.options()[a];
    return o && typeof o === 'object' ? (o.model?.options ?? []) : [];
  }

  protected effortOptions(a: AgentId): ConfigChoice[] {
    const o = this.agents.options()[a];
    return o && typeof o === 'object' ? (o.effort?.options ?? []) : [];
  }

  protected currentModel(a: AgentId): string {
    const o = this.agents.options()[a];
    return this.agents.prefs()[a]?.model ?? (o && typeof o === 'object' ? (o.model?.current ?? '') : '');
  }

  protected currentEffort(a: AgentId): string {
    const o = this.agents.options()[a];
    return this.agents.prefs()[a]?.effort ?? (o && typeof o === 'object' ? (o.effort?.current ?? '') : '');
  }

  protected effortLabel(o: ConfigChoice): string {
    return EFFORT_VI[o.value] ?? o.name;
  }

  protected async planGit(): Promise<void> {
    await this.gitAction(async () => this.gitPlan.set(await this.backend.gitPlan(this.workspace.folder())));
  }

  protected async prepareGit(): Promise<void> {
    await this.gitAction(async () => {
      this.workspace.applyProject(await this.backend.gitPrepare(this.workspace.folder(), this.gitName() || null, this.gitEmail() || null));
      this.gitPlan.set(null);
    });
  }

  private async gitAction(work: () => Promise<void>): Promise<void> {
    this.gitBusy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.gitBusy.set(false);
    }
  }

  protected sendAnyway(): Promise<void> {
    this.dirtyAccepted = true;
    this.dirtyWarning.set(null);
    return this.send();
  }

  /** What this conversation's agent has changed and is waiting on the user. */
  protected readonly changed = computed(() => {
    const r = this.run();
    if (!r?.task || r.perm === 'read' || r.status === 'running') return null;
    const files = this.workspace.diffs()[r.id] ?? [];
    if (!files.length) return null;
    const hunks = files.flatMap((f) => f.hunks);
    return { files: files.length, list: files, added: hunks.reduce((n, h) => n + h.added, 0), removed: hunks.reduce((n, h) => n + h.removed, 0) };
  });
  protected readonly scopeShown = computed(() => {
    const r = this.run();
    return r ? r.scope : this.threads.draftScope();
  });
  protected readonly quiet = computed(() => {
    const r = this.run();
    return !!r && isQuiet(r, this.runs.lastEvent()[r.id], this.runs.now());
  });
  protected readonly placeholder = computed(() => {
    const r = this.run();
    if (this.mode() === 'read' && r && !r.task && r.status !== 'running') return `Hỏi tiếp ${AGENT_META[r.agent].name}… (Enter để gửi, Shift+Enter để xuống dòng)`;
    if (this.mode() === 'task' && r?.task && r.status !== 'running') return `Nhắn tiếp cho ${AGENT_META[r.agent].name}, hoặc @mention agent khác… (Enter để gửi, Shift+Enter để xuống dòng)`;
    return 'Giao việc, hỏi, hoặc @mention agent… (Enter để gửi, Shift+Enter để xuống dòng)';
  });
  protected readonly sending = signal(false);
  protected readonly canRun = computed(() => !this.blocked() && !!this.text() && !this.sending());

  // Pipeline steps, remembered for the next task.
  protected readonly editSteps = signal(false);
  private readonly savedSteps = signal<PipelineStep[] | null>(loadSteps());
  protected readonly steps = computed<PipelineStep[]>(() => {
    const saved = this.savedSteps();
    if (saved) return saved;
    const ids = this.choices().map((a) => a.id);
    const pick = (i: number): AgentId => (ids[i % Math.max(ids.length, 1)] ?? 'claude') as AgentId;
    return [
      { name: 'Plan', agent: pick(0), template: DEFAULT_TEMPLATES.plan },
      { name: 'Build', agent: pick(1), template: DEFAULT_TEMPLATES.build },
      { name: 'Review', agent: pick(2), template: DEFAULT_TEMPLATES.review },
    ];
  });

  protected setStep(i: number, change: Partial<PipelineStep>): void {
    const next = this.steps().map((s, j) => (j === i ? { ...s, ...change } : s));
    this.savedSteps.set(next);
    try {
      localStorage.setItem(PIPELINE_KEY, JSON.stringify(next));
    } catch {
      /* remembered for this session only */
    }
  }

  protected resetSteps(): void {
    this.savedSteps.set(null);
    try {
      localStorage.removeItem(PIPELINE_KEY);
    } catch {
      /* nothing saved */
    }
  }

  protected stepState(p: { runIds: (string | null)[]; current: number; status: string }, i: number): string {
    const id = p.runIds[i];
    const run = id ? this.runs.runs().find((r) => r.id === id) : null;
    if (!run) return i < p.current ? 'done' : 'pending';
    return run.status === 'running' ? 'running' : run.status === 'done' ? 'done' : 'failed';
  }

  protected hasAgent(id: AgentId): boolean {
    return this.agents.agents().some((a) => a.id === id && a.path);
  }

  protected async acceptHandoff(id: string): Promise<void> {
    const repo = this.workspace.repo()?.root ?? this.run()?.cwd ?? '';
    this.handoffBusy.set(true);
    this.error.set(null);
    try {
      await this.runs.acceptHandoff(id, repo);
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.handoffBusy.set(false);
    }
  }

  protected time(ms: number): string {
    return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(ms);
  }

  protected costOf(r: Run): number | null {
    return r.usage ? (r.usage.costUsd ?? estimateCost(r.agent, r.usage, r.startedAt)) : null;
  }

  protected duration(r: Run): string {
    return fmtDuration(Math.max(0, (r.endedAt ?? this.runs.now()) - turnStart(r)));
  }

  protected toggle(id: AgentId): void {
    const now = this.picked();
    this.picks.set(now.includes(id) ? now.filter((a) => a !== id) : [...now, id]);
  }

  protected review(runId: string): void {
    this.ui.openRun(runId, 'changes');
  }

  protected onEnter(e: KeyboardEvent): void {
    // Enter while a Vietnamese input method is composing only commits the word.
    if (e.shiftKey || e.isComposing) return;
    e.preventDefault();
    void this.send();
  }

  // Skills and commands: "/" at the start of the message, or "$" for Codex.
  private readonly promptBox = viewChild<ElementRef<HTMLTextAreaElement>>('promptBox');
  protected readonly caret = signal(0);
  protected readonly groupLabel = GROUP_LABEL;
  private readonly cmdIndex = signal(0);
  /** Closed with Esc until the typed word changes. */
  private readonly cmdDismissed = signal<string | null>(null);
  private readonly cmdQuery = computed(() => commandQuery(this.prompt(), this.caret(), this.agent()));
  protected readonly cmdMenu = computed(() => {
    const q = this.cmdQuery();
    const agent = this.agent();
    if (!q || !agent || this.cmdDismissed() === `${q.start}:${q.query}`) return null;
    const list = this.agents.commandsFor(agent, this.workspace.folder());
    const name = AGENT_META[agent].name;
    if (list === null || list === 'loading') return { agent: name, query: q.query, loading: true, groups: [], active: null as AgentCommand | null };
    const groups = filterCommands(list, q);
    const flat = groups.flatMap((g) => g.items);
    const active = flat.length ? flat[Math.min(this.cmdIndex(), flat.length - 1)] : null;
    return { agent: name, query: q.query, loading: false, groups, active, flat };
  });
  /** The list is read the first time the user asks for it, not on every folder opened. */
  private readonly cmdLoad = effect(() => {
    const agent = this.agent();
    if (!this.cmdQuery() || !agent) return;
    const folder = this.workspace.folder();
    untracked(() => void this.agents.loadCommands(agent, folder));
  });

  protected onInput(box: HTMLTextAreaElement): void {
    this.prompt.set(box.value);
    this.caret.set(box.selectionStart);
    this.cmdIndex.set(0);
  }

  protected onKeyUp(e: KeyboardEvent): void {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) this.caret.set((e.target as HTMLTextAreaElement).selectionStart);
  }

  protected onKeyDown(e: KeyboardEvent): void {
    const menu = this.cmdMenu();
    const flat = menu && !menu.loading ? menu.flat ?? [] : [];
    if (menu && !e.isComposing) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const q = this.cmdQuery()!;
        this.cmdDismissed.set(`${q.start}:${q.query}`);
        return;
      }
      if (flat.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const i = flat.indexOf(menu.active!);
        this.cmdIndex.set((i + (e.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length);
        return;
      }
      if (menu.active && ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')) {
        e.preventDefault();
        this.pickCommand(menu.active);
        return;
      }
    }
    if (e.key === 'Enter') this.onEnter(e);
  }

  protected pickCommand(c: AgentCommand): void {
    const q = this.cmdQuery();
    if (!q) return;
    const done = insertCommand(this.prompt(), this.caret(), q, c);
    this.prompt.set(done.text);
    this.caret.set(done.caret);
    const box = this.promptBox()?.nativeElement;
    if (box) {
      box.value = done.text;
      box.focus();
      box.setSelectionRange(done.caret, done.caret);
    }
  }

  protected newChat(): void {
    this.runs.selectedId.set(null);
    this.threads.draftScope.set(null);
    this.chosen.set('');
    this.prompt.set('');
    this.error.set(null);
  }

  protected async send(): Promise<void> {
    if (!this.canRun()) return;
    const agent = this.agent();
    const text = this.text();
    const cwd = this.workspace.folder();
    this.error.set(null);
    this.sending.set(true);
    let typed: string | null = null;
    try {
      const current = this.run();
      const perm = this.perm();
      const approval: Approval = perm === 'read' ? 'deny' : perm;
      const place = this.effectivePlace();
      const base = place === 'draft' ? this.base() : null;
      // Only a new draft starts from the latest commit; warn once per decision.
      const newDraft = this.mode() !== 'read' && place === 'draft' && !current?.task;
      if (newDraft && !this.dirtyAccepted) {
        await this.workspace.reloadProject();
        const dirty = this.workspace.project()?.uncommitted ?? 0;
        if (dirty > 0) {
          this.dirtyWarning.set(dirty);
          return;
        }
      }
      this.dirtyAccepted = false;
      typed = this.prompt();
      this.prompt.set('');
      this.pending.set({ text, agent: this.team() === 'single' && agent ? agent : null, at: Date.now(), before: current?.id ?? null, sent: false });
      if (this.mode() === 'pipeline') {
        const started = await this.pipelines.start(text, cwd, this.steps(), { place, base, approval });
        // No run exists yet to show this in the thread, and the prompt must not be lost.
        if (started.status === 'failed') {
          this.error.set(started.error);
          this.restore(typed);
          return;
        }
      } else if (this.mode() === 'parallel') {
        const failed = await this.runs.startParallel(this.picked(), text, cwd, this.threads.draftScope(), { base, approval });
        if (failed.length) this.error.set(`Không chạy được: ${failed.join('; ')}`);
      } else if (agent) {
        // Switching agent or permission keeps the conversation: same thread, with a recap.
        const thread = current?.thread;
        const recap = current ? recapOf(current) : undefined;
        const scope = current ? current.scope : this.threads.draftScope();
        const liveSession = current?.task && current.agent === agent && current.status === 'idle';
        // A question's throwaway draft must never receive edits: leaving Chỉ hỏi starts afresh.
        const leavingThrowaway = current?.perm === 'read' && perm !== 'read';
        if (liveSession && !leavingThrowaway && (perm !== 'read' || current!.perm === 'read' || this.readViaAcp())) {
          // The open session takes the message; only its approval mode changes.
          if (current!.perm !== perm) await this.runs.setApproval(current!.id, approval);
          await this.runs.sendMessage(current!.id, text);
        } else if (perm === 'read' && !this.readViaAcp() && current && !current.task && current.agent === agent && current.status === 'idle') {
          // Claude's Chỉ hỏi process is still open: the question goes straight to it. It may
          // have just closed (idle limit, crash) before its exit reached the UI: resume instead.
          try {
            await this.runs.sendMessage(current.id, text);
          } catch (e) {
            if (!(errorText(e)).includes('đã đóng')) throw e;
            await this.runs.start(agent, text, cwd, thread, current.id, scope, null);
          }
        } else if (perm === 'read' && !this.readViaAcp()) {
          // Read-only CLI run on the real folder; the core resumes this agent's CLI session.
          const resumable = current && !current.task && current.agent === agent && current.status !== 'running' ? current : null;
          await this.runs.start(agent, text, cwd, thread, resumable?.id ?? null, scope, resumable || !current ? null : (recap ?? null));
        } else {
          // A code task (or an ACP question). An earlier code task's draft or folder is reused.
          const reuse = current?.task && current.perm !== 'read' && perm !== 'read' ? current.id : undefined;
          await this.runs.startTask(agent, text, cwd, { reuse, recap, thread, scope, place, base, approval });
        }
      }
      this.tab.set('thread');
      const sent = this.pending();
      if (sent) {
        this.pending.set({ ...sent, sent: true });
        // An agent that never reports the turn must not leave the message hanging.
        setTimeout(() => { if (this.pending()?.at === sent.at) this.pending.set(null); }, 4000);
      }
    } catch (e) {
      this.error.set(errorText(e));
      this.restore(typed);
    } finally {
      this.sending.set(false);
    }
  }

  /** Why the plan cannot be carried out here (code tasks need a Git repo with a commit). */
  protected blockedForEdit(): string | null {
    if (!this.workspace.repo()) return 'Sửa code cần một repo Git.';
    if (this.workspace.project()?.git === 'no_commits') return 'Sửa code cần ít nhất một commit.';
    return null;
  }

  /** Yes to a Chỉ hỏi plan: the conversation moves to Hỏi trước and the agent carries it out. */
  protected async actOnProposal(r: Run): Promise<void> {
    if (!r.proposal) return;
    this.chosen.set(r.agent);
    this.setPerm('ask');
    this.prompt.set(`Làm theo kế hoạch đã đề xuất:\n\n${r.proposal}`);
    await this.send();
  }

  /** A failed send gives the words back, unless the user already typed something new. */
  private restore(typed: string | null): void {
    this.pending.set(null);
    if (typed !== null && !this.prompt().trim()) this.prompt.set(typed);
  }
}

function loadSteps(): PipelineStep[] | null {
  try {
    const raw = localStorage.getItem(PIPELINE_KEY);
    const steps = raw ? (JSON.parse(raw) as PipelineStep[]) : null;
    return Array.isArray(steps) && steps.every((s) => s && typeof s.name === 'string' && typeof s.template === 'string') ? steps : null;
  } catch {
    return null;
  }
}
