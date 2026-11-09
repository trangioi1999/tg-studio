import {
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { AgentBackend } from '../core/backend';
import { AgentId, McpServer, NameValue, Skill, SkillTarget } from '../core/protocol';
import { AGENT_IDS, AGENT_META } from '../agents/agent-meta';
import { AgentsService } from '../core/agents.service';
import { WorkspaceService } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';
import { errorText } from '../shared/errors';

const EMPTY: McpServer = {
  id: '',
  name: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: [],
  url: '',
  headers: [],
  agents: ['claude'],
};

const SKILL_TEMPLATE = `---
name: ten-skill
description: Một câu nói khi nào agent nên dùng skill này.
---

# Hướng dẫn

- Bước 1
`;

/** MCP servers (enabled once, handed to every agent's sessions) and the SKILL.md library. */
@Component({
  selector: 'tg-integrations',
  imports: [AgentAvatar],
  template: `
    <div class="conn-page">
      <header class="pg-head">
        <div>
          <h1>Kết nối</h1>
          <p>
            Công cụ và kỹ năng TG Studio đưa vào phiên của agent, không sửa file cấu hình của agent.
          </p>
        </div>
        <div class="conn-actions">
          @if (tab() === 'skills') {
            <button class="btn" (click)="rescan()">↻ Đọc lại</button>
          }
          <button
            class="btn primary"
            (click)="tab() === 'mcp' ? preset('custom') : editSkill(skillTemplate)"
          >
            {{ tab() === 'mcp' ? '＋ Thêm server' : '＋ Thêm skill' }}
          </button>
        </div>
      </header>
      <nav class="pg-tabs" role="tablist" aria-label="Loại kết nối">
        <button
          id="conn-mcp-tab"
          role="tab"
          aria-controls="conn-mcp"
          [attr.aria-selected]="tab() === 'mcp'"
          (click)="tab.set('mcp')"
        >
          MCP server <span class="pg-count">{{ servers().length }}</span>
        </button>
        <button
          id="conn-skills-tab"
          role="tab"
          aria-controls="conn-skills"
          [attr.aria-selected]="tab() === 'skills'"
          (click)="tab.set('skills')"
        >
          Skill <span class="pg-count">{{ skills().length }}</span>
        </button>
      </nav>
      @if (tab() === 'mcp') {
        <section id="conn-mcp" role="tabpanel" aria-labelledby="conn-mcp-tab">
          <div class="pg-card conn-bridge">
            <div class="conn-bridge-icon" aria-hidden="true">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
              >
                <path d="M3 17c3-6 15-6 18 0M6 13.5V17M12 11.5V17M18 13.5V17M2 17h20" />
              </svg>
            </div>
            <div class="conn-grow">
              <h2>tg-bridge <span class="tag ok">Tích hợp sẵn</span></h2>
              <div class="dim" title="Chỉ nghe trên 127.0.0.1, mỗi task một token riêng">
                Kênh phối hợp giữa các agent. Tool có tác động đều phải qua bạn duyệt.
              </div>
              <div class="conn-chips">
                @for (tool of bridgeTools; track tool.name) {
                  <span class="conn-tool mono" [title]="tool.description">{{ tool.name }}</span>
                }
              </div>
            </div>
            <div class="conn-bridge-switch">
              <div class="conn-row">
                <span>Bật cho task Sửa code</span
                ><button
                  class="switch"
                  role="switch"
                  aria-label="Bật cho task Sửa code"
                  [attr.aria-checked]="bridgeOn()"
                  [disabled]="busy()"
                  (click)="setBridge(!bridgeOn())"
                ></button>
              </div>
              <span class="dim">Áp dụng cho lượt chạy mới</span>
            </div>
          </div>
          <div class="conn-section-head">
            <h2>Server của bạn</h2>
            <span
              class="dim"
              title="stdio chạy với mọi agent qua ACP và Claude ở chế độ Chỉ đọc; http chỉ gửi khi agent hỗ trợ, nếu không sẽ ghi log bỏ qua. Biến môi trường và header lưu trong máy này, không mã hoá."
              >stdio chạy lệnh · http khi agent hỗ trợ · lưu cục bộ, không mã hoá</span
            >
          </div>
          @if (!servers().length) {
            <p class="dim">Chưa có server nào. Chọn mẫu bên dưới để thêm công cụ cho agent.</p>
          }
          <div class="conn-servers">
            @for (s of servers(); track s.id) {
              <article class="pg-card conn-server">
                <div class="conn-row">
                  <span class="conn-initials">{{ s.name.slice(0, 2).toUpperCase() }}</span>
                  <div class="conn-grow">
                    <strong>{{ s.name }}</strong>
                    <div class="dim">
                      {{ s.transport }} ·
                      {{
                        s.transport === 'stdio'
                          ? s.env.length + ' biến môi trường'
                          : s.headers.length + ' header'
                      }}
                    </div>
                  </div>
                  <button
                    class="btn sm"
                    (click)="edit(s)"
                    [attr.aria-label]="'Sửa server ' + s.name"
                  >
                    Sửa
                  </button>
                </div>
                <div class="conn-command mono" [title]="target(s)">{{ target(s) }}</div>
                <div class="conn-chips">
                  @for (a of agents; track a) {
                    <button
                      class="fchip conn-agent"
                      [attr.aria-pressed]="s.agents.includes(a)"
                      [attr.aria-label]="s.name + ' cho ' + meta[a].name"
                      [disabled]="busy()"
                      (click)="toggle(s, a)"
                    >
                      <tg-agent-avatar [agent]="a" [size]="14" />{{ meta[a].name }}
                    </button>
                  }
                </div>
                @if (confirming() === 'server:' + s.id) {
                  <div class="conn-confirm" role="group" [attr.aria-label]="'Xoá ' + s.name">
                    <span>Xoá server này?</span
                    ><button class="btn sm" (click)="confirming.set(null)">Huỷ</button
                    ><button class="btn sm conn-danger" [disabled]="busy()" (click)="remove(s)">
                      Xoá
                    </button>
                  </div>
                } @else {
                  <button class="btn sm conn-delete" (click)="confirming.set('server:' + s.id)">
                    Xoá
                  </button>
                }
              </article>
            }
            <article class="pg-card conn-server conn-add">
              <button class="conn-add-button" (click)="preset('custom')">
                <span aria-hidden="true">＋</span>Thêm server
              </button>
              <div class="conn-chips">
                @for (p of presets; track p.id) {
                  <button class="fchip" (click)="preset(p.id)">{{ p.label }}</button>
                }
              </div>
            </article>
          </div>
        </section>
      } @else {
        <section id="conn-skills" role="tabpanel" aria-labelledby="conn-skills-tab">
          <div class="conn-filters">
            <div class="conn-chips">
              @for (f of filters; track f.id) {
                <button
                  class="fchip"
                  [attr.aria-pressed]="skillFilter() === f.id"
                  (click)="skillFilter.set(f.id)"
                >
                  {{ f.label }}
                </button>
              }
            </div>
            <span class="dim">{{
              folderName()
                ? 'Dự án: ' + folderName() + ' · đọc từ agent, không tốn token'
                : 'Mở một thư mục để xem skill của dự án.'
            }}</span>
          </div>
          <div class="pg-card conn-skills">
            <div class="conn-skill-row conn-skill-head">
              <span>Skill</span>
              @for (a of skillAgents; track a) {
                <div class="conn-row">
                  <tg-agent-avatar [agent]="a" [size]="16" />{{ meta[a].name }}
                  @if (loading(a)) {
                    <span class="dim"><span class="spin"></span> đang đọc…</span>
                  }
                </div>
              }
              <span></span>
            </div>
            @for (row of skillRows(); track row.name) {
              <div class="conn-skill-row" [class.conn-seen-only]="!row.library">
                <div>
                  <strong class="mono">{{ row.name }}</strong>
                  <p class="conn-description dim">{{ row.description }}</p>
                </div>
                @for (a of skillAgents; track a) {
                  <div class="conn-chips conn-skill-status" [attr.aria-label]="meta[a].name">
                    @if (row.visible.includes(a)) {
                      <span class="tag ok">● đang thấy</span>
                    }
                    @if (row.library; as k) {
                      @if (a === 'claude') {
                        @for (t of targets()[k.name] ?? []; track t.scope) {
                          @if (t.state === 'same') {
                            <span class="tag ok" [title]="t.path"
                              >✓ {{ t.scope === 'project' ? 'repo' : 'máy' }}</span
                            >
                          } @else {
                            <button
                              class="btn sm"
                              [class.conn-update]="t.state === 'different'"
                              [title]="t.path"
                              [disabled]="busy()"
                              (click)="install(k, t)"
                            >
                              {{ t.state === 'different' ? '↑ cập nhật ' : 'Cài vào '
                              }}{{ t.scope === 'project' ? 'repo' : 'máy' }}
                            </button>
                          }
                        }
                        @if (!targets()[k.name]?.length) {
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
                    @if (confirming() === 'skill:' + k.name) {
                      <div
                        class="conn-confirm"
                        role="group"
                        [attr.aria-label]="'Xoá skill ' + k.name"
                      >
                        <span>Xoá skill?</span
                        ><button class="btn sm" (click)="confirming.set(null)">Huỷ</button
                        ><button
                          class="btn sm conn-danger"
                          [disabled]="busy()"
                          (click)="removeSkill(k)"
                        >
                          Xoá
                        </button>
                      </div>
                    } @else {
                      <button class="btn sm" (click)="editSkill(k.content)">Sửa</button
                      ><button class="btn sm" (click)="confirming.set('skill:' + k.name)">
                        Xoá
                      </button>
                    }
                  }
                </div>
              </div>
            } @empty {
              <p class="conn-empty dim">
                {{
                  skillFilter() === 'library'
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
      }
    </div>
    @if (draft(); as d) {
      <div class="sheet-backdrop" (click)="closeDrawer()">
        <form
          class="sheet conn-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="conn-server-title"
          (click)="$event.stopPropagation()"
          (keydown)="trapFocus($event)"
          (submit)="$event.preventDefault(); save()"
        >
          <div class="sheet-head">
            <h3 id="conn-server-title">{{ d.id ? 'Sửa MCP server' : 'Thêm MCP server' }}</h3>
            <span class="spacer"></span
            ><button
              type="button"
              class="icon-btn"
              aria-label="Đóng ngăn kéo"
              (click)="closeDrawer()"
            >
              ×
            </button>
          </div>
          <div class="conn-segment" role="group" aria-label="Kiểu kết nối">
            <button
              type="button"
              [attr.aria-pressed]="d.transport === 'stdio'"
              (click)="patch({ transport: 'stdio' })"
            >
              stdio · chạy lệnh</button
            ><button
              type="button"
              [attr.aria-pressed]="d.transport === 'http'"
              (click)="patch({ transport: 'http' })"
            >
              http · URL
            </button>
          </div>
          <label class="field"
            >Tên<input
              #drawerFocus
              class="mono"
              [value]="d.name"
              (input)="patch({ name: $any($event.target).value })"
              required
          /></label>
          @if (d.transport === 'stdio') {
            <label class="field"
              >Lệnh<input
                class="mono"
                [value]="d.command ?? ''"
                (input)="patch({ command: $any($event.target).value })"
                placeholder="npx"
            /></label>
            <label class="field"
              >Tham số (mỗi dòng một tham số)<textarea
                class="mono"
                rows="3"
                [value]="d.args.join('\\n')"
                (input)="patch({ args: lines($any($event.target).value) })"
              ></textarea>
            </label>
          } @else {
            <label class="field"
              >URL<input
                class="mono"
                [value]="d.url ?? ''"
                (input)="patch({ url: $any($event.target).value })"
                placeholder="https://…/mcp"
            /></label>
          }
          <div class="field">
            <span>{{ d.transport === 'stdio' ? 'Biến môi trường' : 'Header' }}</span>
            @for (
              pair of d.transport === 'stdio' ? d.env : d.headers;
              track $index;
              let i = $index
            ) {
              <div class="conn-pair">
                <input
                  class="mono"
                  aria-label="Tên biến hoặc header"
                  placeholder="Tên"
                  [value]="pair.name"
                  (input)="patchPair(i, { name: $any($event.target).value })"
                /><input
                  [type]="d.transport === 'stdio' ? 'password' : 'text'"
                  aria-label="Giá trị"
                  placeholder="Giá trị"
                  autocomplete="off"
                  [value]="pair.value"
                  (input)="patchPair(i, { value: $any($event.target).value })"
                /><button
                  class="icon-btn"
                  type="button"
                  [attr.aria-label]="'Xoá dòng ' + (i + 1)"
                  (click)="removePair(i)"
                >
                  ×
                </button>
              </div>
            }
            <button type="button" class="btn sm conn-pair-add" (click)="addPair()">
              {{ d.transport === 'stdio' ? '＋ Thêm biến' : '＋ Thêm header' }}
            </button>
          </div>
          <div class="field">
            <span>Bật cho</span>
            <div class="conn-chips">
              @for (a of agents; track a) {
                <button
                  type="button"
                  class="fchip"
                  [attr.aria-pressed]="d.agents.includes(a)"
                  (click)="patch({ agents: flip(d.agents, a) })"
                >
                  <tg-agent-avatar [agent]="a" [size]="14" />{{ meta[a].name }}
                </button>
              }
            </div>
          </div>
          <p class="dim">ⓘ Lưu trong máy này, không mã hoá.</p>
          <div class="sheet-foot">
            <span class="spacer"></span
            ><button class="btn" type="button" (click)="closeDrawer()">Huỷ</button
            ><button class="btn primary" type="submit" [disabled]="busy()">Lưu server</button>
          </div>
        </form>
      </div>
    }
    @if (skillDraft() !== null) {
      <div class="sheet-backdrop" (click)="closeDrawer()">
        <form
          class="sheet conn-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="conn-skill-title"
          (click)="$event.stopPropagation()"
          (keydown)="trapFocus($event)"
          (submit)="$event.preventDefault(); saveSkill()"
        >
          <div class="sheet-head">
            <h3 id="conn-skill-title">Chỉnh sửa skill</h3>
            <span class="spacer"></span
            ><button
              type="button"
              class="icon-btn"
              aria-label="Đóng ngăn kéo"
              (click)="closeDrawer()"
            >
              ×
            </button>
          </div>
          <label class="field conn-skill-editor"
            >SKILL.md<textarea
              #drawerFocus
              class="mono"
              rows="20"
              [value]="skillDraft()"
              (input)="skillDraft.set($any($event.target).value)"
            ></textarea>
          </label>
          <div class="sheet-foot">
            <span class="spacer"></span
            ><button class="btn" type="button" (click)="closeDrawer()">Huỷ</button
            ><button class="btn primary" type="submit" [disabled]="busy()">Lưu skill</button>
          </div>
        </form>
      </div>
    }
    <div class="conn-toasts">
      @if (error()) {
        <div class="conn-toast conn-toast-error" role="alert">
          <span>{{ error() }}</span
          ><button class="icon-btn" aria-label="Đóng thông báo lỗi" (click)="error.set(null)">
            ×
          </button>
        </div>
      }
      @if (info()) {
        <div class="conn-toast" role="status">
          <span>{{ info() }}</span
          ><button class="icon-btn" aria-label="Đóng thông báo" (click)="info.set(null)">×</button>
        </div>
      }
    </div>
  `,
})
export class Integrations implements OnInit {
  private readonly backend = inject(AgentBackend);
  private readonly workspace = inject(WorkspaceService);
  protected readonly meta = AGENT_META;
  protected readonly agents = AGENT_IDS;
  protected readonly tab = signal<'mcp' | 'skills'>('mcp');
  protected readonly skillFilter = signal<'all' | 'library' | 'seen'>('all');
  protected readonly confirming = signal<string | null>(null);
  protected readonly skillAgents: AgentId[] = ['claude', 'codex'];
  protected readonly filters = [
    { id: 'all', label: 'Tất cả' },
    { id: 'library', label: 'Thư viện của bạn' },
    { id: 'seen', label: 'Chỉ agent thấy' },
  ] as const;
  protected readonly presets = [
    { id: 'github', label: 'GitHub' },
    { id: 'filesystem', label: 'Filesystem' },
    { id: 'playwright', label: 'Playwright' },
    { id: 'custom', label: 'Tự nhập' },
  ] as const;
  protected readonly bridgeTools = [
    { name: 'report_progress', description: 'Tiến độ hiện ở cuộc trò chuyện và màn Giám sát' },
    {
      name: 'write_note',
      description: 'Ghi chú chung giữa các agent cùng task, xem ở tab Kế hoạch & ghi chú',
    },
    {
      name: 'read_notes',
      description: 'Đọc ghi chú chung giữa các agent cùng task, xem ở tab Kế hoạch & ghi chú',
    },
    { name: 'handoff_to', description: 'Đề xuất chuyển việc, bạn quyết định' },
    { name: 'request_approval', description: 'Hiện thẻ duyệt' },
    { name: 'get_task_context', description: 'Đọc ngữ cảnh của task hiện tại' },
  ];
  private returnFocus: HTMLElement | null = null;
  @ViewChild('drawerFocus') set drawerFocus(element: ElementRef<HTMLElement> | undefined) {
    if (element) element.nativeElement.focus();
  }
  private readonly dismissInfo = effect((onCleanup) => {
    if (!this.info()) return;
    const timer = setTimeout(() => this.info.set(null), 4000);
    onCleanup(() => clearTimeout(timer));
  });
  protected readonly skillTemplate = SKILL_TEMPLATE;
  protected readonly servers = signal<McpServer[]>([]);
  protected readonly draft = signal<McpServer | null>(null);
  protected readonly skills = signal<Skill[]>([]);
  protected readonly targets = signal<Record<string, SkillTarget[]>>({});
  protected readonly skillDraft = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly bridgeOn = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly info = signal<string | null>(null);
  private readonly repo = computed(() => this.workspace.repo()?.root ?? null);
  private readonly installed = inject(AgentsService);
  protected readonly folderName = computed(
    () => this.workspace.folder()?.split(/[\\/]/).filter(Boolean).pop() ?? null,
  );
  /** Agents with a session that reports skills: Claude and Codex, when installed. */
  private readonly seenAgents = computed(() =>
    this.installed
      .agents()
      .filter((a) => a.path && (a.id === 'claude' || a.id === 'codex'))
      .map((a) => a.id),
  );
  protected readonly seen = computed(() =>
    this.seenAgents().map((agent) => {
      const list = this.installed.commandsFor(agent, this.workspace.folder());
      const skills = Array.isArray(list) ? list.filter((c) => c.kind === 'skill') : [];
      return { agent, list, skills };
    }),
  );
  private readonly loadSeen = effect(() => {
    const folder = this.workspace.folder();
    const agents = this.seenAgents();
    untracked(() => agents.forEach((a) => void this.installed.loadCommands(a, folder)));
  });

  protected readonly skillRows = computed(() => {
    const rows = new Map<
      string,
      { name: string; description: string; library: Skill | null; visible: AgentId[] }
    >();
    const key = (name: string) => name.trim().replace(/^[/$]/, '');
    for (const skill of this.skills())
      rows.set(key(skill.name), {
        name: skill.name,
        description: skill.description,
        library: skill,
        visible: [],
      });
    for (const seen of this.seen())
      for (const command of seen.skills) {
        const name = key(command.name);
        const row = rows.get(name) ?? {
          name,
          description: command.description,
          library: null,
          visible: [],
        };
        if (!row.visible.includes(seen.agent)) row.visible.push(seen.agent);
        rows.set(name, row);
      }
    return [...rows.values()].filter(
      (row) =>
        this.skillFilter() === 'all' ||
        (this.skillFilter() === 'library' ? !!row.library : !row.library),
    );
  });

  protected loading(agent: AgentId): boolean {
    return this.seen().some((row) => row.agent === agent && row.list === 'loading');
  }

  protected preset(kind: string): void {
    const server = { ...EMPTY };
    if (kind === 'github')
      Object.assign(server, {
        name: 'github',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '' }],
      });
    if (kind === 'filesystem')
      Object.assign(server, {
        name: 'filesystem',
        command: 'npx',
        args: [
          '-y',
          '@modelcontextprotocol/server-filesystem',
          ...(this.workspace.folder() ? [this.workspace.folder()!] : []),
        ],
      });
    if (kind === 'playwright')
      Object.assign(server, {
        name: 'playwright',
        command: 'npx',
        args: ['@playwright/mcp@latest'],
      });
    this.edit(server);
  }

  protected editSkill(content: string): void {
    this.returnFocus = document.activeElement as HTMLElement;
    this.draft.set(null);
    this.skillDraft.set(content);
  }

  @HostListener('document:keydown.escape')
  protected closeDrawer(): void {
    if (!this.draft() && this.skillDraft() === null) return;
    this.draft.set(null);
    this.skillDraft.set(null);
    this.returnFocus?.focus();
  }

  protected trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const elements = Array.from(
      (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
        'button:not(:disabled), input, textarea, [tabindex="0"]',
      ),
    );
    const first = elements[0],
      last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  protected patchPair(index: number, change: Partial<NameValue>): void {
    const d = this.draft();
    if (!d) return;
    const field = d.transport === 'stdio' ? 'env' : 'headers';
    this.patch({
      [field]: d[field].map((pair, i) => (i === index ? { ...pair, ...change } : pair)),
    });
  }

  protected addPair(): void {
    const d = this.draft();
    if (!d) return;
    const field = d.transport === 'stdio' ? 'env' : 'headers';
    this.patch({ [field]: [...d[field], { name: '', value: '' }] });
  }

  protected removePair(index: number): void {
    const d = this.draft();
    if (!d) return;
    const field = d.transport === 'stdio' ? 'env' : 'headers';
    this.patch({ [field]: d[field].filter((_, i) => i !== index) });
  }

  protected rescan(): void {
    const folder = this.workspace.folder();
    for (const a of this.seenAgents()) {
      this.installed.commands.update((c) => {
        const { [`${a}|${folder ?? ''}`]: _, ...rest } = c;
        return rest;
      });
      void this.installed.loadCommands(a, folder);
    }
  }

  ngOnInit(): void {
    void this.reload().catch((e: unknown) =>
      this.error.set(errorText(e)),
    );
  }

  protected target(s: McpServer): string {
    return s.transport === 'http' ? (s.url ?? '') : [s.command, ...s.args].join(' ');
  }

  protected lines(text: string): string[] {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  protected flip(list: AgentId[], a: AgentId): AgentId[] {
    return list.includes(a) ? list.filter((x) => x !== a) : [...list, a];
  }

  protected edit(s: McpServer): void {
    this.returnFocus = document.activeElement as HTMLElement;
    this.skillDraft.set(null);
    this.draft.set({
      ...s,
      args: [...s.args],
      env: [...s.env],
      headers: [...s.headers],
      agents: [...s.agents],
    });
  }

  protected patch(change: Partial<McpServer>): void {
    this.draft.update((d) => (d ? { ...d, ...change } : d));
  }

  protected async save(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    await this.guard(async () => {
      const clean = {
        ...d,
        command: d.transport === 'stdio' ? d.command : null,
        url: d.transport === 'http' ? d.url : null,
      };
      const saved = await this.backend.saveMcpServer(clean);
      this.closeDrawer();
      this.info.set(`Đã lưu ${saved.name}. Áp dụng cho các lượt chạy mới.`);
    });
  }

  protected async toggle(s: McpServer, a: AgentId): Promise<void> {
    await this.guard(() =>
      this.backend.saveMcpServer({ ...s, agents: this.flip(s.agents, a) }).then(() => undefined),
    );
  }

  protected async remove(s: McpServer): Promise<void> {
    await this.guard(() => this.backend.deleteMcpServer(s.id));
  }

  protected async saveSkill(): Promise<void> {
    const content = this.skillDraft();
    if (content === null) return;
    await this.guard(async () => {
      const skill = await this.backend.saveSkill(content);
      this.closeDrawer();
      this.info.set(`Đã lưu skill ${skill.name} vào thư viện.`);
    });
  }

  protected async removeSkill(k: Skill): Promise<void> {
    await this.guard(() => this.backend.deleteSkill(k.name));
  }

  protected async install(k: Skill, t: SkillTarget): Promise<void> {
    await this.guard(async () => {
      const done = await this.backend.installSkill(k.name, t.scope, this.repo());
      this.info.set(
        `Đã cài ${k.name} vào ${done.path}${done.backup ? ` (bản cũ lưu ở ${done.backup})` : ''}.`,
      );
    });
  }

  protected async setBridge(on: boolean): Promise<void> {
    await this.guard(async () => {
      await this.backend.setSetting('bridge', JSON.stringify({ enabled: on }));
      this.info.set(
        on ? 'Đã bật tg-bridge cho các task mới.' : 'Đã tắt tg-bridge cho các task mới.',
      );
    });
  }

  private async reload(): Promise<void> {
    try {
      const raw = await this.backend.getSetting('bridge');
      this.bridgeOn.set(raw ? JSON.parse(raw).enabled !== false : true);
    } catch {
      this.bridgeOn.set(true);
    }
    this.servers.set(await this.backend.listMcpServers());
    const skills = await this.backend.listSkills();
    this.skills.set(skills);
    const entries = await Promise.all(
      skills.map(
        async (k) =>
          [k.name, await this.backend.skillTargets(k.name, this.repo()).catch(() => [])] as const,
      ),
    );
    this.targets.set(Object.fromEntries(entries));
  }

  private async guard(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.info.set(null);
    try {
      await work();
      this.confirming.set(null);
      await this.reload();
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
