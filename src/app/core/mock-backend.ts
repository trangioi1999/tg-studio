import { AgentBackend, Unlisten } from './backend';
import { AccountLimits, AgentEvent, AgentId, CheckResult, Composite, DetectedAgent, FileDiff, LimitWindow, Pick, StoredRun, Usage } from './protocol';

interface MockRun {
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
        hunk('h2', '@@ -40,2 +41,2 @@ run()', [' run() {', '-  return 1;', '+  return 2;']),
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
  const app = Array.from({ length: 48 }, (_, i) => `// dòng ${i + 1}`);
  app.splice(9, 4, 'export class App {', `  title = "mới (${agent})";`, '  ready = true;', '}');
  app.splice(40, 3, 'run() {', '  return 2;', '}');
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
  private handlers: ((e: AgentEvent) => void)[] = [];

  async detectAgents(): Promise<DetectedAgent[]> {
    return [
      { id: 'claude', name: 'Claude Code', binary: 'claude', path: '/usr/local/bin/claude', version: 'mock', headless: true },
      { id: 'codex', name: 'Codex', binary: 'codex', path: '/opt/homebrew/bin/codex', version: 'mock', headless: true },
      { id: 'gemini', name: 'Gemini CLI', binary: 'gemini', path: '~/.nvm/.../gemini', version: 'mock', headless: true },
      { id: 'kiro', name: 'Kiro CLI', binary: 'kiro-cli', path: null, version: null, headless: false },
    ];
  }

  async homeDir(): Promise<string | null> {
    return '/Users/you/projects/demo';
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
  async startTask(agent: AgentId, prompt: string, repo: string, _group: string | null = null): Promise<string> {
    const runId = crypto.randomUUID();
    const run: MockRun = { agent, timers: [], active: true };
    this.runs.set(runId, run);
    this.tasks.set(runId, { files: [], contents: mockContents(agent, false), root: `${repo}/.tg/worktrees/${runId}`, accepted: 0, pending: true });
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
    send({ kind: 'message', data: { text: 'fix: sửa lỗi theo yêu cầu' } }, 500);
    send({ kind: 'plan', data: { entries: [
      { content: 'Chạy test hiện tại', status: allowed ? 'completed' : 'pending' },
      { content: 'Sửa theo yêu cầu', status: 'completed' },
    ] } }, 520);
    send({
      kind: 'usage',
      usage: { inputTokens: 2400, cachedInputTokens: 12000, outputTokens: 610, costUsd: run.agent === 'claude' ? 0.04 : null, source: run.agent === 'claude' ? 'reported' : 'tokens', cumulative: true },
    }, 540);
    send({ kind: 'exit', code: 0, data: { status: 'done' } }, 580);
  }

  async getDiff(runId: string): Promise<FileDiff[]> {
    return this.task(runId).files;
  }

  async acceptHunk(runId: string, path: string, hunkId: string): Promise<void> {
    const task = this.task(runId);
    this.dropHunk(task, path, hunkId);
    task.accepted += 1;
  }

  async acceptAll(runId: string): Promise<number> {
    const task = this.task(runId);
    if (this.runs.get(runId)?.active) throw new Error('Agent vẫn đang chạy. Hãy chờ agent xong rồi mới dùng bản này.');
    if (!task.files.length) throw new Error('Không còn thay đổi nào để áp dụng.');
    const count = task.files.length;
    task.accepted += task.files.reduce((n, f) => n + f.hunks.length, 0);
    task.files = [];
    return count;
  }

  async rejectHunk(runId: string, path: string, hunkId: string): Promise<void> {
    this.dropHunk(this.task(runId), path, hunkId);
  }

  async commitAccepted(runId: string, message: string): Promise<string> {
    const task = this.task(runId);
    if (!task.accepted) throw new Error('Chưa có thay đổi nào được chấp nhận để commit.');
    if (!message.trim()) throw new Error('Cần nhập nội dung commit.');
    task.accepted = 0;
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
      if (partial.kind === 'exit') run.active = false;
      this.emit({ runId, agent: run.agent, kind: 'log', line: null, usage: null, code: null, data: null, atMs: Date.now(), ...partial });
    }, delay));
  }

  async stop(runId: string) {
    const run = this.runs.get(runId);
    if (!run || !run.active) return;
    run.timers.forEach(clearTimeout);
    run.active = false;
    this.emit({ runId, agent: run.agent, kind: 'exit', line: null, usage: null, code: null, data: null, atMs: Date.now() });
  }

  async listRuns(): Promise<StoredRun[]> {
    return [];
  }

  async accountLimits(): Promise<AccountLimits[]> {
    return [];
  }

  async onEvent(handler: (e: AgentEvent) => void): Promise<Unlisten> {
    this.handlers.push(handler);
    return () => (this.handlers = this.handlers.filter((h) => h !== handler));
  }

  private emit(e: AgentEvent) {
    this.handlers.forEach((h) => h(e));
  }
}
