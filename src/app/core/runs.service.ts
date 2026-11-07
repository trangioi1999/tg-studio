import { planProposal } from './proposal';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AgentBackend } from './backend';
import { AgentsService } from './agents.service';
import { addLine, ConsoleLine, describeLine, MESSAGE_KEY } from './describe-line';
import { estimateCost } from './pricing';
import { AGENT_IDS, AGENT_META, AccountLimits, Approval, Place, AgentEvent, CheckResult, Composite, Pick, PlanEntry, AgentId, FileDiff, PermissionRequest, RunStatus, StoredRun, Usage } from './protocol';

export type { RunStatus };

export interface Run {
  id: string;
  agent: AgentId;
  prompt: string;
  cwd: string;
  startedAt: number;
  /** When the current question was sent: a session's later questions restart the clock. */
  turnAt?: number;
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
  /** The conversation it belongs to. */
  thread: string;
  /** The folder the conversation is about. */
  project: string;
  /** Its subfolder, if the conversation is about one. */
  scope: string | null;
  /** Time spent waiting on approval cards; `to` is null while still waiting. Live runs only. */
  waits: { from: number; to: number | null }[];
  /** The agent's latest plan (ACP `plan` update). Live runs only. */
  plan: PlanEntry[];
  /** Latest tg-bridge `report_progress`. Live runs only. */
  progress: { step: string; pct: number | null; note: string | null; at: number } | null;
  /** Model picked when it started, if not the agent's default. Live runs only. */
  model?: string | null;
  /** Chỉ hỏi / Hỏi trước / Tự động, as last set. Live runs only. */
  perm?: 'read' | 'ask' | 'auto';
  /** Code tasks: the user's folder or a draft. Live runs only. */
  place?: Place;
  /** Chỉ hỏi: the plan the agent wrote instead of editing, until the next question. Live runs only. */
  proposal?: string | null;
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

const CLAUDE_LIMITS_EVERY = 5 * 60_000;

@Injectable({ providedIn: 'root' })
export class RunsService {
  private readonly backend = inject(AgentBackend);
  private readonly agents = inject(AgentsService);
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

  /** When each run was last heard from, to notice one gone quiet. */
  readonly lastEvent = signal<Record<string, number>>({});
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
    void this.refreshLimits();
  }

  async loadLimits(): Promise<void> {
    try {
      this.mergeLimits(await this.backend.accountLimits());
    } catch (e) {
      console.warn('Không đọc được hạn mức đã lưu', e);
    }
  }

  /** A live report may already have arrived; keep whichever is newer. */
  private mergeLimits(saved: AccountLimits[]): void {
    this.limits.update((now) => {
      const next = { ...now };
      for (const l of saved) if (!next[l.agent] || next[l.agent]!.at < l.at) next[l.agent] = l;
      return next;
    });
  }

  private claudeLimitsAt = 0;
  readonly refreshingLimits = signal(false);
  /**
   * Saved limits (Codex's are re-read from its own logs), plus Claude's from its local
   * `/usage`, which spawns the CLI: at most every 5 minutes unless the user asks.
   */
  async refreshLimits(force = false): Promise<void> {
    await this.loadLimits();
    if (!force && Date.now() - this.claudeLimitsAt < CLAUDE_LIMITS_EVERY) return;
    this.claudeLimitsAt = Date.now();
    this.refreshingLimits.set(true);
    try {
      const claude = await this.backend.refreshClaudeLimits();
      if (claude) this.mergeLimits([claude]);
    } catch (e) {
      console.warn('Không đọc được hạn mức Claude', e);
    } finally {
      this.refreshingLimits.set(false);
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

  async start(agent: AgentId, prompt: string, cwd: string, thread: string = crypto.randomUUID(), resumeFrom: string | null = null, scope: string | null = null, recap: string | null = null): Promise<void> {
    // A question that joins a conversation another session started gets its summary first.
    const sent = recap ? `${recap}\n\n${prompt}` : prompt;
    const id = await this.backend.start(agent, sent, cwd, thread, resumeFrom, scope, this.agents.prefsFor(agent));
    const model = this.agents.modelLabel(agent);
    this.upsert(id, agent, (r) => ({ ...r, prompt, cwd, thread, project: cwd, scope, model, perm: 'read' }));
    this.selectedId.set(id);
  }

  /**
   * A code task in its own worktree, or in `reuse`'s worktree for a later pipeline step.
   * `title` is what the UI shows when the prompt sent to the agent is long.
   */
  async startTask(agent: AgentId, prompt: string, repo: string, opts: { reuse?: string; title?: string; singleTurn?: boolean; recap?: string; thread?: string; scope?: string | null; place?: Place; base?: string | null; approval?: Approval } = {}): Promise<string> {
    const thread = opts.thread ?? crypto.randomUUID();
    const approval = opts.approval ?? 'ask';
    const place: Place = approval === 'deny' ? 'draft' : opts.reuse ? (this.runs().find((r) => r.id === opts.reuse)?.place ?? 'draft') : (opts.place ?? 'draft');
    const id = await this.backend.startTask(agent, prompt, repo, null, opts.reuse ?? null, opts.singleTurn ?? false, opts.recap ?? null, thread, opts.scope ?? null, this.agents.prefsFor(agent), opts.place ?? null, opts.base ?? null, approval);
    const model = this.agents.modelLabel(agent);
    const perm = approval === 'deny' ? 'read' : approval;
    this.upsert(id, agent, (r) => ({ ...r, prompt: opts.title ?? prompt, cwd: repo, task: true, thread, project: repo, scope: opts.scope ?? null, model, perm, place }));
    this.selectedId.set(id);
    return id;
  }

  /** Opens a session ahead of the first message; a failure only costs the head start. */
  warm(agent: AgentId, repo: string, scope: string | null): void {
    this.backend.warmTask(agent, repo, scope).catch(() => {});
  }

  /** The next message of the run's open session. */
  sendMessage(runId: string, text: string): Promise<void> {
    return this.backend.sendMessage(runId, text);
  }

  /** Changes how an open session answers permission requests, from its next request on. */
  async setApproval(runId: string, approval: Approval): Promise<void> {
    await this.backend.setApproval(runId, approval);
    const perm = approval === 'deny' ? 'read' : approval;
    this.runs.update((all) => all.map((r) => (r.id === runId ? { ...r, perm } : r)));
  }

  /** Everything `git commit` would include in the run's repository. */
  stagedFiles(runId: string): Promise<string[]> {
    return this.backend.stagedFiles(runId);
  }

  /**
   * One prompt, one worktree per agent. Agents that fail to start are reported
   * without stopping the others; throws only when none started.
   */
  async startParallel(agents: AgentId[], prompt: string, repo: string, scope: string | null = null, opts: { base?: string | null; approval?: Approval } = {}): Promise<string[]> {
    const group = crypto.randomUUID();
    // Several agents cannot share one folder: each works in its own draft.
    const results = await Promise.allSettled(agents.map((a) => this.backend.startTask(a, prompt, repo, group, null, false, null, group, scope, this.agents.prefsFor(a), 'draft', opts.base ?? null, opts.approval ?? 'ask')));
    const errors: string[] = [];
    let first: string | null = null;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        this.upsert(result.value, agents[i], (r) => ({ ...r, prompt, cwd: repo, task: true, group, thread: group, project: repo, scope, model: this.agents.modelLabel(agents[i]), perm: opts.approval === 'auto' ? 'auto' : 'ask', place: 'draft' }));
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
    const reuse = source?.task && (source.status === 'done' || source.status === 'idle') ? source.id : undefined;
    const runId = await this.startTask(h.agent, prompt, repo, { reuse, title: h.task, thread: source?.thread, scope: source?.scope });
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

  /** Runs the user deleted: a late `exit` from their closing session must not bring them back. */
  private readonly deleted = new Set<string>();

  /** Deletes these runs from history and drops them from the screen. */
  async deleteRuns(ids: string[]): Promise<void> {
    if (!ids.length) return;
    for (const id of ids) this.deleted.add(id);
    try {
      await this.backend.deleteRuns(ids);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A failed cleanup still hid the history; anything else changed nothing.
      if (!message.startsWith('Đã xoá cuộc trò chuyện')) {
        for (const id of ids) this.deleted.delete(id);
        throw e;
      }
      this.drop(ids);
      throw e;
    }
    this.drop(ids);
  }

  private drop(ids: string[]): void {
    const gone = new Set(ids);
    this.runs.update((list) => list.filter((r) => !gone.has(r.id)));
    if (gone.has(this.selectedId() ?? '')) this.selectedId.set(null);
  }

  /** The user turned down a Chỉ hỏi plan: stop offering it. */
  dismissProposal(id: string): void {
    this.runs.update((list) => list.map((r) => (r.id === id ? { ...r, proposal: null } : r)));
  }

  async stop(id: string): Promise<void> {
    this.stopping.add(id);
    await this.backend.stop(id);
  }

  private apply(e: AgentEvent): void {
    if (this.deleted.has(e.runId)) return;
    this.lastEvent.update((all) => ({ ...all, [e.runId]: e.atMs }));
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
          const proposal = e.kind === 'log' && run.perm === 'read' ? planProposal(run.agent, e.line) : null;
          const next = proposal ? { ...run, proposal } : run;
          return line ? { ...next, lines: addLine(run.lines, line).slice(-MAX_LINES) } : next;
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
        case 'user':
          return { ...run, status: 'running', turnAt: e.atMs, endedAt: null, exitCode: null, proposal: null, lines: e.line ? [...run.lines, { text: e.line, tone: 'user' as const }].slice(-MAX_LINES) : run.lines };
        case 'turn_end': {
          this.stopping.delete(run.id);
          this.forget(run.id);
          void this.loadLimits();
          const waits = run.waits.map((w) => (w.to === null ? { ...w, to: e.atMs } : w));
          return { ...run, status: 'idle', endedAt: e.atMs, permissions: [], waits };
        }
        case 'exit': {
          const stopped = this.stopping.delete(run.id);
          const reported = e.data !== null && typeof e.data === 'object' && !Array.isArray(e.data)
            ? e.data['status'] : null;
          const status: RunStatus = reported === 'done' || reported === 'failed' || reported === 'stopped'
            ? reported : stopped ? 'stopped' : e.code === 0 ? 'done' : 'failed';
          this.forget(run.id);
          void this.loadLimits();
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
        task: false, permissions: [], lastMessage: '', group: null, thread: id, project: '', scope: null, waits: [], plan: [], progress: null,
      };
      const next = change(base);
      return existing ? list.map((r) => (r.id === id ? next : r)) : [next, ...list];
    });
  }
}

/** Where the shown duration of a run counts from: its current question. */
export function turnStart(r: Run): number {
  return r.turnAt ?? r.startedAt;
}

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
  if (kind === 'user') return { text: line, tone: 'user' };
  return kind === 'log' ? describeLine(agent, line) : { text: line, tone: 'error' };
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

export const QUIET_MS = 30_000;

/** Running, not waiting for the user, and nothing heard for a while. It may still be working. */
export function isQuiet(run: Run, lastEvent: number | undefined, now: number): boolean {
  return run.status === 'running' && !run.permissions.length && now - (lastEvent ?? run.startedAt) >= QUIET_MS;
}

const RECAP_LIMIT = 8000;

/** What a new session is told about a conversation it cannot reopen. Newest text wins the space. */
export function recapOf(run: { prompt: string; lines: ConsoleLine[] }): string {
  const said = run.lines.filter((l) => l.tone === 'user' || l.tone === 'text').map((l) => `${l.tone === 'user' ? 'Người dùng' : 'Agent'}: ${l.text}`);
  const body = [`Người dùng: ${run.prompt}`, ...said].join('\n');
  const kept = body.length > RECAP_LIMIT ? `…${body.slice(-RECAP_LIMIT)}` : body;
  return `Tóm tắt cuộc trò chuyện trước. Thư mục này có thể đã có các thay đổi từ cuộc trò chuyện đó:\n${kept}`;
}

function restoreRun(s: StoredRun): Run {
  const lines = s.lines.reduce<ConsoleLine[]>((all, l) => addLine(all, toConsoleLine(s.agent, l.kind, l.line)), []);
  const lastMessage = lines.filter((l) => l.key === MESSAGE_KEY).at(-1)?.text ?? '';
  // A run still marked running or idle belongs to this app session: the UI was only reloaded.
  const { worktree, ...run } = s;
  return { ...run, thread: s.thread ?? s.group ?? s.id, lines, restored: s.status !== 'running' && s.status !== 'idle', task: worktree !== null, permissions: [], lastMessage, waits: [], plan: [], progress: null };
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
