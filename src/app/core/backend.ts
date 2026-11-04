import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AccountLimits, AgentEvent, AgentId, CheckResult, Composite, DetectedAgent, FileDiff, McpServer, Pick, PriceRow, RepoInfo, Skill, SkillInstalled, SkillTarget, StoredRun, UsageRow } from './protocol';

export type Unlisten = () => void;

/** Everything the UI needs from the native core. Two implementations: real (Tauri) and mock (browser). */
export abstract class AgentBackend {
  abstract readonly mode: 'native' | 'mock';
  abstract detectAgents(): Promise<DetectedAgent[]>;
  abstract homeDir(): Promise<string | null>;
  /** Root, name and branch of the Git repository containing `path`; rejects outside a repo. */
  abstract repoInfo(path: string): Promise<RepoInfo>;
  abstract start(agent: AgentId, prompt: string, cwd: string): Promise<string>;
  /** `reuse`: continue in the worktree of this finished run (a later pipeline step). */
  abstract startTask(agent: AgentId, prompt: string, repo: string, group?: string | null, reuse?: string | null): Promise<string>;
  abstract respondPermission(runId: string, requestId: string, optionId: string, always: boolean): Promise<void>;
  abstract getDiff(runId: string): Promise<FileDiff[]>;
  abstract acceptHunk(runId: string, path: string, hunkId: string): Promise<void>;
  /** Applies every pending change of the run at once; returns the number of files. */
  abstract acceptAll(runId: string): Promise<number>;
  abstract rejectHunk(runId: string, path: string, hunkId: string): Promise<void>;
  abstract commitAccepted(runId: string, message: string): Promise<string>;
  abstract discardWorktree(runId: string): Promise<void>;
  /** Builds a composite worktree from hunks picked across runs of one group. */
  abstract composeRuns(picks: Pick[]): Promise<Composite>;
  /** Runs the user's command (e.g. npm test) in the composite. */
  abstract checkComposite(id: string, command: string): Promise<CheckResult>;
  abstract applyComposite(id: string): Promise<number>;
  abstract commitComposite(id: string, message: string): Promise<string>;
  abstract discardComposite(id: string): Promise<void>;
  /** Paths relative to the task's worktree, sorted. */
  abstract listFiles(runId: string): Promise<string[]>;
  abstract readFile(runId: string, path: string): Promise<string>;
  /** Overwrites an existing worktree file; refused while the agent runs. */
  abstract writeFile(runId: string, path: string, content: string): Promise<void>;
  abstract stop(runId: string): Promise<void>;
  /** Run history saved by earlier app sessions, newest first. */
  abstract listRuns(): Promise<StoredRun[]>;
  /** Latest plan limits each CLI reported, kept across restarts. */
  abstract accountLimits(): Promise<AccountLimits[]>;
  /** Runs started since `since` (epoch ms), newest first, with final usage. */
  abstract usageReport(since: number): Promise<UsageRow[]>;
  abstract listPrices(): Promise<PriceRow[]>;
  /** A new price from `price.fromMs` on; earlier runs keep their price. */
  abstract addPrice(price: PriceRow): Promise<void>;
  abstract getSetting(key: 'budgets'): Promise<string | null>;
  abstract setSetting(key: 'budgets', value: string): Promise<void>;
  /** Saves a text export (CSV) to the Downloads folder; returns where it went. */
  abstract saveExport(name: string, content: string): Promise<string>;
  /** Local diagnostics report (no secrets); the user saves and sends it by hand. */
  abstract diagnostics(): Promise<Record<string, unknown>>;
  abstract listMcpServers(): Promise<McpServer[]>;
  /** Validates and stores; returns the server with its id. */
  abstract saveMcpServer(server: McpServer): Promise<McpServer>;
  abstract deleteMcpServer(id: string): Promise<void>;
  abstract listSkills(): Promise<Skill[]>;
  /** Saves a SKILL.md (front matter needs name + description); returns it parsed. */
  abstract saveSkill(content: string): Promise<Skill>;
  abstract deleteSkill(name: string): Promise<void>;
  /** Install status per location; `repo` adds the project location. */
  abstract skillTargets(name: string, repo: string | null): Promise<SkillTarget[]>;
  abstract installSkill(name: string, scope: 'project' | 'user', repo: string | null): Promise<SkillInstalled>;
  abstract onEvent(handler: (event: AgentEvent) => void): Promise<Unlisten>;
}

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export class TauriBackend extends AgentBackend {
  readonly mode = 'native' as const;
  detectAgents() {
    return invoke<DetectedAgent[]>('detect_agents');
  }
  homeDir() {
    return invoke<string | null>('home_dir');
  }
  repoInfo(path: string) {
    return invoke<RepoInfo>('repo_info', { path });
  }
  start(agent: AgentId, prompt: string, cwd: string) {
    return invoke<string>('start_agent', { agent, prompt, cwd });
  }
  startTask(agent: AgentId, prompt: string, repo: string, group: string | null = null, reuse: string | null = null) {
    return invoke<string>('start_task', { agent, prompt, repo, group, reuse });
  }
  respondPermission(runId: string, requestId: string, optionId: string, always: boolean) {
    return invoke<void>('respond_permission', { runId, requestId, optionId, always });
  }
  getDiff(runId: string) {
    return invoke<FileDiff[]>('get_diff', { runId });
  }
  acceptHunk(runId: string, path: string, hunkId: string) {
    return invoke<void>('accept_hunk', { runId, path, hunkId });
  }
  acceptAll(runId: string) {
    return invoke<number>('accept_all', { runId });
  }
  rejectHunk(runId: string, path: string, hunkId: string) {
    return invoke<void>('reject_hunk', { runId, path, hunkId });
  }
  commitAccepted(runId: string, message: string) {
    return invoke<string>('commit_accepted', { runId, message });
  }
  discardWorktree(runId: string) {
    return invoke<void>('discard_worktree', { runId });
  }
  composeRuns(picks: Pick[]) {
    return invoke<Composite>('compose_runs', { picks });
  }
  checkComposite(id: string, command: string) {
    return invoke<CheckResult>('check_composite', { id, command });
  }
  applyComposite(id: string) {
    return invoke<number>('apply_composite', { id });
  }
  commitComposite(id: string, message: string) {
    return invoke<string>('commit_composite', { id, message });
  }
  discardComposite(id: string) {
    return invoke<void>('discard_composite', { id });
  }
  listFiles(runId: string) {
    return invoke<string[]>('list_worktree_files', { runId });
  }
  readFile(runId: string, path: string) {
    return invoke<string>('read_worktree_file', { runId, path });
  }
  writeFile(runId: string, path: string, content: string) {
    return invoke<void>('write_worktree_file', { runId, path, content });
  }
  stop(runId: string) {
    return invoke<void>('stop_agent', { runId });
  }
  listRuns() {
    return invoke<StoredRun[]>('list_runs');
  }
  accountLimits() {
    return invoke<AccountLimits[]>('account_limits');
  }
  usageReport(since: number) {
    return invoke<UsageRow[]>('usage_report', { since: Math.max(0, Math.floor(since)) });
  }
  listPrices() {
    return invoke<PriceRow[]>('list_prices');
  }
  addPrice(price: PriceRow) {
    return invoke<void>('add_price', { price });
  }
  getSetting(key: 'budgets') {
    return invoke<string | null>('get_setting', { key });
  }
  setSetting(key: 'budgets', value: string) {
    return invoke<void>('set_setting', { key, value });
  }
  saveExport(name: string, content: string) {
    return invoke<string>('save_export', { name, content });
  }
  diagnostics() {
    return invoke<Record<string, unknown>>('diagnostics');
  }
  listMcpServers() {
    return invoke<McpServer[]>('list_mcp_servers');
  }
  saveMcpServer(server: McpServer) {
    return invoke<McpServer>('save_mcp_server', { server });
  }
  deleteMcpServer(id: string) {
    return invoke<void>('delete_mcp_server', { id });
  }
  listSkills() {
    return invoke<Skill[]>('list_skills');
  }
  saveSkill(content: string) {
    return invoke<Skill>('save_skill', { content });
  }
  deleteSkill(name: string) {
    return invoke<void>('delete_skill', { name });
  }
  skillTargets(name: string, repo: string | null) {
    return invoke<SkillTarget[]>('skill_targets', { name, repo });
  }
  installSkill(name: string, scope: 'project' | 'user', repo: string | null) {
    return invoke<SkillInstalled>('install_skill', { name, scope, repo });
  }
  onEvent(handler: (event: AgentEvent) => void) {
    return listen<AgentEvent>('agent-event', (e) => handler(e.payload));
  }
}
