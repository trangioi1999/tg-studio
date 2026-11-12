import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AgentBackend } from '../../core/backend';
import { AgentId, McpServer, NameValue, Skill, SkillTarget } from '../../core/protocol';
import { AGENT_IDS, AGENT_META } from '../../services/agents/agent-meta';
import { AgentsService } from '../../services/agents/agents.service';
import { WorkspaceService } from '../../services/workspace.service';
import { errorText } from '../../shared/utils/errors';

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

/** What the Connections screen's parts share: MCP servers, the skill library, the open drawer, messages. Provided by Integrations. */
@Injectable()
export class IntegrationsState {
  private readonly backend = inject(AgentBackend);
  private readonly workspace = inject(WorkspaceService);
  readonly meta = AGENT_META;
  readonly agents = AGENT_IDS;
  readonly tab = signal<'mcp' | 'skills'>('mcp');
  readonly skillFilter = signal<'all' | 'library' | 'seen'>('all');
  readonly confirming = signal<string | null>(null);
  readonly skillAgents: AgentId[] = ['claude', 'codex'];
  readonly filters = [
    { id: 'all', label: 'Tất cả' },
    { id: 'library', label: 'Thư viện của bạn' },
    { id: 'seen', label: 'Chỉ agent thấy' },
  ] as const;
  readonly presets = [
    { id: 'github', label: 'GitHub' },
    { id: 'filesystem', label: 'Filesystem' },
    { id: 'playwright', label: 'Playwright' },
    { id: 'custom', label: 'Tự nhập' },
  ] as const;
  readonly bridgeTools = [
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
  private readonly dismissInfo = effect((onCleanup) => {
    if (!this.info()) return;
    const timer = setTimeout(() => this.info.set(null), 4000);
    onCleanup(() => clearTimeout(timer));
  });
  readonly skillTemplate = SKILL_TEMPLATE;
  readonly servers = signal<McpServer[]>([]);
  readonly draft = signal<McpServer | null>(null);
  readonly skills = signal<Skill[]>([]);
  readonly targets = signal<Record<string, SkillTarget[]>>({});
  readonly skillDraft = signal<string | null>(null);
  readonly busy = signal(false);
  readonly bridgeOn = signal(true);
  readonly error = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  private readonly repo = computed(() => this.workspace.repo()?.root ?? null);
  private readonly installed = inject(AgentsService);
  readonly folderName = computed(
    () => this.workspace.folder()?.split(/[\\/]/).filter(Boolean).pop() ?? null,
  );
  /** Agents with a session that reports skills: Claude and Codex, when installed. */
  private readonly seenAgents = computed(() =>
    this.installed
      .agents()
      .filter((a) => a.path && (a.id === 'claude' || a.id === 'codex'))
      .map((a) => a.id),
  );
  readonly seen = computed(() =>
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

  readonly skillRows = computed(() => {
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

  loading(agent: AgentId): boolean {
    return this.seen().some((row) => row.agent === agent && row.list === 'loading');
  }

  preset(kind: string): void {
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

  editSkill(content: string): void {
    this.returnFocus = document.activeElement as HTMLElement;
    this.draft.set(null);
    this.skillDraft.set(content);
  }

  closeDrawer(): void {
    if (!this.draft() && this.skillDraft() === null) return;
    this.draft.set(null);
    this.skillDraft.set(null);
    this.returnFocus?.focus();
  }

  trapFocus(event: KeyboardEvent): void {
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

  patchPair(index: number, change: Partial<NameValue>): void {
    const d = this.draft();
    if (!d) return;
    const field = d.transport === 'stdio' ? 'env' : 'headers';
    this.patch({
      [field]: d[field].map((pair, i) => (i === index ? { ...pair, ...change } : pair)),
    });
  }

  addPair(): void {
    const d = this.draft();
    if (!d) return;
    const field = d.transport === 'stdio' ? 'env' : 'headers';
    this.patch({ [field]: [...d[field], { name: '', value: '' }] });
  }

  removePair(index: number): void {
    const d = this.draft();
    if (!d) return;
    const field = d.transport === 'stdio' ? 'env' : 'headers';
    this.patch({ [field]: d[field].filter((_, i) => i !== index) });
  }

  rescan(): void {
    const folder = this.workspace.folder();
    for (const a of this.seenAgents()) {
      this.installed.invalidateCommands(a, folder);
      void this.installed.loadCommands(a, folder);
    }
  }

  /** Reads servers, skills and the tg-bridge switch. */
  init(): void {
    void this.reload().catch((e: unknown) =>
      this.error.set(errorText(e)),
    );
  }

  target(s: McpServer): string {
    return s.transport === 'http' ? (s.url ?? '') : [s.command, ...s.args].join(' ');
  }

  lines(text: string): string[] {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  flip(list: AgentId[], a: AgentId): AgentId[] {
    return list.includes(a) ? list.filter((x) => x !== a) : [...list, a];
  }

  edit(s: McpServer): void {
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

  patch(change: Partial<McpServer>): void {
    this.draft.update((d) => (d ? { ...d, ...change } : d));
  }

  async save(): Promise<void> {
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

  async toggle(s: McpServer, a: AgentId): Promise<void> {
    await this.guard(() =>
      this.backend.saveMcpServer({ ...s, agents: this.flip(s.agents, a) }).then(() => undefined),
    );
  }

  async remove(s: McpServer): Promise<void> {
    await this.guard(() => this.backend.deleteMcpServer(s.id));
  }

  async saveSkill(): Promise<void> {
    const content = this.skillDraft();
    if (content === null) return;
    await this.guard(async () => {
      const skill = await this.backend.saveSkill(content);
      this.closeDrawer();
      this.info.set(`Đã lưu skill ${skill.name} vào thư viện.`);
    });
  }

  async removeSkill(k: Skill): Promise<void> {
    await this.guard(() => this.backend.deleteSkill(k.name));
  }

  async install(k: Skill, t: SkillTarget): Promise<void> {
    await this.guard(async () => {
      const done = await this.backend.installSkill(k.name, t.scope, this.repo());
      this.info.set(
        `Đã cài ${k.name} vào ${done.path}${done.backup ? ` (bản cũ lưu ở ${done.backup})` : ''}.`,
      );
    });
  }

  async setBridge(on: boolean): Promise<void> {
    await this.guard(async () => {
      await this.backend.setSetting('bridge', JSON.stringify({ enabled: on }));
      this.info.set(
        on ? 'Đã bật tg-bridge cho các task mới.' : 'Đã tắt tg-bridge cho các task mới.',
      );
    });
  }

  async reload(): Promise<void> {
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
