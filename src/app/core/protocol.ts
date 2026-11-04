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

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type AgentEventKind = 'started' | 'log' | 'stderr' | 'usage' | 'exit'
  | 'message' | 'tool' | 'plan' | 'permission' | 'permission_resolved';

export interface AgentEvent {
  runId: string;
  agent: AgentId;
  kind: AgentEventKind;
  line: string | null;
  usage: Usage | null;
  code: number | null;
  atMs: number;
  data: JsonValue;
}

/** Stored state of a run, returned by the core's `list_runs`. Keep in sync with store.rs. */
export type RunStatus = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted';

export interface StoredLine {
  kind: 'started' | 'log' | 'stderr' | 'message';
  line: string;
}

export interface StoredRun {
  id: string;
  agent: AgentId;
  prompt: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
  exitCode: number | null;
  usage: Usage | null;
  lines: StoredLine[];
  /** Set for code tasks that still have a worktree to review. */
  worktree: string | null;
  /** Runs started together on one prompt (parallel mode) share this id. */
  group: string | null;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface PermissionRequest {
  requestId: string;
  toolCall: { title?: string; kind?: string; rawInput?: { command?: string | string[] } };
  options: PermissionOption[];
  /** What "Always allow" would save. null: this tool cannot be always allowed. */
  rule: string | null;
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

/** Serialized diff.rs / worktree.rs types. */
export interface Hunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  added: number;
  removed: number;
}

export interface FileDiff {
  path: string;
  status: string;
  binary: boolean;
  patchHeader: string;
  hunks: Hunk[];
}

export interface Worktree {
  runId: string;
  path: string;
  branch: string;
  base: string;
}
