import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AgentEvent, AgentId, DetectedAgent, StoredRun } from './protocol';

export type Unlisten = () => void;

/** Everything the UI needs from the native core. Two implementations: real (Tauri) and mock (browser). */
export abstract class AgentBackend {
  abstract readonly mode: 'native' | 'mock';
  abstract detectAgents(): Promise<DetectedAgent[]>;
  abstract homeDir(): Promise<string | null>;
  abstract start(agent: AgentId, prompt: string, cwd: string): Promise<string>;
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
