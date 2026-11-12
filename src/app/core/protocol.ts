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
  /** `unknown`: this CLI has no way to tell, or did not answer. */
  auth: 'ok' | 'none' | 'unknown';
}

/** How a code task answers permission requests. Mirrors `acp_runner::Approval`. */
export type Approval = 'ask' | 'auto' | 'deny';
/** Where a code task works: the user's folder, or a draft (worktree) from a branch. */
export type Place = 'direct' | 'draft';

/** Model and effort picked in the composer; `null` keeps the agent's own default. Mirrors `options::SessionPrefs`. */
export interface SessionPrefs {
  model: string | null;
  effort: string | null;
}

export interface ConfigChoice {
  value: string;
  name: string;
  description: string | null;
}

/** One select of an agent's session settings (ACP `configOptions`). */
export interface ConfigSelect {
  id: string;
  current: string;
  options: ConfigChoice[];
}

/** What an agent lets the user pick, read from the agent itself. Mirrors `options::AgentOptions`. */
export interface AgentOptions {
  model: ConfigSelect | null;
  effort: ConfigSelect | null;
}

/** A skill or command the agent offers in a session. Mirrors `options::AgentCommand`. */
export interface AgentCommand {
  /** As the adapter sends it: "tg-demo-skill", "superpowers:writing-plans", "$tg-codex-skill", "compact". */
  name: string;
  /** Without the source marker. */
  description: string;
  kind: 'skill' | 'command';
  source: 'project' | 'user' | 'plugin' | null;
  plugin: string | null;
  hint: string | null;
  /** What goes into the composer: "/tg-demo-skill ", "$tg-codex-skill ", "/plan ". */
  insert: string;
}

/** One process, as `resources::ProcStat`. */
export interface ProcStat {
  pid: number;
  parent: number | null;
  name: string;
  /** Percent of one core. */
  cpu: number;
  /** Bytes (resident). */
  memory: number;
}

/** Processes counted together, as `resources::UsageGroup`. */
export interface UsageGroup {
  kind: 'app' | 'run' | 'warm' | 'other';
  runId: string | null;
  cpu: number;
  memory: number;
  processes: ProcStat[];
}

/** What the app and its agents use right now, as `resources::ResourceReport`. */
export interface ResourceReport {
  at: number;
  cpu: number;
  memory: number;
  cores: number;
  groups: UsageGroup[];
  /** The WebView is counted in the app group (not on macOS, where it is not a child of the app). */
  webview: boolean;
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
  | 'message' | 'tool' | 'plan' | 'permission' | 'permission_resolved' | 'bridge' | 'user' | 'turn_end' | 'commands';

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
/** `idle`: the agent's session is open and waiting for the next message. */
export type RunStatus = 'running' | 'idle' | 'done' | 'failed' | 'stopped' | 'interrupted';

export interface StoredLine {
  kind: 'started' | 'log' | 'stderr' | 'message' | 'user';
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
  /** null for runs from before conversations existed. */
  thread: string | null;
  /** The repository of a code task, the folder of a read-only run. */
  project: string;
  /** The subfolder the conversation is about, with `/`. null: all of the project. */
  scope: string | null;
  /** The run that delegated this one (tg-bridge `delegate`). */
  parent?: string | null;
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

/** An uncommitted file in the user's folder that the run did not change (`own_changes`). */
export interface OwnChange {
  path: string;
  status: string;
}

/** `own_changes`: whether the run works in the user's folder, and the user's own files there. */
export interface OwnChanges {
  direct: boolean;
  files: OwnChange[];
}

/** A piece of a task one agent handed to another through tg-bridge `delegate` (`delegate.rs`). */
export interface Delegation {
  id: string;
  parent: string;
  child: string | null;
  agent: AgentId;
  task: string;
  status: 'waiting_approval' | 'running' | 'done' | 'failed' | 'stopped' | 'refused' | 'conflict';
  summary: string | null;
  filesChanged: string[];
  conflicts: string[];
  worktree: string | null;
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

/** A folder the core checked and resolved. Keep in sync with project.rs. */
export interface Project {
  /** The Git root, or the folder itself outside a repository. */
  root: string;
  name: string;
  branch: string | null;
  git: 'ready' | 'no_commits' | 'none';
  /** Why `root` differs from the path that was given. */
  adjusted: 'subfolder' | 'file' | null;
  /** Files a new draft will not see, because it starts from the latest commit. */
  uncommitted: number;
  /** Git has a name and email to commit with. */
  gitUser: boolean;
}

/** What preparing Git would do, for the user to confirm. Keep in sync with project.rs. */
export interface GitPlan {
  files: number;
  /** Lines added to `.gitignore`, so secrets and dependencies stay out of the commit. */
  ignore: string[];
}

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
  priority?: string;
}

/** This build (`version::app_version`): the commit tells apart builds of one version. */
export interface AppVersion {
  version: string;
  commit: string;
  /** Epoch ms, 0 if unknown. */
  builtAt: number;
}

/** The newest published version (git tags on GitHub). */
export interface LatestVersion {
  latest: string;
  newer: boolean;
}

/** The project's branch against its remote, for Push and Create PR in the Changes tab. */
export interface SyncStatus {
  /** Null on a detached HEAD. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The remote a push goes to; null when the repo has none. */
  remote: string | null;
  github: boolean;
  /** GitHub CLI installed and signed in. */
  gh: boolean;
  defaultBranch: string | null;
  /** The open PR of this branch, if any. */
  prUrl: string | null;
}

/** A user shell of a conversation, in the core's PTY. */
export interface TerminalInfo {
  id: string;
  /** Program name, e.g. zsh or pwsh.exe. */
  shell: string;
  cwd: string;
  /** False when the conversation's shell was already open. */
  fresh: boolean;
}
