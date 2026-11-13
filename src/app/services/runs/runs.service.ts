import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AgentBackend } from '../../core/backend';
import { AgentsService } from '../agents/agents.service';
import { estimateCost } from '../usage/pricing';
import { AccountLimits, Approval, Place, AgentEvent, CheckResult, Composite, Pick, AgentId, FileDiff, OwnChanges, StoredRun } from '../../core/protocol';
import { AGENT_IDS, AGENT_META } from '../agents/agent-meta';
import { errorText } from '../../shared/utils/errors';
import { AgentActivity, AgentUsage, GroupChoice, Handoff, Run } from './run';
import { RunEffect, applyEvent, dataOf, reattach, restoreRun } from './run-events';

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
  /** Why the last read of an agent's plan limits gave nothing, for the status bar's tooltip. */
  readonly limitErrors = signal<Partial<Record<AgentId, string>>>({});
  /**
   * Saved limits (Codex's are re-read from its own logs), plus Claude's and Kiro's from
   * their local `/usage`, which spawns each CLI: at most every 5 minutes unless the user asks.
   */
  async refreshLimits(force = false): Promise<void> {
    await this.loadLimits();
    if (!force && Date.now() - this.claudeLimitsAt < CLAUDE_LIMITS_EVERY) return;
    this.claudeLimitsAt = Date.now();
    this.refreshingLimits.set(true);
    try {
      // Each starts a local CLI command; neither spends tokens or credits. Kiro can take a
      // while (it waits for its MCP servers), so each shows its numbers as soon as it has them.
      const read = async (agent: AgentId, call: () => Promise<AccountLimits | null>) => {
        try {
          const limits = await call();
          if (limits) this.mergeLimits([limits]);
          this.limitErrors.update(({ [agent]: _, ...rest }) => rest);
        } catch (e) {
          this.limitErrors.update((all) => ({ ...all, [agent]: errorText(e) }));
        }
      };
      await Promise.all([read('claude', () => this.backend.refreshClaudeLimits()), read('kiro', () => this.backend.refreshKiroLimits())]);
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


  ownChanges(runId: string): Promise<OwnChanges> {
    return this.backend.ownChanges(runId);
  }

  revertFiles(runId: string, paths: string[]): Promise<void> {
    return this.backend.revertFiles(runId, paths);
  }

  commitFiles(runId: string, paths: string[], message: string): Promise<string> {
    return this.backend.commitFiles(runId, paths, message);
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
      const message = errorText(e);
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

  /** A line from the app itself (the project's check), shown as a note in the work log; `key` updates it in place. */
  note(runId: string, text: string, key?: string): void {
    this.runs.update((list) => list.map((r) => {
      if (r.id !== runId) return r;
      const line = { text, tone: 'error' as const, ...(key ? { key } : {}) };
      const at = key ? r.lines.findIndex((l) => l.key === key) : -1;
      return { ...r, lines: at >= 0 ? r.lines.map((l, i) => (i === at ? line : l)) : [...r.lines, line] };
    }));
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
    // The core starts a delegated run without a prompt: the task its parent gave is it.
    const d = e.kind === 'bridge' ? dataOf(e) : {};
    if (d['tool'] === 'delegate' && typeof d['child'] === 'string' && typeof d['task'] === 'string') {
      const [child, task] = [d['child'], d['task']];
      this.runs.update((all) => all.map((r) => (r.id === child && !r.prompt ? { ...r, prompt: task } : r)));
    }
    // A started child names its parent; stopping is known only here.
    const parentId = e.kind === 'started' ? dataOf(e)['parent'] : undefined;
    const ctx = { parent: typeof parentId === 'string' ? this.runs().find((r) => r.id === parentId) : undefined, stopping: this.stopping.has(e.runId) };
    let effects: RunEffect[] = [];
    this.upsert(e.runId, e.agent, (run) => {
      const applied = applyEvent(run, e, ctx);
      effects = applied.effects;
      return applied.run;
    });
    if (e.kind === 'turn_end' || e.kind === 'exit') this.stopping.delete(e.runId);
    for (const fx of effects) this.perform(e, fx);
    if (!this.selectedId()) this.selectedId.set(e.runId);
  }

  private perform(e: AgentEvent, fx: RunEffect): void {
    switch (fx.kind) {
      case 'track': return this.track(e.runId, fx.update, fx.at);
      case 'forget': return this.forget(e.runId);
      case 'limits': return void this.loadLimits();
      case 'commands': {
        const run = this.runs().find((r) => r.id === e.runId);
        if (run) this.agents.setCommands(run.agent, run.project || run.cwd || null, fx.list);
        return;
      }
      case 'handoff': {
        const h = fx.handoff;
        this.handoffs.update((all) => (all.some((x) => x.id === h.id) ? all : [...all, h]));
        return;
      }
    }
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

type Json = Record<string, unknown>;
