import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { AgentBackend } from '../core/backend';
import { AGENT_IDS, AGENT_META, AgentId, McpServer, NameValue, Skill, SkillTarget } from '../core/protocol';
import { WorkspaceService } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';

const EMPTY: McpServer = { id: '', name: '', transport: 'stdio', command: '', args: [], env: [], url: '', headers: [], agents: ['claude'] };

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
    <div class="integrations">
      <header class="usage-head"><h1>Integrations</h1></header>
      @if (error()) { <p class="error-text" role="alert">{{ error() }}</p> }
      @if (info()) { <p class="ok-text" role="status">{{ info() }}</p> }

      <section class="mission-block" aria-label="MCP servers">
        <div class="block-head">
          <span class="label">MCP SERVERS</span>
          <span class="dim ellipsis">Bật một lần: TG Studio đưa server vào mọi phiên của agent được chọn, không sửa file cấu hình của agent.</span>
          <span class="spacer"></span>
          <button class="btn ghost sm" (click)="edit({ ...empty })">Thêm server</button>
        </div>
        <table class="runs-table matrix">
          <thead>
            <tr>
              <th>Server</th><th>Kết nối</th>
              @for (a of agents; track a) { <th class="mid"><span class="cell-agent"><tg-agent-avatar [agent]="a" [size]="14" />{{ meta[a].name }}</span></th> }
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (s of servers(); track s.id) {
              <tr>
                <td class="mono">{{ s.name }}</td>
                <td class="mono dim ellipsis matrix-target" [title]="target(s)">{{ s.transport }} · {{ target(s) }}</td>
                @for (a of agents; track a) {
                  <td class="mid">
                    <input type="checkbox" [checked]="s.agents.includes(a)" [attr.aria-label]="s.name + ' cho ' + meta[a].name" (change)="toggle(s, a)" />
                  </td>
                }
                <td class="num"><button class="btn ghost sm" (click)="edit(s)">Sửa</button> <button class="btn ghost sm" (click)="remove(s)">Xóa</button></td>
              </tr>
            } @empty {
              <tr><td [attr.colspan]="agents.length + 3" class="dim">Chưa có server nào.</td></tr>
            }
          </tbody>
        </table>
        <p class="dim form-note pad">Server <strong>stdio</strong> chạy với mọi agent qua ACP (chế độ Sửa code) và với Claude ở chế độ Chỉ đọc. Server <strong>http</strong> chỉ được gửi khi agent báo hỗ trợ; nếu không, log của lượt chạy ghi rõ đã bỏ qua. Biến môi trường và header lưu trong máy này, không mã hóa.</p>

        @if (draft(); as d) {
          <form class="mcp-form" (submit)="$event.preventDefault(); save()">
            <div class="form-row">
              <label class="field"><span>Tên</span><input class="mono" [value]="d.name" (input)="patch({ name: $any($event.target).value })" placeholder="github" required /></label>
              <label class="field"><span>Kết nối</span>
                <select (change)="patch({ transport: $any($event.target).value })">
                  <option value="stdio" [selected]="d.transport === 'stdio'">stdio (chạy lệnh)</option>
                  <option value="http" [selected]="d.transport === 'http'">http (URL)</option>
                </select>
              </label>
            </div>
            @if (d.transport === 'stdio') {
              <label class="field"><span>Lệnh</span><input class="mono" [value]="d.command ?? ''" (input)="patch({ command: $any($event.target).value })" placeholder="npx" /></label>
              <label class="field"><span>Tham số (mỗi dòng một tham số)</span><textarea class="mono" rows="2" [value]="d.args.join('\\n')" (input)="patch({ args: lines($any($event.target).value) })" placeholder="-y&#10;@modelcontextprotocol/server-github"></textarea></label>
              <label class="field"><span>Biến môi trường (TÊN=giá trị, mỗi dòng một biến)</span><textarea class="mono" rows="2" [value]="pairsText(d.env)" (input)="patch({ env: pairs($any($event.target).value, '=') })"></textarea></label>
            } @else {
              <label class="field"><span>URL</span><input class="mono" [value]="d.url ?? ''" (input)="patch({ url: $any($event.target).value })" placeholder="https://…/mcp" /></label>
              <label class="field"><span>Header (Tên: giá trị, mỗi dòng một header)</span><textarea class="mono" rows="2" [value]="pairsText(d.headers, ': ')" (input)="patch({ headers: pairs($any($event.target).value, ':') })"></textarea></label>
            }
            <div class="form-row">
              <span class="dim">Bật cho:</span>
              @for (a of agents; track a) {
                <label class="pick" [class.on]="d.agents.includes(a)" [style.--agent]="meta[a].color">
                  <input type="checkbox" [checked]="d.agents.includes(a)" (change)="patch({ agents: flip(d.agents, a) })" />
                  <tg-agent-avatar [agent]="a" [size]="14" />{{ meta[a].name }}
                </label>
              }
              <span class="spacer"></span>
              <button class="btn ghost sm" type="button" (click)="draft.set(null)">Hủy</button>
              <button class="btn primary sm" type="submit" [disabled]="busy()">Lưu server</button>
            </div>
          </form>
        }
      </section>

      <section class="mission-block" aria-label="Skills">
        <div class="block-head">
          <span class="label">SKILLS</span>
          <span class="dim ellipsis">Thư viện SKILL.md của bạn, cài vào agent hỗ trợ.</span>
          <span class="spacer"></span>
          <button class="btn ghost sm" (click)="skillDraft.set(skillTemplate)">Thêm skill</button>
        </div>
        <table class="runs-table">
          <thead><tr><th>Skill</th><th>Mô tả</th>
            @for (a of agents; track a) { <th class="mid"><span class="cell-agent"><tg-agent-avatar [agent]="a" [size]="14" />{{ meta[a].name }}</span></th> }
            <th></th></tr></thead>
          <tbody>
            @for (k of skills(); track k.name) {
              <tr>
                <td class="mono">{{ k.name }}</td>
                <td class="ellipsis prompt-cell" [title]="k.description">{{ k.description }}</td>
                @for (a of agents; track a) {
                  <td class="mid">
                    @if (a === 'claude') {
                      @for (t of targets()[k.name] ?? []; track t.scope) {
                        <div class="skill-target">
                          <span class="dim">{{ t.scope === 'project' ? 'repo' : 'máy' }}:</span>
                          @if (t.state === 'same') { <span class="ok">đã cài</span> }
                          @else {
                            <button class="btn ghost sm" [disabled]="busy()" [title]="t.path" (click)="install(k, t)">{{ t.state === 'different' ? 'Cập nhật' : 'Cài' }}</button>
                          }
                        </div>
                      }
                    } @else {
                      <span class="dim" title="Chưa có vị trí chuẩn đã kiểm chứng để đặt SKILL.md cho agent này">chưa hỗ trợ</span>
                    }
                  </td>
                }
                <td class="num"><button class="btn ghost sm" (click)="skillDraft.set(k.content)">Sửa</button> <button class="btn ghost sm" (click)="removeSkill(k)">Xóa</button></td>
              </tr>
            } @empty {
              <tr><td [attr.colspan]="agents.length + 3" class="dim">Thư viện trống.</td></tr>
            }
          </tbody>
        </table>
        <p class="dim form-note pad">Claude Code đọc skill ở <code>.claude/skills/&lt;tên&gt;/SKILL.md</code> trong repo (mức repo) và ở <code>~/.claude/skills</code> (mức máy). Nếu đã có bản khác, bản cũ được sao lưu thành <code>SKILL.md.bak-…</code> trước khi ghi.</p>
        @if (skillDraft() !== null) {
          <form class="mcp-form" (submit)="$event.preventDefault(); saveSkill()">
            <label class="field"><span>SKILL.md</span><textarea class="mono" rows="10" [value]="skillDraft()" (input)="skillDraft.set($any($event.target).value)"></textarea></label>
            <div class="form-row"><span class="spacer"></span>
              <button class="btn ghost sm" type="button" (click)="skillDraft.set(null)">Hủy</button>
              <button class="btn primary sm" type="submit" [disabled]="busy()">Lưu skill</button>
            </div>
          </form>
        }
      </section>
    </div>
  `,
})
export class Integrations implements OnInit {
  private readonly backend = inject(AgentBackend);
  private readonly workspace = inject(WorkspaceService);
  protected readonly meta = AGENT_META;
  protected readonly agents = AGENT_IDS;
  protected readonly empty = EMPTY;
  protected readonly skillTemplate = SKILL_TEMPLATE;
  protected readonly servers = signal<McpServer[]>([]);
  protected readonly draft = signal<McpServer | null>(null);
  protected readonly skills = signal<Skill[]>([]);
  protected readonly targets = signal<Record<string, SkillTarget[]>>({});
  protected readonly skillDraft = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly info = signal<string | null>(null);
  private readonly repo = computed(() => this.workspace.repo()?.root ?? null);

  ngOnInit(): void {
    void this.reload();
  }

  protected target(s: McpServer): string {
    return s.transport === 'http' ? (s.url ?? '') : [s.command, ...s.args].join(' ');
  }

  protected lines(text: string): string[] {
    return text.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  protected pairs(text: string, sep: string): NameValue[] {
    return this.lines(text).map((l) => {
      const i = l.indexOf(sep);
      return i < 0 ? { name: l, value: '' } : { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    });
  }

  protected pairsText(list: NameValue[], sep = '='): string {
    return list.map((p) => `${p.name}${sep}${p.value}`).join('\n');
  }

  protected flip(list: AgentId[], a: AgentId): AgentId[] {
    return list.includes(a) ? list.filter((x) => x !== a) : [...list, a];
  }

  protected edit(s: McpServer): void {
    this.draft.set({ ...s, args: [...s.args], env: [...s.env], headers: [...s.headers], agents: [...s.agents] });
  }

  protected patch(change: Partial<McpServer>): void {
    this.draft.update((d) => (d ? { ...d, ...change } : d));
  }

  protected async save(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    await this.guard(async () => {
      const clean = { ...d, command: d.transport === 'stdio' ? d.command : null, url: d.transport === 'http' ? d.url : null };
      const saved = await this.backend.saveMcpServer(clean);
      this.draft.set(null);
      this.info.set(`Đã lưu ${saved.name}. Áp dụng cho các lượt chạy mới.`);
    });
  }

  protected async toggle(s: McpServer, a: AgentId): Promise<void> {
    await this.guard(() => this.backend.saveMcpServer({ ...s, agents: this.flip(s.agents, a) }).then(() => undefined));
  }

  protected async remove(s: McpServer): Promise<void> {
    await this.guard(() => this.backend.deleteMcpServer(s.id));
  }

  protected async saveSkill(): Promise<void> {
    const content = this.skillDraft();
    if (content === null) return;
    await this.guard(async () => {
      const skill = await this.backend.saveSkill(content);
      this.skillDraft.set(null);
      this.info.set(`Đã lưu skill ${skill.name} vào thư viện.`);
    });
  }

  protected async removeSkill(k: Skill): Promise<void> {
    await this.guard(() => this.backend.deleteSkill(k.name));
  }

  protected async install(k: Skill, t: SkillTarget): Promise<void> {
    await this.guard(async () => {
      const done = await this.backend.installSkill(k.name, t.scope, this.repo());
      this.info.set(`Đã cài ${k.name} vào ${done.path}${done.backup ? ` (bản cũ lưu ở ${done.backup})` : ''}.`);
    });
  }

  private async reload(): Promise<void> {
    this.servers.set(await this.backend.listMcpServers());
    const skills = await this.backend.listSkills();
    this.skills.set(skills);
    const entries = await Promise.all(skills.map(async (k) => [k.name, await this.backend.skillTargets(k.name, this.repo()).catch(() => [])] as const));
    this.targets.set(Object.fromEntries(entries));
  }

  private async guard(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.info.set(null);
    try {
      await work();
      await this.reload();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
