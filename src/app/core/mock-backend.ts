import { AgentBackend, SettingKey, Unlisten } from './backend';
import { AccountLimits, AgentEvent, BridgeNote, AgentId, CheckResult, Composite, DetectedAgent, FileDiff, LimitWindow, McpServer, Pick, PriceRow, Project, Skill, SkillInstalled, SkillTarget, StoredRun, Usage, UsageRow } from './protocol';

interface MockRun {
  /** Its session waits for more messages after a turn. */
  open?: boolean;
  agent: AgentId;
  timers: ReturnType<typeof setTimeout>[];
  active: boolean;
}

interface MockTask {
  files: FileDiff[];
  contents: Map<string, string>;
  /** Mock worktree path, so tool locations look like a real adapter's. */
  root: string;
  accepted: number;
  /** Paths accepted but not committed yet. */
  staged: Set<string>;
  pending: boolean;
}

/** Each agent gets a slightly different result, so the compare view has something to compare. */
function mockDiff(agent: AgentId = 'claude'): FileDiff[] {
  // Ranges come from the header, like the core's parser.
  const hunk = (id: string, header: string, lines: string[]) => {
    const [, oldStart, oldLines, newStart, newLines] = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(header)!.map(Number);
    return {
      id, header, oldStart, oldLines, newStart, newLines, lines,
      added: lines.filter((l) => l.startsWith('+')).length,
      removed: lines.filter((l) => l.startsWith('-')).length,
    };
  };
  return [
    {
      path: 'src/app/app.ts', status: 'M', binary: false, patchHeader: '',
      hunks: [
        hunk('h1', '@@ -10,3 +10,4 @@ export class App', [' export class App {', '-  title = "cũ";', `+  title = "mới (${agent})";`, '+  ready = true;', ' }']),
        hunk('h2', '@@ -40,2 +41,2 @@ export function retries', [' export function retries(): number {', '-  return 1;', '+  return 2;']),
      ],
    },
    ...(agent === 'codex' ? [] : [{
      path: 'docs/ghi chú mới.md', status: 'A', binary: false, patchHeader: '',
      hunks: [hunk('h3', '@@ -0,0 +1,2 @@', ['+# Ghi chú', '+Nội dung mới'])],
    }]),
  ];
}

/**
 * Worktree contents. `edited` matches `mockDiff(agent)`: new lines 11–12 and 42 of
 * app.ts are the agent's. Before the edit the worktree equals the base commit.
 */
function mockContents(agent: AgentId, edited: boolean): Map<string, string> {
  // Plausible code around the two places the agent changes (lines 10–13 and 41–43).
  const app = [
    "import { Session, verify } from './auth';",
    "import { Retry } from './retry';",
    '',
    '/** Trang chủ của ứng dụng demo. */',
    "const DEFAULT_TITLE = 'TG Studio demo';",
    '',
    'interface AppState {',
    '  user: Session | null;',
    '}',
    'export class App {', '  title = "cũ";', '  ready = false;', '}',
    '',
    'export function greet(state: AppState): string {',
    "  return state.user ? `Xin chào, ${state.user.name}` : 'Xin chào';",
    '}',
    '',
    'export async function login(token: string): Promise<AppState> {',
    '  const user = await verify(token);',
    '  if (!user) {',
    "    throw new Error('Phiên đăng nhập hết hạn');",
    '  }',
    '  return { user };',
    '}',
    '',
    'export function logout(): AppState {',
    '  return { user: null };',
    '}',
    '',
    '/** Chờ lâu dần khi mạng chập chờn: 2s, 4s, 8s… tối đa 30s. */',
    'export function backoff(attempt: number): number {',
    '  return Math.min(1000 * 2 ** attempt, 30_000);',
    '}',
    '',
    'export function title(): string {',
    '  return DEFAULT_TITLE;',
    '}',
    '',
    '// Số lần thử lại khi đăng nhập',
    'export function retries(): number {', '  return 1;', '}',
    '',
    'export const retry = new Retry(retries(), backoff);',
    '',
    'export function ready(app: App): boolean {',
    '  return app.ready;',
    '}',
  ];
  app.splice(9, 4, 'export class App {', `  title = "mới (${agent})";`, '  ready = true;', '}');
  app.splice(40, 3, 'export function retries(): number {', '  return 2;', '}');
  if (!edited) {
    app.splice(10, 2, '  title = "cũ";');
    app[app.indexOf('  return 2;')] = '  return 1;';
  }
  const files: [string, string][] = [
    ['README.md', '# Demo\n\nRepo mô phỏng cho chế độ trình duyệt.\n'],
    ['package.json', '{\n  "name": "demo",\n  "private": true\n}\n'],
    ['src/app/app.ts', app.join('\n') + '\n'],
  ];
  if (edited && agent !== 'codex') files.push(['docs/ghi chú mới.md', '# Ghi chú\nNội dung mới\n']);
  return new Map(files);
}

/** Claude-style plan windows, so the limits panel has something to show in the browser. */
function mockLimits(): { windows: LimitWindow[] } {
  const now = Date.now();
  return { windows: [
    { id: 'five_hour', utilization: 0.42, resetsAt: now + 2.5 * 3_600_000, status: 'allowed' },
    { id: 'seven_day', utilization: 0.18, resetsAt: now + 4 * 86_400_000, status: 'allowed' },
  ] };
}

/**
 * Used when the UI runs in a normal browser (`npm start`), so you can build
 * screens without launching the desktop app. Emits a fake but realistic run.
 */
export class MockBackend extends AgentBackend {
  readonly mode = 'mock' as const;
  private runs = new Map<string, MockRun>();
  private tasks = new Map<string, MockTask>();
  private composites = new Map<string, FileDiff[]>();
  private prices: PriceRow[] = [];
  private mcp: McpServer[] = [];
  private skills = new Map<string, string>();
  private installed = new Map<string, string>();
  private settings = new Map<string, string>();
  /** Runs of this browser session, so the ledger also shows what was just run. */
  private ledger = new Map<string, UsageRow>();
  private handlers: ((e: AgentEvent) => void)[] = [];

  async detectAgents(): Promise<DetectedAgent[]> {
    return [
      { id: 'claude', name: 'Claude Code', binary: 'claude', path: '/usr/local/bin/claude', version: 'mock', headless: true, auth: 'ok' },
      { id: 'codex', name: 'Codex', binary: 'codex', path: '/opt/homebrew/bin/codex', version: 'mock', headless: true, auth: 'ok' },
      { id: 'gemini', name: 'Gemini CLI', binary: 'gemini', path: '~/.nvm/.../gemini', version: 'mock', headless: true, auth: 'ok' },
      { id: 'kiro', name: 'Kiro CLI', binary: 'kiro-cli', path: null, version: null, headless: false, auth: 'unknown' },
    ];
  }

  async pickFolder(): Promise<string | null> {
    return '/Users/you/projects/demo';
  }

  /** Path words imitate each state: missing, nogit, nocommit. */
  async openProject(path: string): Promise<Project> {
    const root = path.trim().replace(/[\\/]+$/, '');
    if (!root || root.includes('missing')) throw new Error(`Thư mục không tồn tại: ${path.trim()}`);
    const name = root.split(/[\\/]/).pop() ?? root;
    const git = root.includes('nogit') ? 'none' : root.includes('nocommit') ? 'no_commits' : 'ready';
    return { root, name, branch: git === 'none' ? null : 'main', git, adjusted: null };
  }

  async listProjectFiles(_root: string): Promise<string[]> {
    return ['README.md', 'package.json', 'src/app/app.ts'];
  }

  async readProjectFile(_root: string, path: string): Promise<string> {
    return `// ${path}\n// Nội dung mẫu của mock mode.\n`;
  }

  async start(agent: AgentId, prompt: string, _cwd?: string): Promise<string> {
    const runId = crypto.randomUUID();
    const run = { agent, timers: [] as ReturnType<typeof setTimeout>[], active: true };
    this.runs.set(runId, run);
    const emit = (partial: Partial<AgentEvent>, delay: number) => {
      run.timers.push(setTimeout(() => {
        if (partial.kind === 'exit') run.active = false;
        this.emit({ runId, agent, kind: 'log', line: null, usage: null, code: null, data: null, atMs: Date.now(), ...partial });
      }, delay));
    };
    const usage: Usage = {
      inputTokens: 1800 + Math.round(Math.random() * 4000),
      cachedInputTokens: 12000,
      outputTokens: 400 + Math.round(Math.random() * 900),
      costUsd: agent === 'claude' ? 0.02 + Math.random() * 0.05 : null,
      source: agent === 'claude' ? 'reported' : 'tokens',
      cumulative: true,
    };
    emit({ kind: 'started', line: `mock ${agent} · ${prompt.slice(0, 40)}` }, 50);
    emit({ line: '› đọc cấu trúc thư mục' }, 400);
    emit({ line: '› read src/app/app.ts' }, 900);
    emit({ line: 'Đây là phản hồi giả lập để dựng giao diện khi chạy trong trình duyệt.' }, 1500);
    emit({ kind: 'usage', usage }, 1900);
    if (agent === 'claude') emit({ kind: 'limits', data: mockLimits() as unknown as AgentEvent['data'] }, 1950);
    emit({ kind: 'exit', code: 0 }, 2100);
    return runId;
  }

  /** A scripted code task: approval card, then two changed files to review. */
  async startTask(agent: AgentId, prompt: string, repo: string, _group: string | null = null, reuse: string | null = null, singleTurn = false): Promise<string> {
    const previous = reuse ? this.task(reuse) : null;
    if (reuse && this.runs.get(reuse)?.active) throw new Error('Bước trước vẫn đang chạy.');
    const runId = crypto.randomUUID();
    const run: MockRun = { agent, timers: [], active: true, open: !singleTurn };
    this.runs.set(runId, run);
    this.tasks.set(runId, previous
      ? { files: previous.files, contents: previous.contents, root: previous.root, accepted: 0, staged: previous.staged, pending: true }
      : { files: [], contents: mockContents(agent, false), root: `${repo}/.tg/worktrees/${runId}`, accepted: 0, staged: new Set<string>(), pending: true });
    const send = (partial: Partial<AgentEvent>, delay: number) => this.later(runId, run, partial, delay);
    send({ kind: 'started', line: `mock ${agent} · ${repo}` }, 20);
    send({ kind: 'message', data: { text: 'Mình sẽ chạy test ' } }, 60);
    send({ kind: 'message', data: { text: 'trước khi sửa.' } }, 100);
    send({ kind: 'plan', data: { entries: [
      { content: 'Chạy test hiện tại', status: 'in_progress' },
      { content: `Sửa theo yêu cầu: ${prompt.slice(0, 40)}`, status: 'pending' },
    ] } }, 140);
    send({ kind: 'tool', data: { toolCallId: 't1', title: 'npm test', kind: 'execute', status: 'pending' } }, 180);
    send({
      kind: 'permission',
      data: {
        requestId: `perm-${runId}`,
        toolCall: { title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
        ],
        rule: 'npm test *',
      },
    }, 220);
    return runId;
  }

  async respondPermission(runId: string, requestId: string, optionId: string, _always: boolean): Promise<void> {
    const run = this.runs.get(runId);
    const task = this.tasks.get(runId);
    if (!run || !task?.pending) throw new Error('Yêu cầu duyệt đã kết thúc.');
    task.pending = false;
    const allowed = optionId !== 'reject';
    const send = (partial: Partial<AgentEvent>, delay: number) => this.later(runId, run, partial, delay);
    send({ kind: 'permission_resolved', data: { requestId } }, 0);
    send({ kind: 'tool', data: { toolCallId: 't1', status: allowed ? 'completed' : 'failed' } }, 40);
    const file = `${task.root}/src/app/app.ts`;
    send({ kind: 'tool', data: { toolCallId: 't2', title: 'Sửa src/app/app.ts', kind: 'edit', status: 'pending', locations: [{ path: file, line: 11 }] } }, 80);
    // The edit lands in the worktree only when the tool call completes, like a real agent.
    this.later(runId, run, { kind: 'tool', data: { toolCallId: 't2', status: 'completed', content: [{ type: 'diff', path: file }] } }, 450, () => {
      task.contents = mockContents(run.agent, true);
      task.files = mockDiff(run.agent);
    });
    send({ kind: 'bridge', line: '◆ tg-bridge · Sửa tiêu đề (60%)', data: { tool: 'report_progress', step: 'Sửa tiêu đề', pct: 60, note: null } }, 300);
    if (run.agent === 'claude') {
      send({ kind: 'bridge', line: '◆ tg-bridge · đề xuất chuyển cho codex: Viết test cho tiêu đề mới', data: { tool: 'handoff_to', id: `handoff-${runId}`, agent: 'codex', task: 'Viết test cho tiêu đề mới', files: ['src/app/app.spec.ts'] } }, 470);
    }
    send({ kind: 'message', data: { text: 'fix: sửa lỗi theo yêu cầu' } }, 500);
    send({ kind: 'plan', data: { entries: [
      { content: 'Chạy test hiện tại', status: allowed ? 'completed' : 'pending' },
      { content: 'Sửa theo yêu cầu', status: 'completed' },
    ] } }, 520);
    send({
      kind: 'usage',
      usage: { inputTokens: 2400, cachedInputTokens: 12000, outputTokens: 610, costUsd: run.agent === 'claude' ? 0.04 : null, source: run.agent === 'claude' ? 'reported' : 'tokens', cumulative: true },
    }, 540);
    this.endTurn(runId, run, 580);
  }

  /** A session that stays open waits for the next message; a pipeline step ends. */
  private endTurn(runId: string, run: MockRun, delay: number): void {
    if (run.open) this.later(runId, run, { kind: 'turn_end', data: { status: 'done' } }, delay);
    else this.later(runId, run, { kind: 'exit', code: 0, data: { status: 'done' } }, delay);
  }

  async sendMessage(runId: string, prompt: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run?.open) throw new Error('Phiên này đã đóng.');
    if (run.active) throw new Error('Agent đang chạy. Hãy chờ hoặc dừng trước.');
    run.active = true;
    this.later(runId, run, { kind: 'user', line: prompt }, 0);
    this.later(runId, run, { kind: 'message', data: { text: `Đã nhận: ${prompt.slice(0, 60)}` } }, 300);
    this.endTurn(runId, run, 700);
  }

  async getDiff(runId: string): Promise<FileDiff[]> {
    return this.task(runId).files;
  }

  async acceptHunk(runId: string, path: string, hunkId: string): Promise<void> {
    const task = this.task(runId);
    this.dropHunk(task, path, hunkId);
    task.accepted += 1;
    task.staged.add(path);
  }

  async acceptAll(runId: string): Promise<number> {
    const task = this.task(runId);
    if (this.runs.get(runId)?.active) throw new Error('Agent vẫn đang chạy. Hãy chờ agent xong rồi mới dùng bản này.');
    if (!task.files.length) throw new Error('Không còn thay đổi nào để áp dụng.');
    const count = task.files.length;
    task.accepted += task.files.reduce((n, f) => n + f.hunks.length, 0);
    for (const f of task.files) task.staged.add(f.path);
    task.files = [];
    return count;
  }

  async rejectHunk(runId: string, path: string, hunkId: string): Promise<void> {
    this.dropHunk(this.task(runId), path, hunkId);
  }

  async stagedFiles(runId: string): Promise<string[]> {
    return [...this.task(runId).staged].sort();
  }

  async commitAccepted(runId: string, message: string): Promise<string> {
    const task = this.task(runId);
    if (!task.accepted) throw new Error('Chưa có thay đổi nào được chấp nhận để commit.');
    if (!message.trim()) throw new Error('Cần nhập nội dung commit.');
    task.accepted = 0;
    task.staged.clear();
    return 'abc1234def5678';
  }

  async discardWorktree(runId: string): Promise<void> {
    this.task(runId);
    await this.stop(runId);
    this.tasks.delete(runId);
    this.runs.delete(runId);
  }

  async listFiles(runId: string): Promise<string[]> {
    return [...this.task(runId).contents.keys()].sort();
  }

  async readFile(runId: string, path: string): Promise<string> {
    const text = this.task(runId).contents.get(path);
    if (text === undefined) throw new Error(`Không mở được ${path}.`);
    return text;
  }

  async writeFile(runId: string, path: string, content: string): Promise<void> {
    const task = this.task(runId);
    if (this.runs.get(runId)?.active) throw new Error('Agent đang chạy. Hãy chờ agent xong rồi mới sửa tệp.');
    if (!task.contents.has(path)) throw new Error(`${path} không còn trong worktree.`);
    task.contents.set(path, content);
  }

  async composeRuns(picks: Pick[]): Promise<Composite> {
    if (!picks.length) throw new Error('Hãy chọn ít nhất một thay đổi để ghép.');
    const byPath = new Map<string, FileDiff>();
    for (const p of picks) {
      const file = this.task(p.runId).files.find((f) => f.path === p.path);
      const hunk = file?.hunks.find((h) => h.id === p.hunkId);
      if (!file || !hunk) throw new Error('Hunk đã thay đổi hoặc không tồn tại; hãy tải lại.');
      const into = byPath.get(p.path) ?? { ...file, hunks: [] };
      // Two hunks for the same lines cannot both apply, like `git apply` in the core.
      if (into.hunks.some((h) => h.oldStart === hunk.oldStart)) {
        throw new Error(`Thay đổi ở ${p.path} không ghép được với các thay đổi đã chọn trước đó (trùng chỗ sửa).`);
      }
      into.hunks = [...into.hunks, hunk];
      byPath.set(p.path, into);
    }
    const id = crypto.randomUUID();
    const files = [...byPath.values()];
    this.composites.set(id, files);
    return { id, files };
  }

  async checkComposite(id: string, command: string): Promise<CheckResult> {
    this.composite(id);
    if (!command.trim()) throw new Error('Hãy nhập lệnh kiểm tra, ví dụ npm test.');
    const failed = command.includes('fail');
    await new Promise((r) => setTimeout(r, 300));
    return {
      code: failed ? 1 : 0,
      output: `> ${command}\n${failed ? '✕ 1 test failed: tiêu đề sai' : '✓ 12 tests passed'}\n`,
      truncated: false,
      durationMs: 300,
    };
  }

  async applyComposite(id: string): Promise<number> {
    return this.composite(id).length;
  }

  async commitComposite(id: string, message: string): Promise<string> {
    this.composite(id);
    if (!message.trim()) throw new Error('Cần nhập nội dung commit.');
    return 'mix5678def1234';
  }

  async discardComposite(id: string): Promise<void> {
    this.composite(id);
    this.composites.delete(id);
  }

  private composite(id: string): FileDiff[] {
    const c = this.composites.get(id);
    if (!c) throw new Error('Bản ghép không còn. Hãy tạo lại.');
    return c;
  }

  private task(runId: string): MockTask {
    const task = this.tasks.get(runId);
    if (!task) throw new Error('Không tìm thấy worktree mô phỏng.');
    return task;
  }

  private dropHunk(task: MockTask, path: string, hunkId: string): void {
    task.files = task.files
      .map((f) => (f.path === path ? { ...f, hunks: f.hunks.filter((h) => h.id !== hunkId) } : f))
      .filter((f) => f.hunks.length > 0);
  }

  private later(runId: string, run: MockRun, partial: Partial<AgentEvent>, delay: number, effect?: () => void): void {
    run.timers.push(setTimeout(() => {
      effect?.();
      if (partial.kind === 'exit') { run.active = false; run.open = false; }
      if (partial.kind === 'turn_end') run.active = false;
      this.emit({ runId, agent: run.agent, kind: 'log', line: null, usage: null, code: null, data: null, atMs: Date.now(), ...partial });
    }, delay));
  }

  async stop(runId: string) {
    const run = this.runs.get(runId);
    if (!run || (!run.active && !run.open)) return;
    run.timers.forEach(clearTimeout);
    run.active = false;
    run.open = false;
    this.emit({ runId, agent: run.agent, kind: 'exit', line: null, usage: null, code: null, data: null, atMs: Date.now() });
  }

  async listRuns(): Promise<StoredRun[]> {
    return [];
  }

  async accountLimits(): Promise<AccountLimits[]> {
    return [];
  }

  /** Two weeks of plausible history plus this session's runs. */
  async usageReport(since: number): Promise<UsageRow[]> {
    const day = 86_400_000;
    const start = new Date();
    start.setHours(9, 0, 0, 0);
    const history: UsageRow[] = [];
    let seed = 7;
    const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    for (let d = 1; d <= 20; d++) {
      for (const agent of ['claude', 'codex', 'gemini'] as AgentId[]) {
        const n = Math.floor(rand() * 3);
        for (let i = 0; i < n; i++) {
          const startedAt = start.getTime() - d * day + i * 3_600_000;
          const input = 2000 + Math.round(rand() * 9000);
          history.push({
            id: `hist-${d}-${agent}-${i}`, agent, prompt: ['Sửa lỗi đăng nhập', 'Thêm test', 'Đổi tên biến', 'Viết README'][i % 4],
            startedAt, endedAt: startedAt + 90_000, status: 'done', group: null,
            usage: { inputTokens: input, cachedInputTokens: input * 6, outputTokens: Math.round(input / 4),
              costUsd: agent === 'claude' ? Math.round(input * 0.00003 * 100) / 100 : null, source: agent === 'claude' ? 'reported' : 'tokens', cumulative: true },
          });
        }
      }
    }
    return [...this.ledger.values(), ...history].filter((r) => r.startedAt >= since).sort((a, b) => b.startedAt - a.startedAt);
  }

  async listPrices(): Promise<PriceRow[]> {
    return [...this.prices];
  }

  async addPrice(price: PriceRow): Promise<void> {
    if ([price.input, price.cachedInput, price.output].some((v) => v !== null && (!Number.isFinite(v) || v < 0))) throw new Error('Giá phải là số không âm.');
    this.prices = [...this.prices.filter((p) => !(p.agent === price.agent && p.fromMs === price.fromMs)), price];
  }

  async getSetting(key: SettingKey): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async bridgeNotes(runId: string): Promise<BridgeNote[]> {
    const run = this.runs.get(runId);
    return run ? [{ topic: 'plan', agent: run.agent, at: Date.now() - 60_000, text: '1. Đọc app.ts\n2. Đổi tiêu đề\n3. Chạy test' }] : [];
  }

  async setSetting(key: SettingKey, value: string): Promise<void> {
    JSON.parse(value);
    this.settings.set(key, value);
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    return {
      app: { name: 'TG Studio', version: 'mock' }, os: { family: 'browser', arch: 'n/a' }, generatedAt: Date.now(),
      agents: await this.detectAgents(), runs: [...this.ledger.values()].slice(0, 30), mcpServers: this.mcp.map((s) => ({ name: s.name, transport: s.transport, agents: s.agents })),
    };
  }

  async listMcpServers(): Promise<McpServer[]> {
    return this.mcp.map((s) => ({ ...s }));
  }

  /** Same rules as mcp.rs `validate`. */
  async saveMcpServer(server: McpServer): Promise<McpServer> {
    const s = { ...server, id: server.id || crypto.randomUUID() };
    if (!/^[A-Za-z0-9_-]+$/.test(s.name)) throw new Error('Tên server chỉ gồm chữ, số, - và _.');
    if (this.mcp.some((o) => o.id !== s.id && o.name === s.name)) throw new Error(`Đã có server tên ${s.name}.`);
    if (s.transport === 'stdio' && !s.command?.trim()) throw new Error('Server stdio cần lệnh chạy.');
    if (s.transport === 'http' && !/^https?:\/\//.test(s.url ?? '')) throw new Error('Server http cần URL bắt đầu bằng http:// hoặc https://.');
    this.mcp = this.mcp.some((o) => o.id === s.id) ? this.mcp.map((o) => (o.id === s.id ? s : o)) : [...this.mcp, s];
    return { ...s };
  }

  async deleteMcpServer(id: string): Promise<void> {
    this.mcp = this.mcp.filter((s) => s.id !== id);
  }

  async listSkills(): Promise<Skill[]> {
    return [...this.skills.values()].map(parseSkill).sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveSkill(content: string): Promise<Skill> {
    const skill = parseSkill(content);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill.name)) throw new Error('name chỉ gồm chữ thường, số và -, tối đa 64 ký tự.');
    this.skills.set(skill.name, content);
    return skill;
  }

  async deleteSkill(name: string): Promise<void> {
    this.skills.delete(name);
  }

  async skillTargets(name: string, repo: string | null): Promise<SkillTarget[]> {
    const content = this.skills.get(name);
    if (content === undefined) throw new Error('Không có skill này trong thư viện.');
    const where = (scope: 'project' | 'user') => (scope === 'project' ? `${repo}/.claude/skills/${name}/SKILL.md` : `~/.claude/skills/${name}/SKILL.md`);
    return (repo ? (['project', 'user'] as const) : (['user'] as const)).map((scope) => {
      const existing = this.installed.get(where(scope));
      return { scope, path: where(scope), state: existing === undefined ? 'missing' : existing === content ? 'same' : 'different' };
    });
  }

  async installSkill(name: string, scope: 'project' | 'user', repo: string | null): Promise<SkillInstalled> {
    const target = (await this.skillTargets(name, repo)).find((t) => t.scope === scope);
    if (!target) throw new Error('Chọn một repo Git để cài ở mức project.');
    this.installed.set(target.path, this.skills.get(name)!);
    return { path: target.path, backup: target.state === 'different' ? `${target.path}.bak-${Date.now()}` : null };
  }

  async saveExport(name: string, content: string): Promise<string> {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return `Downloads/${name}`;
  }

  async onEvent(handler: (e: AgentEvent) => void): Promise<Unlisten> {
    this.handlers.push(handler);
    return () => (this.handlers = this.handlers.filter((h) => h !== handler));
  }

  private emit(e: AgentEvent) {
    const row = this.ledger.get(e.runId) ?? { id: e.runId, agent: e.agent, prompt: '', startedAt: e.atMs, endedAt: null, status: 'running' as const, group: null, usage: null };
    if (e.kind === 'usage' && e.usage) row.usage = e.usage;
    if (e.kind === 'exit') {
      row.endedAt = e.atMs;
      row.status = e.code === 0 ? 'done' : 'stopped';
    }
    this.ledger.set(e.runId, row);
    this.handlers.forEach((h) => h(e));
  }
}

/** Same rules as skills.rs `front_matter`. */
function parseSkill(content: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) throw new Error('SKILL.md phải bắt đầu bằng front matter (---).');
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1])?.[1].trim().replace(/^"|"$/g, '') ?? '';
  const name = field('name');
  const description = field('description');
  if (!name) throw new Error('Front matter thiếu name.');
  if (!description) throw new Error('Front matter thiếu description.');
  return { name, description, content };
}
