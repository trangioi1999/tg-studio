import { Injectable, computed, inject, signal } from '@angular/core';
import { AgentBackend } from './backend';
import { ConsoleLine, describeLine } from './describe-line';
import { estimateCost } from './pricing';
import { AGENT_IDS, AgentEvent, AgentId, RunStatus, StoredRun, Usage } from './protocol';

export type { RunStatus };

export interface Run {
  id: string;
  agent: AgentId;
  prompt: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
  lines: ConsoleLine[];
  usage: Usage | null;
  exitCode: number | null;
  /** Loaded from an earlier app session: shown, but not part of this session's usage. */
  restored: boolean;
}

export interface AgentUsage {
  agent: AgentId;
  runs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** Where the cost comes from: the CLI, our price table, or nowhere yet. */
  costSource: 'reported' | 'estimated' | 'unpriced' | 'none';
}

const MAX_LINES = 2000;

@Injectable({ providedIn: 'root' })
export class RunsService {
  private readonly backend = inject(AgentBackend);
  private stopping = new Set<string>();

  readonly runs = signal<Run[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly selected = computed(() => this.runs().find((r) => r.id === this.selectedId()) ?? null);
  readonly running = computed(() => this.runs().filter((r) => r.status === 'running'));
  readonly sessionRuns = computed(() => this.runs().filter((r) => !r.restored));

  readonly usageByAgent = computed<AgentUsage[]>(() =>
    AGENT_IDS.map((agent) => {
      const runs = this.sessionRuns().filter((r) => r.agent === agent);
      const acc: AgentUsage = { agent, runs: runs.length, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: null, costSource: 'none' };
      for (const r of runs) {
        if (!r.usage) continue;
        acc.inputTokens += r.usage.inputTokens;
        acc.cachedInputTokens += r.usage.cachedInputTokens;
        acc.outputTokens += r.usage.outputTokens;
        const reported = r.usage.costUsd;
        const cost = reported ?? estimateCost(agent, r.usage);
        if (cost !== null) acc.costUsd = (acc.costUsd ?? 0) + cost;
        const source = reported !== null ? 'reported' : cost !== null ? 'estimated' : 'unpriced';
        acc.costSource = acc.costSource === 'none' || acc.costSource === source ? source : 'estimated';
      }
      return acc;
    }),
  );

  readonly totals = computed(() =>
    this.usageByAgent().reduce(
      (t, u) => ({
        tokens: t.tokens + u.inputTokens + u.cachedInputTokens + u.outputTokens,
        costUsd: u.costUsd === null ? t.costUsd : (t.costUsd ?? 0) + u.costUsd,
      }),
      { tokens: 0, costUsd: null as number | null },
    ),
  );

  constructor() {
    void this.backend.onEvent((e) => this.apply(e));
    void this.hydrate();
  }

  /** Loads saved runs. History is a convenience, so a failure must not block the UI. */
  private async hydrate(): Promise<void> {
    let stored: StoredRun[];
    try {
      stored = await this.backend.listRuns();
    } catch (e) {
      console.warn('Không đọc được lịch sử lượt chạy', e);
      return;
    }
    this.runs.update((live) => {
      const liveIds = new Set(live.map((r) => r.id));
      return [...live, ...stored.filter((s) => !liveIds.has(s.id)).map(restoreRun)];
    });
    if (!this.selectedId()) this.selectedId.set(this.runs()[0]?.id ?? null);
  }

  async start(agent: AgentId, prompt: string, cwd: string): Promise<void> {
    const id = await this.backend.start(agent, prompt, cwd);
    this.upsert(id, agent, (r) => ({ ...r, prompt, cwd }));
    this.selectedId.set(id);
  }

  async stop(id: string): Promise<void> {
    this.stopping.add(id);
    await this.backend.stop(id);
  }

  private apply(e: AgentEvent): void {
    this.upsert(e.runId, e.agent, (run) => {
      switch (e.kind) {
        case 'started':
        case 'log':
        case 'stderr': {
          const line = toConsoleLine(run.agent, e.kind, e.line);
          return line ? { ...run, lines: [...run.lines, line].slice(-MAX_LINES) } : run;
        }
        case 'usage':
          return { ...run, usage: mergeUsage(run.usage, e.usage) };
        case 'exit': {
          const stopped = this.stopping.delete(run.id);
          const status: RunStatus = stopped ? 'stopped' : e.code === 0 ? 'done' : 'failed';
          return { ...run, status, exitCode: e.code, endedAt: e.atMs };
        }
      }
    });
    if (!this.selectedId()) this.selectedId.set(e.runId);
  }

  private upsert(id: string, agent: AgentId, change: (r: Run) => Run): void {
    this.runs.update((list) => {
      const existing = list.find((r) => r.id === id);
      const base: Run = existing ?? {
        id, agent, prompt: '', cwd: '', startedAt: Date.now(), endedAt: null,
        status: 'running', lines: [], usage: null, exitCode: null, restored: false,
      };
      const next = change(base);
      return existing ? list.map((r) => (r.id === id ? next : r)) : [next, ...list];
    });
  }
}

function toConsoleLine(agent: AgentId, kind: 'started' | 'log' | 'stderr', line: string | null): ConsoleLine | null {
  if (kind === 'started') return { text: line ?? 'started', tone: 'muted' };
  if (!line) return null;
  return kind === 'log' ? describeLine(agent, line) : { text: line, tone: 'error' };
}

function restoreRun(s: StoredRun): Run {
  const lines = s.lines
    .map((l) => toConsoleLine(s.agent, l.kind, l.line))
    .filter((l): l is ConsoleLine => l !== null);
  return { ...s, lines, restored: true };
}

function mergeUsage(prev: Usage | null, next: Usage | null): Usage | null {
  if (!next) return prev;
  if (!prev || next.cumulative) return next;
  return {
    ...next,
    inputTokens: prev.inputTokens + next.inputTokens,
    cachedInputTokens: prev.cachedInputTokens + next.cachedInputTokens,
    outputTokens: prev.outputTokens + next.outputTokens,
    costUsd: prev.costUsd === null && next.costUsd === null ? null : (prev.costUsd ?? 0) + (next.costUsd ?? 0),
  };
}
