import { Injectable, computed, inject, signal } from '@angular/core';
import { AgentBackend } from './backend';
import { ConsoleLine, describeLine } from './describe-line';
import { estimateCost } from './pricing';
import { AGENT_IDS, AgentEvent, AgentId, FileDiff, PermissionRequest, RunStatus, StoredRun, Usage } from './protocol';

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
  /** A code task: it has a worktree with changes to review. */
  task: boolean;
  permissions: PermissionRequest[];
  /** Full text of the agent's latest message, used to suggest a commit message. */
  lastMessage: string;
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
      const liveById = new Map(live.map((r) => [r.id, r]));
      const storedIds = new Set(stored.map((s) => s.id));
      const merged = stored.map((s) => {
        const run = liveById.get(s.id);
        return run ? reattach(restoreRun(s), run) : restoreRun(s);
      });
      return [...live.filter((r) => !storedIds.has(r.id)), ...merged];
    });
    if (!this.selectedId()) this.selectedId.set(this.runs()[0]?.id ?? null);
  }

  async start(agent: AgentId, prompt: string, cwd: string): Promise<void> {
    const id = await this.backend.start(agent, prompt, cwd);
    this.upsert(id, agent, (r) => ({ ...r, prompt, cwd }));
    this.selectedId.set(id);
  }

  async startTask(agent: AgentId, prompt: string, repo: string): Promise<void> {
    const id = await this.backend.startTask(agent, prompt, repo);
    this.upsert(id, agent, (r) => ({ ...r, prompt, cwd: repo, task: true }));
    this.selectedId.set(id);
  }

  respondPermission(runId: string, requestId: string, optionId: string, always: boolean): Promise<void> {
    return this.backend.respondPermission(runId, requestId, optionId, always);
  }

  getDiff(runId: string): Promise<FileDiff[]> {
    return this.backend.getDiff(runId);
  }

  acceptHunk(runId: string, path: string, hunkId: string): Promise<void> {
    return this.backend.acceptHunk(runId, path, hunkId);
  }

  rejectHunk(runId: string, path: string, hunkId: string): Promise<void> {
    return this.backend.rejectHunk(runId, path, hunkId);
  }

  commitAccepted(runId: string, message: string): Promise<string> {
    return this.backend.commitAccepted(runId, message);
  }

  async discardWorktree(runId: string): Promise<void> {
    await this.backend.discardWorktree(runId);
    this.runs.update((list) => list.map((r) => (r.id === runId ? { ...r, task: false } : r)));
  }

  async stop(id: string): Promise<void> {
    this.stopping.add(id);
    await this.backend.stop(id);
  }

  private apply(e: AgentEvent): void {
    this.upsert(e.runId, e.agent, (run) => {
      switch (e.kind) {
        case 'message': {
          const text = dataOf(e)['text'];
          if (typeof text !== 'string') return run;
          const continues = run.lines.at(-1)?.key === MESSAGE_KEY;
          return {
            ...run,
            task: true,
            lastMessage: continues ? run.lastMessage + text : text,
            lines: addLine(run.lines, toConsoleLine(run.agent, 'message', text)).slice(-MAX_LINES),
          };
        }
        case 'tool':
          return { ...run, task: true, lines: applyTool(run.lines, dataOf(e)).slice(-MAX_LINES) };
        case 'plan':
          return { ...run, lines: applyPlan(run.lines, dataOf(e)).slice(-MAX_LINES) };
        case 'permission': {
          const request = e.data as unknown as PermissionRequest;
          return { ...run, task: true, permissions: [...run.permissions, request] };
        }
        case 'permission_resolved': {
          const id = dataOf(e)['requestId'];
          return { ...run, permissions: run.permissions.filter((p) => p.requestId !== id) };
        }
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
          const reported = e.data !== null && typeof e.data === 'object' && !Array.isArray(e.data)
            ? e.data['status'] : null;
          const status: RunStatus = reported === 'done' || reported === 'failed' || reported === 'stopped'
            ? reported : stopped ? 'stopped' : e.code === 0 ? 'done' : 'failed';
          return { ...run, status, exitCode: e.code, endedAt: e.atMs, permissions: [] };
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
        task: false, permissions: [], lastMessage: '',
      };
      const next = change(base);
      return existing ? list.map((r) => (r.id === id ? next : r)) : [next, ...list];
    });
  }
}

const MESSAGE_KEY = 'message';

type Json = Record<string, unknown>;

function dataOf(e: AgentEvent): Json {
  return e.data !== null && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Json) : {};
}

function toConsoleLine(agent: AgentId, kind: StoredRun['lines'][number]['kind'], line: string | null): ConsoleLine | null {
  if (kind === 'started') return { text: line ?? 'started', tone: 'muted' };
  if (!line) return null;
  if (kind === 'message') return { text: line, tone: 'text', key: MESSAGE_KEY };
  return kind === 'log' ? describeLine(agent, line) : { text: line, tone: 'error' };
}

/** Streamed message chunks join the message line they continue. */
function addLine(lines: ConsoleLine[], line: ConsoleLine | null): ConsoleLine[] {
  if (!line) return lines;
  const last = lines.at(-1);
  if (line.key === MESSAGE_KEY && last?.key === MESSAGE_KEY) {
    return [...lines.slice(0, -1), { ...last, text: last.text + line.text }];
  }
  return [...lines, line];
}

/** A tool call has one console line, updated in place as its status changes. */
function applyTool(lines: ConsoleLine[], update: Json): ConsoleLine[] {
  const id = update['toolCallId'];
  if (typeof id !== 'string') return lines;
  const key = `tool:${id}`;
  const index = lines.findIndex((l) => l.key === key);
  const title = typeof update['title'] === 'string' ? update['title'] : null;
  const label = title ?? lines[index]?.label ?? 'tool';
  const status = update['status'];
  const failed = status === 'failed';
  const suffix = status === 'completed' ? ' ✓' : failed ? ' ✕' : '';
  const line: ConsoleLine = { key, label, text: `› ${label}${suffix}`, tone: failed ? 'error' : 'tool' };
  if (index < 0) return [...lines, line];
  return lines.map((l, i) => (i === index ? line : l));
}

const PLAN_MARK: Record<string, string> = { completed: '[x]', in_progress: '[~]' };

/** The plan has one block in the console, replaced each time the agent revises it. */
function applyPlan(lines: ConsoleLine[], update: Json): ConsoleLine[] {
  const entries = Array.isArray(update['entries']) ? (update['entries'] as Json[]) : [];
  const text = entries.map((e) => `${PLAN_MARK[String(e['status'])] ?? '[ ]'} ${String(e['content'] ?? '')}`).join('\n');
  const line: ConsoleLine = { key: 'plan', text, tone: 'muted' };
  return lines.some((l) => l.key === 'plan') ? lines.map((l) => (l.key === 'plan' ? line : l)) : [...lines, line];
}

function restoreRun(s: StoredRun): Run {
  const lines = s.lines.reduce<ConsoleLine[]>((all, l) => addLine(all, toConsoleLine(s.agent, l.kind, l.line)), []);
  const lastMessage = lines.filter((l) => l.key === MESSAGE_KEY).at(-1)?.text ?? '';
  // A run still marked running belongs to this app session: the UI was only reloaded.
  const { worktree, ...run } = s;
  return { ...run, lines, restored: s.status !== 'running', task: worktree !== null, permissions: [], lastMessage };
}

/**
 * Joins a saved run with events that reached the UI before history loaded. A line is
 * saved before it is emitted, so the end of the snapshot may repeat the first live lines.
 */
function reattach(saved: Run, live: Run): Run {
  const ended = saved.status === 'done' || saved.status === 'failed' || saved.status === 'stopped';
  const final = live.status !== 'running' ? live : ended ? saved : live;
  return {
    ...saved,
    status: final.status,
    exitCode: final.exitCode,
    endedAt: final.endedAt,
    usage: live.usage?.cumulative ? live.usage : (saved.usage ?? live.usage),
    lines: joinLines(saved.lines, live.lines).slice(-MAX_LINES),
    restored: false,
    task: saved.task || live.task,
    permissions: live.permissions,
    lastMessage: live.lastMessage || saved.lastMessage,
  };
}

function joinLines(saved: ConsoleLine[], live: ConsoleLine[]): ConsoleLine[] {
  for (let overlap = Math.min(saved.length, live.length); overlap > 0; overlap--) {
    const tail = saved.slice(-overlap);
    if (tail.every((l, i) => l.text === live[i].text && l.tone === live[i].tone)) {
      return [...saved, ...live.slice(overlap)];
    }
  }
  return [...saved, ...live];
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
