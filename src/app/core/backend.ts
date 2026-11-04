import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AgentEvent, AgentId, DetectedAgent, FileDiff, StoredRun } from './protocol';

export type Unlisten = () => void;

/** Everything the UI needs from the native core. Two implementations: real (Tauri) and mock (browser). */
export abstract class AgentBackend {
  abstract readonly mode: 'native' | 'mock';
  abstract detectAgents(): Promise<DetectedAgent[]>;
  abstract homeDir(): Promise<string | null>;
  abstract start(agent: AgentId, prompt: string, cwd: string): Promise<string>;
  abstract startTask(agent: AgentId, prompt: string, repo: string): Promise<string>;
  abstract respondPermission(runId: string, requestId: string, optionId: string, always: boolean): Promise<void>;
  abstract getDiff(runId: string): Promise<FileDiff[]>;
  abstract acceptHunk(runId: string, path: string, hunkId: string): Promise<void>;
  abstract rejectHunk(runId: string, path: string, hunkId: string): Promise<void>;
  abstract commitAccepted(runId: string, message: string): Promise<string>;
  abstract discardWorktree(runId: string): Promise<void>;
  /** Paths relative to the task's worktree, sorted. */
  abstract listFiles(runId: string): Promise<string[]>;
  abstract readFile(runId: string, path: string): Promise<string>;
  /** Overwrites an existing worktree file; refused while the agent runs. */
  abstract writeFile(runId: string, path: string, content: string): Promise<void>;
  abstract stop(runId: string): Promise<void>;
  /** Run history saved by earlier app sessions, newest first. */
  abstract listRuns(): Promise<StoredRun[]>;
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
  start(agent: AgentId, prompt: string, cwd: string) {
    return invoke<string>('start_agent', { agent, prompt, cwd });
  }
  startTask(agent: AgentId, prompt: string, repo: string) {
    return invoke<string>('start_task', { agent, prompt, repo });
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
  rejectHunk(runId: string, path: string, hunkId: string) {
    return invoke<void>('reject_hunk', { runId, path, hunkId });
  }
  commitAccepted(runId: string, message: string) {
    return invoke<string>('commit_accepted', { runId, message });
  }
  discardWorktree(runId: string) {
    return invoke<void>('discard_worktree', { runId });
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
  onEvent(handler: (event: AgentEvent) => void) {
    return listen<AgentEvent>('agent-event', (e) => handler(e.payload));
  }
}
