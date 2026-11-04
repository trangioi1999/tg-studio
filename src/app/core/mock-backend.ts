import { AgentBackend, Unlisten } from './backend';
import { AgentEvent, AgentId, DetectedAgent, FileDiff, StoredRun, Usage } from './protocol';

interface MockRun {
  agent: AgentId;
  timers: ReturnType<typeof setTimeout>[];
  active: boolean;
}

interface MockTask {
  files: FileDiff[];
  accepted: number;
  pending: boolean;
}

function mockDiff(): FileDiff[] {
  const hunk = (id: string, header: string, lines: string[]) => ({
    id, header, oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines,
    added: lines.filter((l) => l.startsWith('+')).length,
    removed: lines.filter((l) => l.startsWith('-')).length,
  });
  return [
    {
      path: 'src/app/app.ts', status: 'M', binary: false, patchHeader: '',
      hunks: [
        hunk('h1', '@@ -10,3 +10,4 @@ export class App', [' export class App {', '-  title = "cũ";', '+  title = "mới";', '+  ready = true;', ' }']),
        hunk('h2', '@@ -40,2 +41,2 @@ run()', [' run() {', '-  return 1;', '+  return 2;']),
      ],
    },
    {
      path: 'docs/ghi chú mới.md', status: 'A', binary: false, patchHeader: '',
      hunks: [hunk('h3', '@@ -0,0 +1,2 @@', ['+# Ghi chú', '+Nội dung mới'])],
    },
  ];
}

/**
 * Used when the UI runs in a normal browser (`npm start`), so you can build
 * screens without launching the desktop app. Emits a fake but realistic run.
 */
export class MockBackend extends AgentBackend {
  readonly mode = 'mock' as const;
  private runs = new Map<string, MockRun>();
  private tasks = new Map<string, MockTask>();
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
    emit({ kind: 'exit', code: 0 }, 2100);
    return runId;
  }

  /** A scripted code task: approval card, then two changed files to review. */
  async startTask(agent: AgentId, prompt: string, repo: string): Promise<string> {
    const runId = crypto.randomUUID();
    const run: MockRun = { agent, timers: [], active: true };
    this.runs.set(runId, run);
    this.tasks.set(runId, { files: mockDiff(), accepted: 0, pending: true });
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
    send({ kind: 'tool', data: { toolCallId: 't2', title: 'Sửa src/app/app.ts', kind: 'edit', status: 'completed' } }, 80);
    send({ kind: 'message', data: { text: 'fix: sửa lỗi theo yêu cầu' } }, 120);
    send({ kind: 'plan', data: { entries: [
      { content: 'Chạy test hiện tại', status: allowed ? 'completed' : 'pending' },
      { content: 'Sửa theo yêu cầu', status: 'completed' },
    ] } }, 140);
    send({
      kind: 'usage',
      usage: { inputTokens: 2400, cachedInputTokens: 12000, outputTokens: 610, costUsd: run.agent === 'claude' ? 0.04 : null, source: run.agent === 'claude' ? 'reported' : 'tokens', cumulative: true },
    }, 160);
    send({ kind: 'exit', code: 0, data: { status: 'done' } }, 200);
  }

  async getDiff(runId: string): Promise<FileDiff[]> {
    return this.task(runId).files;
  }

  async acceptHunk(runId: string, path: string, hunkId: string): Promise<void> {
    const task = this.task(runId);
    this.dropHunk(task, path, hunkId);
    task.accepted += 1;
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

  private later(runId: string, run: MockRun, partial: Partial<AgentEvent>, delay: number): void {
    run.timers.push(setTimeout(() => {
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

  async onEvent(handler: (e: AgentEvent) => void): Promise<Unlisten> {
    this.handlers.push(handler);
    return () => (this.handlers = this.handlers.filter((h) => h !== handler));
  }

  private emit(e: AgentEvent) {
    this.handlers.forEach((h) => h(e));
  }
}
