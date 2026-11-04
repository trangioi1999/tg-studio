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

/** One plan limit window reported by the CLI (Claude: 5 hours, 7 days). Keep in sync with usage.rs. */
export interface LimitWindow {
  id: string;
  /** Share used, 0..1; above 1 once over the limit. */
  utilization: number;
  /** Epoch ms. */
  resetsAt: number | null;
  status: string | null;
}

/** Latest plan limits per agent, from `account_limits` or a `limits` event. Keep in sync with store.rs. */
export interface AccountLimits {
  agent: AgentId;
  windows: LimitWindow[];
  at: number;
}

export type AgentEventKind = 'started' | 'log' | 'stderr' | 'usage' | 'exit' | 'limits'
  | 'message' | 'tool' | 'plan' | 'permission' | 'permission_resolved' | 'bridge';

/** A tg-bridge note shared by the runs of one task. Keep in sync with ledger.rs `BridgeNote`. */
export interface BridgeNote {
  topic: string;
  agent: AgentId;
  at: number;
  text: string;
}

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
  /**
   * The same hue at a lightness validated for charts on the dark surface
   * (dataviz validate_palette.js: band, chroma, CVD ΔE ≥ 8, contrast). Charts only.
   */
  chart: string;
  install: string;
}

export interface NameValue {
  name: string;
  value: string;
}

/** A registry MCP server, handed to every session of the agents it is enabled for. Keep in sync with mcp.rs. */
export interface McpServer {
  /** Empty for a new server; the core assigns one. */
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  env: NameValue[];
  url: string | null;
  headers: NameValue[];
  agents: AgentId[];
}

/** A SKILL.md in the app's library. Keep in sync with skills.rs. */
export interface Skill {
  name: string;
  description: string;
  content: string;
}

export interface SkillTarget {
  scope: 'project' | 'user';
  path: string;
  state: 'missing' | 'same' | 'different';
}

export interface SkillInstalled {
  path: string;
  /** Where the replaced, different file was copied, if there was one. */
  backup: string | null;
}

/** One run in the usage ledger. Keep in sync with store.rs `UsageRow`. */
export interface UsageRow {
  id: string;
  agent: AgentId;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
  group: string | null;
  usage: Usage | null;
}

/** USD per 1M tokens from `fromMs` on; all null means "no price" from then on. */
export interface PriceRow {
  agent: AgentId;
  fromMs: number;
  input: number | null;
  cachedInput: number | null;
  output: number | null;
}

export const AGENT_META: Record<AgentId, AgentMeta> = {
  claude: { name: 'Claude Code', mono: 'CL', color: '#E07B53', chart: '#C9663E', install: 'npm i -g @anthropic-ai/claude-code' },
  codex: { name: 'Codex', mono: 'CX', color: '#3FB68B', chart: '#2FAA7F', install: 'npm i -g @openai/codex' },
  gemini: { name: 'Gemini CLI', mono: 'GM', color: '#6E9BF5', chart: '#3C64B9', install: 'npm i -g @google/gemini-cli' },
  kiro: { name: 'Kiro CLI', mono: 'KR', color: '#A78BFA', chart: '#987CE9', install: 'Xem hướng dẫn cài tại kiro.dev' },
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

/** One hunk picked from a run for a composite. */
export interface Pick {
  runId: string;
  path: string;
  hunkId: string;
}

/** Hunks from several runs applied on their shared base, ready to test. Keep in sync with compose.rs. */
export interface Composite {
  id: string;
  files: FileDiff[];
}

export interface CheckResult {
  /** null: stopped by timeout or a signal. */
  code: number | null;
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface RepoInfo {
  root: string;
  name: string;
  /** null on a detached HEAD. */
  branch: string | null;
}

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
  priority?: string;
}

export interface Worktree {
  runId: string;
  path: string;
  branch: string;
  base: string;
}
