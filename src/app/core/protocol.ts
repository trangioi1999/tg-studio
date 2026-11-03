/** Types shared with the Rust core (src-tauri). Keep in sync with runner.rs / usage.rs / detect.rs. */

export type AgentId = 'claude' | 'codex' | 'gemini' | 'kiro';

export interface DetectedAgent {
  id: AgentId;
  name: string;
  binary: string;
  path: string | null;
  version: string | null;
  /** True when the agent can run in headless mode today (phase 0). */
  headless: boolean;
}

export interface Usage {
  /** Uncached input tokens. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** USD reported by the CLI (Claude Code). null → estimate from pricing.ts. */
  costUsd: number | null;
  source: 'reported' | 'tokens';
  /** true: replaces earlier numbers of the run. false: adds to them. */
  cumulative: boolean;
}

export type AgentEventKind = 'started' | 'log' | 'stderr' | 'usage' | 'exit';

export interface AgentEvent {
  runId: string;
  agent: AgentId;
  kind: AgentEventKind;
  line: string | null;
  usage: Usage | null;
  code: number | null;
  atMs: number;
}

export interface AgentMeta {
  name: string;
  mono: string;
  color: string;
  install: string;
}

export const AGENT_META: Record<AgentId, AgentMeta> = {
  claude: { name: 'Claude Code', mono: 'CL', color: '#E07B53', install: 'npm i -g @anthropic-ai/claude-code' },
  codex: { name: 'Codex', mono: 'CX', color: '#3FB68B', install: 'npm i -g @openai/codex' },
  gemini: { name: 'Gemini CLI', mono: 'GM', color: '#6E9BF5', install: 'npm i -g @google/gemini-cli' },
  kiro: { name: 'Kiro CLI', mono: 'KR', color: '#A78BFA', install: 'Xem hướng dẫn cài tại kiro.dev' },
};

export const AGENT_IDS: AgentId[] = ['claude', 'codex', 'gemini', 'kiro'];
