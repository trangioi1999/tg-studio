import { AgentBackend, Unlisten } from './backend';
import { AgentEvent, AgentId, DetectedAgent, StoredRun, Usage } from './protocol';

/**
 * Used when the UI runs in a normal browser (`npm start`), so you can build
 * screens without launching the desktop app. Emits a fake but realistic run.
 */
export class MockBackend extends AgentBackend {
  readonly mode = 'mock' as const;
  private handlers: ((e: AgentEvent) => void)[] = [];

  async detectAgents(): Promise<DetectedAgent[]> {
    return [
      { id: 'claude', name: 'Claude Code', binary: 'claude', path: '/usr/local/bin/claude', version: 'mock', headless: true },
      { id: 'codex', name: 'Codex', binary: 'codex', path: '/opt/homebrew/bin/codex', version: 'mock', headless: true },
      { id: 'gemini', name: 'Gemini CLI', binary: 'gemini', path: '~/.nvm/.../gemini', version: 'mock', headless: true },
      { id: 'kiro', name: 'Kiro CLI', binary: 'kiro-cli', path: null, version: null, headless: false },
    ];
  }

  async homeDir() {
    return '/Users/you/projects/demo';
  }

  async start(agent: AgentId, prompt: string): Promise<string> {
    const runId = crypto.randomUUID();
    const emit = (partial: Partial<AgentEvent>, delay: number) =>
      setTimeout(() => this.emit({ runId, agent, kind: 'log', line: null, usage: null, code: null, atMs: Date.now(), ...partial }), delay);
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

  async stop(runId: string) {
    this.emit({ runId, agent: 'claude', kind: 'exit', line: null, usage: null, code: null, atMs: Date.now() });
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
