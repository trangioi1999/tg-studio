import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AgentBackend } from './backend';
import { ConsoleLine, describeLine } from './describe-line';
import { estimateCost } from './pricing';
import { AGENT_IDS, AGENT_META, AccountLimits, AgentEvent, CheckResult, Composite, Pick, PlanEntry, AgentId, FileDiff, PermissionRequest, RunStatus, StoredRun, Usage } from './protocol';

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
  /** Shared by runs started together in parallel mode. */
  group: string | null;
  /** Time spent waiting on approval cards; `to` is null while still waiting. Live runs only. */
  waits: { from: number; to: number | null }[];
  /** The agent's latest plan (ACP `plan` update). Live runs only. */
  plan: PlanEntry[];
  /** Latest tg-bridge `report_progress`. Live runs only. */
  progress: { step: string; pct: number | null; note: string | null; at: number } | null;
}

/** A tg-bridge `handoff_to` proposal waiting for the user. */
export interface Handoff {
  id: string;
  /** The run that proposed it. */
  runId: string;
  from: AgentId;
  agent: AgentId;
  task: string;
  files: string[];
  at: number;
}

/** Where an agent is working right now, from its latest tool call that names a file. */
export interface AgentActivity {
  toolCallId: string;
  /** As the agent sent it: usually absolute, inside the run's worktree. */
  path: string;
  line: number | null;
  /** The tool writes the file (edit kind or a diff in its content). */
  editing: boolean;
  /** The tool call finished (completed or failed). */
  done: boolean;
  at: number;
}

/** The run picked with "Use this" for a parallel group, kept while the user moves around. */
export interface GroupChoice {
  /** The run used whole, or null when a composite was used. */
  runId: string | null;
  compositeId: string | null;
  files: number;
  /** Short hash once committed. */
  commit: string | null;
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
  readonly choices = signal<Record<string, GroupChoice>>({});
  /** The composite being built for a group, if any. */
  readonly composites = signal<Record<string, Composite>>({});
  /** Last check command typed, offered again for the next composite. */
  readonly checkCommand = signal('');
  /** Latest plan limits per agent (Claude's 5-hour and weekly windows). */
  readonly limits = signal<Partial<Record<AgentId, AccountLimits>>>({});
  /** Handoffs agents proposed through tg-bridge, until accepted or dismissed. */
  readonly handoffs = signal<Handoff[]>([]);
  /** Per run: the file the agent touched last. Cleared when the run ends. */
  readonly activity = signal<Record<string, AgentActivity>>({});
  private readonly tools = new Map<string, { path: string | null; line: number | null; editing: boolean }>();

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
        const cost = reported ?? estimateCost(agent, r.usage, r.startedAt);
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

  /** Time for live durations; only ticks while a run is running. */
  readonly now = signal(Date.now());
  private readonly anyRunning = computed(() => this.running().length > 0);

  constructor() {
    effect((onCleanup) => {
      if (!this.anyRunning()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    void this.backend.onEvent((e) => this.apply(e));
    void this.hydrate();
    void this.loadLimits();
  }

  private async loadLimits(): Promise<void> {
    try {
      const saved = await this.backend.accountLimits();
      // A live report may already have arrived; keep whichever is newer.
      this.limits.update((now) => {
        const next = { ...now };
        for (const l of saved) if (!next[l.agent] || next[l.agent]!.at < l.at) next[l.agent] = l;
        return next;
      });
    } catch (e) {
      console.warn('Không đọc được hạn mức đã lưu', e);
    }
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

  /**
   * A code task in its own worktree, or in `reuse`'s worktree for a later pipeline step.
   * `title` is what the UI shows when the prompt sent to the agent is long.
   */
  async startTask(agent: AgentId, prompt: string, repo: string, opts: { reuse?: string; title?: string } = {}): Promise<string> {
    const id = await this.backend.startTask(agent, prompt, repo, null, opts.reuse ?? null);
    this.upsert(id, agent, (r) => ({ ...r, prompt: opts.title ?? prompt, cwd: repo, task: true }));
    this.selectedId.set(id);
    return id;
  }

  /** Everything `git commit` would include in the run's repository. */
  stagedFiles(runId: string): Promise<string[]> {
    return this.backend.stagedFiles(runId);
  }

  /**
   * One prompt, one worktree per agent. Agents that fail to start are reported
   * without stopping the others; throws only when none started.
   */
  async startParallel(agents: AgentId[], prompt: string, repo: string): Promise<string[]> {
    const group = crypto.randomUUID();
    const results = await Promise.allSettled(agents.map((a) => this.backend.startTask(a, prompt, repo, group)));
    const errors: string[] = [];
    let first: string | null = null;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        this.upsert(result.value, agents[i], (r) => ({ ...r, prompt, cwd: repo, task: true, group }));
        first ??= result.value;
      } else {
        errors.push(`${AGENT_META[agents[i]].name}: ${errorText(result.reason)}`);
      }
    });
    if (!first) throw new Error(errors.join('\n'));
    this.selectedId.set(first);
    return errors;
  }

  /** Runs of the same parallel group, in agent order; empty for a solo run. */
  groupRuns(group: string | null): Run[] {
    if (!group) return [];
    return this.runs().filter((r) => r.group === group).sort((a, b) => AGENT_IDS.indexOf(a.agent) - AGENT_IDS.indexOf(b.agent));
  }

  /** "Use this": applies the whole run and remembers it as the group's choice. */
  async useRun(group: string, runId: string): Promise<void> {
    if (this.choices()[group]) throw new Error('Nhóm này đã chọn một bản.');
    const files = await this.backend.acceptAll(runId);
    this.choices.update((c) => ({ ...c, [group]: { runId, compositeId: null, files, commit: null } }));
  }

  /** Replaces the group's composite with one built from these picks. */
  async compose(group: string, picks: Pick[]): Promise<Composite> {
    await this.dropComposite(group);
    const composite = await this.backend.composeRuns(picks);
    this.composites.update((c) => ({ ...c, [group]: composite }));
    return composite;
  }

  checkComposite(group: string, command: string): Promise<CheckResult> {
    const composite = this.composites()[group];
    if (!composite) return Promise.reject(new Error('Chưa có bản ghép.'));
    this.checkCommand.set(command);
    return this.backend.checkComposite(composite.id, command);
  }

  /** "Use the mix": applies the composite whole, as the group's choice. */
  async useComposite(group: string): Promise<void> {
    const composite = this.composites()[group];
    if (!composite) throw new Error('Chưa có bản ghép.');
    if (this.choices()[group]) throw new Error('Nhóm này đã chọn một bản.');
    const files = await this.backend.applyComposite(composite.id);
    this.choices.update((c) => ({ ...c, [group]: { runId: null, compositeId: composite.id, files, commit: null } }));
  }

  async dropComposite(group: string): Promise<void> {
    const composite = this.composites()[group];
    if (!composite) return;
    await this.backend.discardComposite(composite.id);
    this.composites.update(({ [group]: _, ...rest }) => rest);
  }

  async commitChoice(group: string, message: string): Promise<string> {
    const choice = this.choices()[group];
    if (!choice) throw new Error('Chưa chọn bản nào trong nhóm.');
    const hash = choice.compositeId
      ? await this.backend.commitComposite(choice.compositeId, message)
      : await this.backend.commitAccepted(choice.runId!, message);
    this.choices.update((c) => ({ ...c, [group]: { ...choice, commit: hash.slice(0, 7) } }));
    return hash;
  }

  /**
   * Accept a tg-bridge handoff: the agent continues in the proposer's worktree when
   * that run has finished, otherwise it gets a new task in `repo`.
   */
  async acceptHandoff(id: string, repo: string): Promise<string> {
    const h = this.handoffs().find((x) => x.id === id);
    if (!h) throw new Error('Đề xuất này không còn.');
    const source = this.runs().find((r) => r.id === h.runId);
    const files = h.files.length ? `\n\nTệp liên quan: ${h.files.join(', ')}` : '';
    const prompt = `${h.task}${files}\n\n(Chuyển từ ${AGENT_META[h.from].name} qua tg-bridge.)`;
    const reuse = source?.task && source.status === 'done' ? source.id : undefined;
    const runId = await this.startTask(h.agent, prompt, repo, { reuse, title: h.task });
    this.dismissHandoff(id);
    return runId;
  }

  dismissHandoff(id: string): void {
    this.handoffs.update((h) => h.filter((x) => x.id !== id));
  }

  bridgeNotes(runId: string) {
    return this.backend.bridgeNotes(runId);
  }

  acceptAll(runId: string): Promise<number> {
    return this.backend.acceptAll(runId);
  }

  respondPermission(runId: string, requestId: string, optionId: string, always: boolean): Promise<void> {
    return this.backend.respondPermission(runId, requestId, optionId, always);
  }

  getDiff(runId: string): Promise<FileDiff[]> {
    return this.backend.getDiff(runId);
  }

  listFiles(runId: string): Promise<string[]> {
    return this.backend.listFiles(runId);
  }

  readFile(runId: string, path: string): Promise<string> {
    return this.backend.readFile(runId, path);
  }

  writeFile(runId: string, path: string, content: string): Promise<void> {
    return this.backend.writeFile(runId, path, content);
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
    if (e.kind === 'limits') {
      const windows = dataOf(e)['windows'];
      if (Array.isArray(windows)) {
        this.limits.update((l) => ({ ...l, [e.agent]: { agent: e.agent, windows: windows as unknown as AccountLimits['windows'], at: e.atMs } }));
      }
      return;
    }
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
          this.track(run.id, dataOf(e), e.atMs);
          return { ...run, task: true, lines: applyTool(run.lines, dataOf(e)).slice(-MAX_LINES) };
        case 'plan': {
          const entries = dataOf(e)['entries'];
          const plan = Array.isArray(entries) ? (entries as PlanEntry[]).filter((p) => typeof p?.content === 'string') : run.plan;
          return { ...run, plan, lines: applyPlan(run.lines, dataOf(e)).slice(-MAX_LINES) };
        }
        case 'permission': {
          const request = e.data as unknown as PermissionRequest;
          return { ...run, task: true, permissions: [...run.permissions, request], waits: [...run.waits, { from: e.atMs, to: null }] };
        }
        case 'permission_resolved': {
          const id = dataOf(e)['requestId'];
          const open = run.waits.findIndex((w) => w.to === null);
          const waits = open < 0 ? run.waits : run.waits.map((w, i) => (i === open ? { ...w, to: e.atMs } : w));
          return { ...run, permissions: run.permissions.filter((p) => p.requestId !== id), waits };
        }
        case 'started':
        case 'log':
        case 'stderr': {
          const line = toConsoleLine(run.agent, e.kind, e.line);
          return line ? { ...run, lines: [...run.lines, line].slice(-MAX_LINES) } : run;
        }
        case 'usage':
          return { ...run, usage: mergeUsage(run.usage, e.usage) };
        case 'limits':
          return run; // handled above: limits belong to the account, not the run
        case 'bridge': {
          const d = dataOf(e);
          const lines = e.line ? addLine(run.lines, { text: e.line, tone: 'tool' }).slice(-MAX_LINES) : run.lines;
          if (d['tool'] === 'report_progress' && typeof d['step'] === 'string') {
            const pct = typeof d['pct'] === 'number' ? d['pct'] : null;
            return { ...run, lines, progress: { step: d['step'], pct, note: typeof d['note'] === 'string' ? d['note'] : null, at: e.atMs } };
          }
          if (d['tool'] === 'handoff_to' && typeof d['id'] === 'string' && typeof d['task'] === 'string' && AGENT_IDS.includes(d['agent'] as AgentId)) {
            const handoff: Handoff = { id: d['id'], runId: run.id, from: run.agent, agent: d['agent'] as AgentId, task: d['task'],
              files: Array.isArray(d['files']) ? d['files'].filter((f): f is string => typeof f === 'string') : [], at: e.atMs };
            this.handoffs.update((h) => (h.some((x) => x.id === handoff.id) ? h : [...h, handoff]));
          }
          return { ...run, lines };
        }
        case 'exit': {
          const stopped = this.stopping.delete(run.id);
          const reported = e.data !== null && typeof e.data === 'object' && !Array.isArray(e.data)
            ? e.data['status'] : null;
          const status: RunStatus = reported === 'done' || reported === 'failed' || reported === 'stopped'
            ? reported : stopped ? 'stopped' : e.code === 0 ? 'done' : 'failed';
          this.forget(run.id);
          const waits = run.waits.map((w) => (w.to === null ? { ...w, to: e.atMs } : w));
          return { ...run, status, exitCode: e.code, endedAt: e.atMs, permissions: [], waits };
        }
      }
    });
    if (!this.selectedId()) this.selectedId.set(e.runId);
  }

  /** Tool updates repeat only what changed, so remember each call's file and kind by id. */
  private track(runId: string, update: Json, at: number): void {
    const id = update['toolCallId'];
    if (typeof id !== 'string') return;
    const key = `${runId}:${id}`;
    const prev = this.tools.get(key) ?? { path: null, line: null, editing: false };
    const location = Array.isArray(update['locations']) ? (update['locations'][0] as Json | undefined) : undefined;
    const content = Array.isArray(update['content']) ? (update['content'] as Json[]) : [];
    const diff = content.find((c) => c['type'] === 'diff');
    const raw = (update['rawInput'] ?? {}) as Json;
    const path = [location?.['path'], diff?.['path'], raw['file_path'], raw['path']].find((p): p is string => typeof p === 'string') ?? prev.path;
    const line = typeof location?.['line'] === 'number' ? location['line'] : prev.line;
    const editing = prev.editing || update['kind'] === 'edit' || !!diff;
    this.tools.set(key, { path, line, editing });
    if (!path) return;
    const done = update['status'] === 'completed' || update['status'] === 'failed';
    this.activity.update((a) => ({ ...a, [runId]: { toolCallId: id, path, line, editing, done, at } }));
  }

  private forget(runId: string): void {
    for (const key of [...this.tools.keys()]) if (key.startsWith(`${runId}:`)) this.tools.delete(key);
    if (this.activity()[runId]) {
      this.activity.update((a) => {
        const { [runId]: _, ...rest } = a;
        return rest;
      });
    }
  }

  private upsert(id: string, agent: AgentId, change: (r: Run) => Run): void {
    this.runs.update((list) => {
      const existing = list.find((r) => r.id === id);
      const base: Run = existing ?? {
        id, agent, prompt: '', cwd: '', startedAt: Date.now(), endedAt: null,
        status: 'running', lines: [], usage: null, exitCode: null, restored: false,
        task: false, permissions: [], lastMessage: '', group: null, waits: [], plan: [], progress: null,
      };
      const next = change(base);
      return existing ? list.map((r) => (r.id === id ? next : r)) : [next, ...list];
    });
  }
}

const MESSAGE_KEY = 'message';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
  return { ...run, lines, restored: s.status !== 'running', task: worktree !== null, permissions: [], lastMessage, waits: [], plan: [], progress: null };
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
    group: saved.group ?? live.group,
    waits: live.waits,
    plan: live.plan,
    progress: live.progress,
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
