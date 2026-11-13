import { AgentBackend, SettingKey, Unlisten } from '../backend';
import { AccountLimits, AgentEvent, AgentOptions, BridgeNote, AgentId, CheckResult, Composite, DetectedAgent, FileDiff, McpServer, OwnChange, OwnChanges, Pick, PriceRow, Project, Skill, SkillInstalled, SkillTarget, StoredRun, Usage, UsageRow, GitPlan, AgentCommand, ProcStat, ResourceReport, UsageGroup, AppVersion, LatestVersion, SyncStatus, TerminalInfo, ProjectSettings } from '../protocol';
import { AGENT_META } from '../../services/agents/agent-meta';
import { mockContents, mockDiff, mockLimits, parseSkill } from './mock-fixtures';

/** The version the mock reports; `npm run version:sync` keeps it equal to package.json. */
const APP_VERSION = '0.6.7';

interface MockRun {
  /** Its session waits for more messages after a turn. */
  open?: boolean;
  agent: AgentId;
  /** Shown in the usage table, as the core stores it. */
  prompt: string;
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
  /** Direct runs: uncommitted files the user changed before the agent started. */
  own: OwnChange[];
  direct: boolean;
}

/** Each agent gets a slightly different result, so the compare view has something to compare. */
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
      { id: 'kiro', name: 'Kiro CLI', binary: 'kiro-cli', path: '~/.local/bin/kiro-cli', version: 'mock', headless: false, auth: 'ok' },
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
    const prepared = this.prepared.has(root);
    return {
      root, name, branch: git === 'none' && !prepared ? null : 'main', git: prepared ? 'ready' : git, adjusted: null,
      uncommitted: root.includes('dirty') ? 3 : 0, gitUser: !root.includes('noname'),
    };
  }

  private readonly prepared = new Set<string>();

  async gitPlan(_root: string): Promise<GitPlan> {
    return { files: 12, ignore: ['.env', 'node_modules/'] };
  }

  async gitPrepare(root: string, name: string | null, _email: string | null): Promise<Project> {
    if (root.includes('noname') && !name?.trim()) throw new Error('Git chưa có tên và email để commit. Hãy nhập cả hai.');
    this.prepared.add(root);
    return this.openProject(root);
  }

  async listProjectFiles(_root: string): Promise<string[]> {
    return ['README.md', 'package.json', 'src/app/app.ts'];
  }

  async readProjectFile(_root: string, path: string): Promise<string> {
    return `// ${path}\n// Nội dung mẫu của mock mode.\n`;
  }

  async agentCommands(agent: AgentId): Promise<AgentCommand[]> {
    await new Promise((r) => setTimeout(r, 300));
    const c = (name: string, description: string, kind: AgentCommand['kind'], source: AgentCommand['source'], insert: string, plugin: string | null = null, hint: string | null = null): AgentCommand =>
      ({ name, description, kind, source, plugin, hint, insert });
    if (agent === 'codex') return [
      c('$review-checklist', 'Danh sách kiểm tra khi review của dự án', 'skill', 'project', '$review-checklist '),
      c('$documents:documents', 'Tạo và sửa tài liệu .docx', 'skill', 'plugin', '$documents:documents ', 'documents'),
      c('plan', 'Turn plan mode on.', 'command', null, '/plan '),
      c('review', 'Review uncommitted changes, or review with custom instructions.', 'command', null, '/review '),
    ];
    return [
      c('release-notes', 'Viết ghi chú phát hành theo mẫu của dự án', 'skill', 'project', '/release-notes '),
      c('formflow-init', 'FormFlow Angular Project Scaffold', 'skill', 'user', '/formflow-init '),
      c('superpowers:brainstorming', 'You MUST use this before any creative work', 'skill', 'plugin', '/superpowers:brainstorming ', 'superpowers'),
      c('superpowers:writing-plans', 'Use when you have a spec or requirements for a multi-step task', 'skill', 'plugin', '/superpowers:writing-plans ', 'superpowers'),
      c('compact', 'Free up context by summarizing the conversation so far', 'command', null, '/compact ', null, '<optional custom summarization instructions>'),
      c('model', 'Set the AI model for Claude Code', 'command', null, '/model ', null, '<model>'),
    ];
  }

  async agentOptions(agent: AgentId): Promise<AgentOptions> {
    await new Promise((r) => setTimeout(r, 300));
    const effort = { id: 'effort', current: 'default', options: ['default', 'low', 'medium', 'high'].map((v) => ({ value: v, name: v === 'default' ? 'Default' : v[0].toUpperCase() + v.slice(1), description: null })) };
    if (agent === 'claude') return {
      model: { id: 'model', current: 'default', options: [
        { value: 'default', name: 'Default (recommended)', description: 'Sonnet 4.6 · cân bằng' },
        { value: 'claude-opus-4-6', name: 'Opus 4.6', description: 'Mạnh nhất cho việc phức tạp' },
        { value: 'claude-sonnet-4-6', name: 'Sonnet 4.6', description: 'Hiệu quả cho việc thường ngày' },
        { value: 'claude-haiku-4-5', name: 'Haiku 4.5', description: 'Nhanh nhất' },
      ] },
      effort,
    };
    if (agent === 'codex') return {
      model: { id: 'model', current: 'gpt-5-codex', options: [
        { value: 'gpt-5-codex', name: 'gpt-5-codex', description: 'Tối ưu cho code' },
        { value: 'gpt-5', name: 'gpt-5', description: 'Đa năng' },
      ] },
      effort,
    };
    return { model: null, effort: null };
  }

  async windowAction(): Promise<void> {}

  readonly approvals = new Map<string, string>();
  async setApproval(runId: string, approval: string): Promise<void> {
    this.approvals.set(runId, approval);
  }

  async listBranches(): Promise<string[]> {
    return ['main', 'develop', 'release/v0.0.5'];
  }

  async start(agent: AgentId, prompt: string, _cwd?: string, _thread: string | null = null, _resumeFrom: string | null = null, _scope: string | null = null): Promise<string> {
    const runId = crypto.randomUUID();
    // Claude keeps one process for a whole Chỉ hỏi conversation, as the core does.
    const run: MockRun = { agent, prompt, timers: [], active: true, open: agent === 'claude' };
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
    emit({ line: 'Dự án dùng **Angular 21** (đọc từ `package.json`). Điểm đáng chú ý:\n\n- Signal forms chính thức\n- Build nhanh hơn với esbuild\n- Không có breaking change đáng kể\n\n```json\n\"@angular/core\": \"21.2.20\"\n```' }, 1500);
    emit({ kind: 'usage', usage }, 1900);
    if (agent === 'claude') emit({ kind: 'limits', data: mockLimits() as unknown as AgentEvent['data'] }, 1950);
    this.endTurn(runId, run, 2100);
    return runId;
  }

  /** A scripted code task: approval card, then two changed files to review. */
  /** The mock starts instantly: nothing to open ahead of time. */
  async warmTask(_agent: AgentId, _repo: string, _scope: string | null): Promise<void> {}

  async startTask(agent: AgentId, prompt: string, repo: string, _group: string | null = null, reuse: string | null = null, singleTurn = false, _recap: string | null = null, _thread: string | null = null, _scope: string | null = null, _prefs: unknown = null, _place: string | null = null, _base: string | null = null, approval: string | null = null): Promise<string> {
    const previous = reuse ? this.task(reuse) : null;
    if (reuse && this.runs.get(reuse)?.active) throw new Error('Bước trước vẫn đang chạy.');
    const runId = crypto.randomUUID();
    const run: MockRun = { agent, prompt, timers: [], active: true, open: !singleTurn };
    this.runs.set(runId, run);
    this.tasks.set(runId, previous
      ? { files: previous.files, contents: previous.contents, root: previous.root, accepted: 0, staged: previous.staged, pending: true, own: previous.own, direct: previous.direct }
      : { files: [], contents: mockContents(agent, false), root: `${repo}/.tg/worktrees/${runId}`, accepted: 0, staged: new Set<string>(), pending: true,
          own: _place === 'draft' ? [] : [{ path: 'src/styles.scss', status: 'M' }], direct: _place !== 'draft' });
    const send = (partial: Partial<AgentEvent>, delay: number) => this.later(runId, run, partial, delay);
    send({ kind: 'started', line: `mock ${agent} · ${repo}` }, 20);
    if (approval === 'deny') {
      // Chỉ hỏi through ACP: reads, answers, changes nothing.
      send({ kind: 'tool', data: { toolCallId: 'r1', title: 'Đọc package.json', kind: 'read', status: 'completed' } }, 60);
      send({ kind: 'message', data: { text: 'Dự án dùng **Angular 22** (mock). Mình chỉ đọc, không sửa tệp nào.' } }, 120);
      this.tasks.get(runId)!.pending = false;
      this.endTurn(runId, run, 200);
      return runId;
    }
    send({ kind: 'message', data: { text: 'Mình sẽ chạy test ' } }, 60);
    send({ kind: 'message', data: { text: 'trước khi sửa.' } }, 100);
    send({ kind: 'plan', data: { entries: [
      { content: 'Chạy test hiện tại', status: 'in_progress' },
      { content: `Sửa theo yêu cầu: ${prompt.slice(0, 40)}`, status: 'pending' },
    ] } }, 140);
    send({ kind: 'tool', data: { toolCallId: 't1', title: 'npm test', kind: 'execute', status: 'pending' } }, 180);
    if (approval === 'auto') {
      // Tự động: no card; the run goes on as if allowed.
      setTimeout(() => void this.respondPermission(runId, `perm-${runId}`, 'allow', false).catch(() => {}), 220);
      return runId;
    }
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
    // "chia việc" / "giao" in the request: Claude delegates the tests to Codex and waits for it.
    const delegating = run.agent === 'claude' && /chia|giao/i.test(run.prompt);
    const late = delegating ? 2300 : 0;
    if (delegating) this.delegateMock(runId, run);
    else if (run.agent === 'claude') {
      send({ kind: 'bridge', line: '◆ tg-bridge · đề xuất chuyển cho codex: Viết test cho tiêu đề mới', data: { tool: 'handoff_to', id: `handoff-${runId}`, agent: 'codex', task: 'Viết test cho tiêu đề mới', files: ['src/app/app.spec.ts'] } }, 470);
    }
    if (delegating) send({ kind: 'message', data: { text: 'Mình sửa tiêu đề; giao **Codex** viết test và một **Claude** phụ cập nhật docs, chạy song song.\n\n' } }, 320);
    send({ kind: 'message', data: { text: delegating
      ? 'fix: sửa lỗi theo yêu cầu\n\nĐã sửa tiêu đề trong `src/app/app.ts`. Codex viết xong test trong `src/app/app.spec.ts`, Claude phụ cập nhật `docs/user-guide.md`; cả hai đã gộp vào thư mục.'
      : 'fix: sửa lỗi theo yêu cầu\n\nĐã sửa tiêu đề trong `src/app/app.ts` và chạy lại **toàn bộ test**:\n\n- Đổi chuỗi tiêu đề\n- Cập nhật test liên quan' } }, 500 + late);
    send({ kind: 'plan', data: { entries: [
      { content: 'Chạy test hiện tại', status: allowed ? 'completed' : 'pending' },
      { content: 'Sửa theo yêu cầu', status: 'completed' },
    ] } }, 520 + late);
    send({
      kind: 'usage',
      usage: { inputTokens: 2400, cachedInputTokens: 12000, outputTokens: 610, costUsd: run.agent === 'claude' ? 0.04 : null, source: run.agent === 'claude' ? 'reported' : 'tokens', cumulative: true },
    }, 540 + late);
    this.endTurn(runId, run, 580 + late);
  }

  /** Mock tg-bridge `delegate`: a Codex and a helper Claude nested in the parent, merged back when done. */
  private delegateMock(parentId: string, parent: MockRun): void {
    this.delegateOne(parentId, parent, { n: 1, agent: 'codex', task: 'Viết test cho tiêu đề mới', file: 'src/app/app.spec.ts',
      reply: 'Đã thêm 3 test cho tiêu đề mới trong `src/app/app.spec.ts`.', cost: null, at: 340, takes: 1500 });
    this.delegateOne(parentId, parent, { n: 2, agent: 'claude', task: 'Cập nhật tiêu đề trong docs/user-guide.md', file: 'docs/user-guide.md',
      reply: 'Đã đổi tiêu đề ở mục 3 của `docs/user-guide.md`.', cost: 0.01, at: 380, takes: 1000 });
  }

  private delegateOne(parentId: string, parent: MockRun, o: { n: number; agent: AgentId; task: string; file: string; reply: string; cost: number | null; at: number; takes: number }): void {
    const id = `dlg-${parentId}-${crypto.randomUUID().slice(0, 8)}-${o.n}`;
    const childId = crypto.randomUUID();
    const name = AGENT_META[o.agent].name;
    // In the user's folder the child works there too; only a draft parent gives it a draft.
    const parentTask = this.tasks.get(parentId);
    const root = parentTask?.direct ? parentTask.root : `${parentTask?.root ?? '/mock'}/.tg/worktrees/${childId}`;
    const worktree = parentTask?.direct ? null : root;
    const base = { id, parent: parentId, agent: o.agent, task: o.task, summary: null, filesChanged: [] as string[], conflicts: [] as string[] };
    const toParent = (data: Record<string, unknown>, line: string, delay: number, effect?: () => void) =>
      this.later(parentId, parent, { kind: 'bridge', line, data: { ...base, ...data } }, delay, effect);
    toParent({ tool: 'delegate', child: null, status: 'running', worktree: null }, `◆ tg-bridge · giao cho ${name}: ${o.task}`, o.at, () => {
      const child: MockRun = { agent: o.agent, prompt: o.task, timers: [], active: true, open: false };
      this.runs.set(childId, child);
      this.tasks.set(childId, { files: [], contents: mockContents(o.agent, false), root, accepted: 0, staged: new Set<string>(), pending: false, own: [], direct: false });
      const send = (partial: Partial<AgentEvent>, delay: number) => this.later(childId, child, partial, delay);
      const t = (f: number) => Math.round(o.takes * f);
      send({ kind: 'started', line: `mock ${o.agent} · ${root}`, data: { parent: parentId } }, 10);
      send({ kind: 'tool', data: { toolCallId: 'c1', title: 'Đọc src/app/app.ts', kind: 'read', status: 'completed' } }, t(0.2));
      send({ kind: 'tool', data: { toolCallId: 'c2', title: `Sửa ${o.file}`, kind: 'edit', status: 'pending', locations: [{ path: `${root}/${o.file}`, line: 1 }] } }, t(0.4));
      send({ kind: 'tool', data: { toolCallId: 'c2', status: 'completed' } }, t(0.7));
      send({ kind: 'message', data: { text: o.reply } }, t(0.85));
      send({ kind: 'usage', usage: { inputTokens: 1800, cachedInputTokens: 6000, outputTokens: 420, costUsd: o.cost, source: o.cost === null ? 'tokens' : 'reported', cumulative: true } }, t(0.9));
      send({ kind: 'exit', code: 0, data: { status: 'done' } }, o.takes);
      toParent({ tool: 'delegate', child: childId, status: 'running', worktree }, `◆ tg-bridge · giao cho ${name}: ${o.task}`, 30);
      toParent({ tool: 'delegate_done', child: childId, status: 'done', worktree: null, filesChanged: [o.file], summary: o.reply },
        `◆ tg-bridge · ${name} done: ${o.task}`, o.takes + 100);
    });
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
    // A later message can delegate again: its nested agents sit under that message.
    if (run.agent === 'claude' && /chia|giao/i.test(prompt)) {
      this.delegateMock(runId, run);
      this.later(runId, run, { kind: 'message', data: { text: 'Đã giao lại cho **Codex** và một **Claude** phụ; cả hai xong rồi.' } }, 2300);
      this.endTurn(runId, run, 2500);
      return;
    }
    const reply = `Về "${prompt.slice(0, 60)}", mình xem lại các phần liên quan:\n\n- \`src/app/app.ts\`: trạng thái và các hàm chính\n- \`src/app\`: giao diện và dịch vụ\n- \`docs/\`: tài liệu dự án`;
    this.later(runId, run, { kind: 'message', data: { text: reply } }, 300);
    this.endTurn(runId, run, 700);
  }

  async getDiff(runId: string): Promise<FileDiff[]> {
    return this.task(runId).files;
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

  async commitAccepted(runId: string, message: string): Promise<string> {
    const task = this.task(runId);
    if (!task.accepted) throw new Error('Chưa có thay đổi nào được chấp nhận để commit.');
    if (!message.trim()) throw new Error('Cần nhập nội dung commit.');
    task.accepted = 0;
    task.staged.clear();
    return 'abc1234def5678';
  }

  async ownChanges(runId: string): Promise<OwnChanges> {
    const task = this.task(runId);
    return { direct: task.direct, files: task.own };
  }

  async revertFiles(runId: string, paths: string[]): Promise<void> {
    if (this.runs.get(runId)?.active) throw new Error('Agent đang sửa. Hãy dừng hoặc chờ agent xong rồi mới hoàn tác.');
    const task = this.task(runId);
    const missing = paths.find((p) => !task.files.some((f) => f.path === p));
    if (missing) throw new Error(`${missing} không còn trong thay đổi của agent; hãy tải lại.`);
    task.files = task.files.filter((f) => !paths.includes(f.path));
  }

  /** Commits made in the mock since the last push. */
  private ahead = 0;
  private pushed = false;
  private pr: string | null = null;

  async syncStatus(root: string): Promise<SyncStatus> {
    // A path naming "noremote" simulates a repository without a remote.
    if (root.includes('noremote')) return { branch: 'main', upstream: null, ahead: 0, behind: 0, remote: null, github: false, gh: true, defaultBranch: null, prUrl: null };
    return { branch: 'tg/demo', upstream: this.pushed ? 'origin/tg/demo' : null, ahead: this.ahead, behind: 0, remote: 'origin', github: true, gh: true, defaultBranch: 'main', prUrl: this.pr };
  }

  async push(root: string): Promise<SyncStatus> {
    if (root.includes('noremote')) throw new Error('Repo chưa có remote để push.');
    await new Promise((r) => setTimeout(r, 400));
    this.ahead = 0;
    this.pushed = true;
    return this.syncStatus(root);
  }

  async createPr(root: string, title: string, _body: string): Promise<string> {
    if (!title.trim()) throw new Error('Hãy nhập tiêu đề PR.');
    await this.push(root);
    this.pr = 'https://github.com/example/demo/pull/1';
    return this.pr;
  }

  async openUrl(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener');
  }

  async commitFiles(runId: string, paths: string[], message: string): Promise<string> {
    if (this.runs.get(runId)?.active) throw new Error('Agent đang sửa. Hãy dừng hoặc chờ agent xong rồi mới commit.');
    if (!paths.length) throw new Error('Chưa chọn tệp nào để commit.');
    if (!message.trim()) throw new Error('Hãy nhập nội dung commit.');
    const task = this.task(runId);
    task.files = task.files.filter((f) => !paths.includes(f.path));
    task.own = task.own.filter((f) => !paths.includes(f.path));
    for (const p of paths) task.staged.delete(p);
    this.ahead += 1;
    return 'abc1234def5678';
  }

  async discardWorktree(runId: string): Promise<void> {
    this.task(runId);
    await this.stop(runId);
    this.tasks.delete(runId);
    this.runs.delete(runId);
  }

  async deleteRuns(runIds: string[]): Promise<void> {
    if (runIds.some((id) => this.runs.get(id)?.active)) throw new Error('Hãy dừng agent trước khi xoá cuộc trò chuyện.');
    for (const id of runIds) {
      if (this.runs.has(id)) await this.stop(id);
      this.tasks.delete(id);
      this.runs.delete(id);
    }
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

  private readonly attached = new Map<string, string>();

  async saveAttachment(name: string, data: string): Promise<string> {
    const path = `/Users/you/Library/Application Support/tg-studio/attachments/${this.attached.size + 1}/${name}`;
    const type = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.gif$/i.test(name) ? 'image/gif' : /\.webp$/i.test(name) ? 'image/webp' : 'application/octet-stream';
    this.attached.set(path, `data:${type};base64,${data}`);
    return path;
  }

  async readAttachment(path: string): Promise<string> {
    const url = this.attached.get(path);
    if (!url?.startsWith('data:image/')) throw new Error('Không tìm thấy tệp đính kèm.');
    return url;
  }

  async appVersion(): Promise<AppVersion> {
    return { version: APP_VERSION, commit: 'mock', builtAt: Date.now() };
  }

  async latestVersion(): Promise<LatestVersion> {
    return { latest: APP_VERSION, newer: false };
  }

  /** Plausible numbers: the app, one process tree per live run, and a stray probe. */
  async resourceUsage(): Promise<ResourceReport> {
    const mb = 1024 * 1024;
    const wobble = () => 0.9 + Math.random() * 0.2;
    const proc = (pid: number, parent: number | null, name: string, memory: number, cpu: number): ProcStat =>
      ({ pid, parent, name, memory: Math.round(memory * mb * wobble()), cpu: Math.round(cpu * wobble() * 10) / 10 });
    const group = (kind: UsageGroup['kind'], runId: string | null, processes: ProcStat[]): UsageGroup =>
      ({ kind, runId, processes, memory: processes.reduce((s, p) => s + p.memory, 0), cpu: processes.reduce((s, p) => s + p.cpu, 0) });
    const groups: UsageGroup[] = [group('app', null, [proc(100, null, 'tg-studio', 104, 0.3)])];
    let pid = 200;
    for (const [id, run] of this.runs) {
      if (!run.active && !run.open) continue;
      const root = pid++;
      const cli = run.agent === 'codex' ? 'codex-acp' : run.agent === 'claude' ? 'claude' : `${run.agent}-cli`;
      groups.push(group('run', id, [proc(root, 100, cli, 240, run.active ? 6 : 0.2), proc(pid++, root, 'node (MCP)', 88, 0)]));
    }
    groups.push(group('other', null, [proc(900, 100, 'claude-agent-acp', 70, 0)]));
    return { at: Date.now(), cores: 8, webview: false, groups,
      memory: groups.reduce((s, g) => s + g.memory, 0), cpu: groups.reduce((s, g) => s + g.cpu, 0) };
  }

  async killProcess(_pid: number): Promise<void> {}

  async refreshClaudeLimits(): Promise<AccountLimits | null> {
    const hour = 3_600_000;
    return {
      agent: 'claude',
      at: Date.now(),
      windows: [
        { id: 'five_hour', utilization: 0.08, resetsAt: Date.now() + 3 * hour, status: null },
        { id: 'seven_day', utilization: 0.18, resetsAt: Date.now() + 40 * hour, status: null },
      ],
    };
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

  // A pretend shell: echoes what is typed and answers each line with a prompt.
  private shells = new Map<string, { id: string; cwd: string; line: string }>();
  private outputHandlers: ((id: string, data: string) => void)[] = [];
  private exitHandlers: ((id: string, code: number | null) => void)[] = [];

  private projectHooks = new Map<string, ProjectSettings>();
  /** Checks run per run, so a prompt naming "failcheck" fails once and then passes. */
  private checkCounts = new Map<string, number>();

  async projectSettings(root: string): Promise<ProjectSettings> {
    return this.projectHooks.get(root) ?? { setup: '', check: '', autoFix: true, maxFixRounds: 2 };
  }

  async setProjectSettings(root: string, s: ProjectSettings): Promise<void> {
    this.projectHooks.set(root, { ...s, maxFixRounds: Math.min(5, Math.max(1, Math.round(s.maxFixRounds))) });
  }

  async runProjectCheck(runId: string): Promise<CheckResult | null> {
    const run = this.runs.get(runId);
    const check = [...this.projectHooks.values()][0]?.check ?? '';
    if (!check.trim()) return null;
    const n = (this.checkCounts.get(runId) ?? 0) + 1;
    this.checkCounts.set(runId, n);
    await new Promise((r) => setTimeout(r, 300));
    const fail = !!run?.prompt?.includes('failcheck') && n === 1;
    return fail
      ? { code: 1, output: 'FAIL src/app/app.spec.ts\n  ✕ hiện tiêu đề (12 ms)\nTests: 1 failed, 8 passed', truncated: false, durationMs: 800 }
      : { code: 0, output: 'Tests: 9 passed', truncated: false, durationMs: 800 };
  }

  async runDir(runId: string): Promise<string> {
    const run = this.tasks.get(runId);
    if (!run) throw new Error('Không tìm thấy bản nháp của lượt chạy.');
    return `/mock/.tg/worktrees/${runId}`;
  }

  async terminalOpen(key: string, cwd: string, _cols?: number, _rows?: number): Promise<TerminalInfo> {
    const open = this.shells.get(key);
    if (open) return { id: open.id, shell: 'zsh', cwd: open.cwd, fresh: false };
    const id = crypto.randomUUID();
    this.shells.set(key, { id, cwd, line: '' });
    setTimeout(() => this.outputHandlers.forEach((h) => h(id, `Shell mô phỏng ở ${cwd}\r\n$ `)));
    return { id, shell: 'zsh', cwd, fresh: true };
  }

  async terminalWrite(id: string, data: string): Promise<void> {
    const shell = [...this.shells.values()].find((s) => s.id === id);
    if (!shell) throw new Error('Terminal đã đóng.');
    const out = (text: string) => this.outputHandlers.forEach((h) => h(id, text));
    for (const ch of data) {
      if (ch === '\r') {
        const cmd = shell.line.trim();
        shell.line = '';
        if (cmd === 'exit') {
          for (const [k, s] of this.shells) if (s.id === id) this.shells.delete(k);
          out('\r\n');
          this.exitHandlers.forEach((h) => h(id, 0));
          return;
        }
        out(`\r\n${cmd ? `(mô phỏng) ${cmd}\r\n` : ''}$ `);
      } else if (ch === '\u007f') {
        if (shell.line) { shell.line = shell.line.slice(0, -1); out('\b \b'); }
      } else {
        shell.line += ch;
        out(ch);
      }
    }
  }

  async terminalResize(): Promise<void> {}

  async terminalClose(id: string): Promise<void> {
    for (const [k, s] of this.shells) if (s.id === id) this.shells.delete(k);
  }

  async onTerminalOutput(handler: (id: string, data: string) => void): Promise<Unlisten> {
    this.outputHandlers.push(handler);
    return () => (this.outputHandlers = this.outputHandlers.filter((h) => h !== handler));
  }

  async onTerminalExit(handler: (id: string, code: number | null) => void): Promise<Unlisten> {
    this.exitHandlers.push(handler);
    return () => (this.exitHandlers = this.exitHandlers.filter((h) => h !== handler));
  }

  async onEvent(handler: (e: AgentEvent) => void): Promise<Unlisten> {
    this.handlers.push(handler);
    return () => (this.handlers = this.handlers.filter((h) => h !== handler));
  }

  private emit(e: AgentEvent) {
    const row = this.ledger.get(e.runId) ?? { id: e.runId, agent: e.agent, prompt: this.runs.get(e.runId)?.prompt ?? '', startedAt: e.atMs, endedAt: null, status: 'running' as const, group: null, usage: null };
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
