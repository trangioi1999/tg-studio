import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AgentsService } from '../../services/agents/agents.service';
import { AGENT_META } from '../../services/agents/agent-meta';
import { AgentBackend } from '../../core/backend';
import { AgentCommand, AgentId, Approval, ConfigChoice, GitPlan, Place } from '../../core/protocol';
import { DEFAULT_TEMPLATES, PipelineService, PipelineStep } from '../../services/runs/pipeline.service';
import { Run, recapOf } from '../../services/runs/run';
import { RunsService } from '../../services/runs/runs.service';
import { ThreadsService } from '../../services/runs/threads.service';
import { errorText } from '../../shared/utils/errors';
import { BudgetService } from '../../services/usage/budget.service';
import { WorkspaceService } from '../../services/workspace.service';
import { AttachmentsService, DraftAttachment } from '../../services/app/attachments.service';
import { GROUP_LABEL, commandQuery, filterCommands, insertCommand } from './composer/commands';

type Mode = 'task' | 'parallel' | 'pipeline' | 'read';

const PIPELINE_KEY = 'tg.pipeline';
/** About this much visible text (and much more context: files read, command output) makes
 * reloading a closed session costly enough to suggest a fresh one. */
const LONG_CONVERSATION = 40_000;

const EFFORT_VI: Record<string, string> = { default: 'Mặc định', minimal: 'Rất thấp', low: 'Thấp', medium: 'Vừa', high: 'Cao', xhigh: 'Rất cao', max: 'Tối đa' };

/**
 * What the chat panel shares between its parts: the open conversation and the composer
 * that hands out work (agent, permission, place, commands, pipeline steps, sending).
 * Provided by AgentPanel, so each panel has its own.
 */
@Injectable()
export class ChatState {
  readonly runs = inject(RunsService);
  readonly agents = inject(AgentsService);
  private readonly pipelines = inject(PipelineService);
  private readonly budget = inject(BudgetService);
  readonly workspace = inject(WorkspaceService);
  readonly threads = inject(ThreadsService);
  private readonly backend = inject(AgentBackend);
  private readonly files = inject(AttachmentsService);
  /** Files for the next message: pasted, dropped or picked. */
  readonly attachments = signal<DraftAttachment[]>([]);
  readonly dragging = signal(false);

  readonly tab = signal<'thread' | 'plan' | 'runs'>('thread');
  readonly run = computed(() => this.runs.selected());
  /** The selected run and, for a parallel task, the rest of its group. */
  /** What the conversation has said so far. Parallel runs are compared, so each shows alone. */
  readonly threadRuns = computed(() => {
    const r = this.run();
    if (!r) return [];
    if (r.group) return [r];
    // Delegated runs show nested in their parent's message, not as turns of their own.
    return this.runs.runs().filter((x) => x.thread === r.thread && !x.parent).sort((a, b) => a.startedAt - b.startedAt);
  });
  readonly taskRuns = computed(() => {
    const r = this.run();
    if (!r) return [];
    const group = this.runs.groupRuns(r.group);
    return group.length ? group : [r];
  });
  readonly pipelineOf = computed(() => this.pipelines.of(this.run()?.id));
  /** Agents this conversation delegated to that wait for an approval: pinned with the rest. */
  readonly childApprovals = computed(() => {
    const ids = new Set(this.threadRuns().map((r) => r.id));
    return this.runs.runs().filter((r) => r.parent && ids.has(r.parent) && r.permissions.length);
  });
  readonly otherApprovals = computed(() => {
    const mine = new Set(this.childApprovals().map((r) => r.id));
    return this.runs.runs().filter((r) => r.permissions.length && r.id !== this.run()?.id && !mine.has(r.id));
  });

  // Composer
  readonly mode = signal<Mode>('task');
  readonly prompt = signal('');
  readonly chosen = signal<AgentId | ''>('');
  /**
   * What the composer follows from the selected run. A string, so a streamed log line or
   * usage update (a new Run object) does not undo what the user just picked.
   */
  private readonly runSetup = computed(() => {
    const r = this.run();
    return r ? JSON.stringify([r.id, r.agent, r.task, r.perm ?? null, r.place ?? null]) : null;
  });
  /** A conversation keeps its agent until the user picks another. */
  private readonly followRun = effect(() => {
    if (!this.runSetup()) return;
    untracked(() => {
      const r = this.run();
      if (!r) return;
      this.chosen.set(r.agent);
      // A conversation keeps its permission and place: the next message works the same way.
      if (!r.task || r.perm === 'read') this.mode.set('read');
      else {
        if (this.mode() === 'read') this.mode.set('task');
        this.approval.set(r.perm === 'auto' ? 'auto' : 'ask');
        if (r.place) this.place.set(r.place);
      }
    });
  });
  /**
   * While the first message of a code conversation is being typed, the core opens the
   * agent's session (~5 s) so the answer starts as fast as in an open CLI. A string, so
   * the effect runs again only when agent, folder or scope change.
   */
  private readonly warmTarget = computed(() => {
    if (!this.prompt().trim() || this.mode() !== 'task' || this.effectivePlace() !== 'direct' || this.blocked()) return null;
    const agent = this.agent();
    const repo = this.workspace.folder();
    const current = this.run();
    // An open session takes the message, and a later task reuses its folder and session.
    if (!agent || !repo || (current?.task && current.perm !== 'read')) return null;
    return JSON.stringify([agent, repo, current ? current.scope : this.threads.draftScope()]);
  });
  private readonly warmUp = effect(() => {
    const target = this.warmTarget();
    if (!target) return;
    const [agent, repo, scope] = JSON.parse(target) as [AgentId, string, string | null];
    untracked(() => this.runs.warm(agent, repo, scope ?? null));
  });
  readonly error = signal<string | null>(null);
  /**
   * The message being sent, shown until the run it starts (or the `user` event of the
   * open session) reaches the conversation. Starting an agent takes seconds.
   */
  readonly pending = signal<{ text: string; agent: AgentId | null; at: number; before: string | null; sent: boolean } | null>(null);
  private readonly settlePending = effect(() => {
    const p = this.pending();
    const r = this.run();
    if (!p?.sent || !r) return;
    if (r.id !== p.before || (r.turnAt ?? 0) >= p.at) untracked(() => this.pending.set(null));
  });
  readonly picks = signal<AgentId[] | null>(null);
  /** Every installed agent takes every permission; questions to agents without a read-only
   * CLI flag run through ACP in a throwaway draft. */
  readonly choices = computed(() => this.agents.agents().filter((a) => a.path));
  /** Hỏi trước or Tự động, for code tasks. */
  readonly approval = signal<'ask' | 'auto'>('ask');
  readonly perm = computed<'read' | 'ask' | 'auto'>(() => (this.mode() === 'read' ? 'read' : this.approval()));
  /** Where a new code task works: the user's folder (default) or a draft from `base`. */
  readonly place = signal<Place>('direct');
  readonly base = signal<string | null>(null);
  readonly branches = signal<string[]>([]);
  /** Several agents at once always use drafts; so do questions to agents without a read-only flag. */
  readonly effectivePlace = computed<Place>(() => (this.team() === 'parallel' ? 'draft' : this.place()));
  /** Questions go through ACP for agents whose CLI has no verified read-only flag. */
  readonly readViaAcp = computed(() => {
    const a = this.agents.agents().find((x) => x.id === this.agent());
    return this.mode() === 'read' && !!a && !a.headless;
  });
  /** The picked agent only while it can work with the chosen permission (Kiro and Gemini have no Chỉ hỏi). */
  readonly agent = computed<AgentId | ''>(() => {
    const chosen = this.chosen();
    const fits = !!chosen && this.choices().some((a) => a.id === chosen);
    return this.mention()?.agent ?? (fits ? chosen : this.choices()[0]?.id || '');
  });
  readonly picked = computed(() => {
    const available = this.choices().map((a) => a.id);
    return (this.picks() ?? available).filter((id) => available.includes(id));
  });
  /** `@codex fix this` hands the task to Codex. */
  private readonly mention = computed(() => {
    const m = /^@(\w+)\s+/.exec(this.prompt());
    const id = m?.[1].toLowerCase() as AgentId | undefined;
    return id && this.choices().some((a) => a.id === id) ? { agent: id, rest: this.prompt().slice(m![0].length) } : null;
  });
  private readonly text = computed(() => (this.mention()?.rest ?? this.prompt()).trim());
  /** Why Run is disabled, in words. */
  readonly blocked = computed(() => {
    if (this.budget.blockReason()) return this.budget.blockReason();
    if (this.mode() === 'read' && this.run() && !this.run()!.task && this.run()!.status === 'running') return 'Agent đang trả lời. Hãy chờ, bấm Dừng, hoặc mở Trò chuyện mới.';
    if (this.mode() === 'task' && this.run()?.task && this.run()?.status === 'running') return 'Agent đang chạy. Hãy chờ, bấm Dừng, hoặc mở Trò chuyện mới.';
    if (!this.choices().length) return 'Chưa có agent nào chạy được. Cài một CLI ở cột Agents rồi bấm Dò lại.';
    if (!this.workspace.folder()) return 'Bấm Mở thư mục ở thanh trên cùng để chọn dự án.';
    if (this.mode() !== 'read' && !this.workspace.repo()) return 'Sửa code cần một repo Git: bấm Khởi tạo Git, hoặc dùng Chỉ hỏi.';
    if (this.mode() !== 'read' && this.workspace.project()?.git === 'no_commits') return 'Sửa code cần ít nhất một commit: bấm Tạo commit đầu tiên, hoặc dùng Chỉ hỏi.';
    if (this.readViaAcp() && this.workspace.project()?.git !== 'ready') return `${AGENT_META[this.agent() as AgentId].name} trả lời câu hỏi trong một bản nháp tạm, nên cần repo Git có ít nhất một commit.`;
    if (this.mode() === 'parallel' && this.picked().length < 2) return 'Cần chọn ít nhất 2 agent.';
    if (this.mode() === 'pipeline' && this.steps().some((s) => !this.choices().some((a) => a.id === s.agent))) return 'Có bước dùng agent chưa cài. Chọn agent khác cho bước đó.';
    return null;
  });
  /** The agent may still work (an API key, say), so this warns rather than blocks. */
  readonly loginHint = computed(() => {
    const id = this.agent();
    const found = id ? this.agents.agents().find((a) => a.id === id) : null;
    return found?.auth === 'none' ? `${found.name} có thể chưa đăng nhập. Chạy trong terminal: ${AGENT_META[found.id].login}` : null;
  });
  readonly gitPlan = signal<GitPlan | null>(null);
  readonly gitBusy = signal(false);
  readonly gitName = signal('');
  readonly gitEmail = signal('');
  readonly dirtyWarning = signal<number | null>(null);
  private dirtyAccepted = false;
  /** The button that makes this folder usable for code tasks, if it needs one. */
  readonly needsGit = computed(() => {
    const project = this.workspace.project();
    if (!project || this.mode() === 'read') return null;
    return project.git === 'none' ? 'Khởi tạo Git…' : project.git === 'no_commits' ? 'Tạo commit đầu tiên…' : null;
  });

  // Composer menus: who works (agent, model, team) and what it may do (permission).
  readonly menu = signal<'agent' | 'perm' | 'place' | null>(null);
  readonly team = computed<'single' | 'parallel' | 'pipeline'>(() => (this.mode() === 'parallel' ? 'parallel' : this.mode() === 'pipeline' ? 'pipeline' : 'single'));

  toggleMenu(which: 'agent' | 'perm' | 'place'): void {
    const opening = this.menu() !== which;
    this.menu.set(opening ? which : null);
    if (opening && which === 'place') void this.loadBranches();
    const a = this.agent();
    if (opening && which === 'agent' && a) void this.agents.loadOptions(a, this.workspace.folder());
  }

  usable(id: AgentId): boolean {
    return !!this.agents.agents().find((x) => x.id === id)?.path;
  }

  pickAgent(id: AgentId): void {
    this.chosen.set(id);
    if (this.team() !== 'single') this.mode.set('task');
    void this.agents.loadOptions(id, this.workspace.folder());
  }

  setTeam(team: 'parallel' | 'pipeline'): void {
    this.mode.set(team);
  }

  setPerm(perm: 'read' | 'ask' | 'auto'): void {
    if (perm === 'read') this.mode.set('read');
    else {
      if (this.mode() === 'read') this.mode.set('task');
      this.approval.set(perm);
    }
    this.menu.set(null);
  }

  setPlace(place: Place, base: string | null = null): void {
    this.place.set(place);
    this.base.set(place === 'draft' ? base : null);
    this.menu.set(null);
  }

  async loadBranches(): Promise<void> {
    const repo = this.workspace.repo()?.root;
    if (!repo) return;
    try {
      this.branches.set(await this.backend.listBranches(repo));
    } catch {
      this.branches.set([]);
    }
  }

  optionsState(a: AgentId): 'loading' | 'error' | 'none' | 'ok' {
    const o = this.agents.options()[a];
    if (o === 'loading' || o === undefined) return 'loading';
    if (o === 'error') return 'error';
    return o.model ? 'ok' : 'none';
  }

  retryOptions(a: AgentId): void {
    void this.agents.loadOptions(a, this.workspace.folder());
  }

  modelOptions(a: AgentId): ConfigChoice[] {
    const o = this.agents.options()[a];
    return o && typeof o === 'object' ? (o.model?.options ?? []) : [];
  }

  effortOptions(a: AgentId): ConfigChoice[] {
    const o = this.agents.options()[a];
    return o && typeof o === 'object' ? (o.effort?.options ?? []) : [];
  }

  currentModel(a: AgentId): string {
    const o = this.agents.options()[a];
    return this.agents.prefs()[a]?.model ?? (o && typeof o === 'object' ? (o.model?.current ?? '') : '');
  }

  currentEffort(a: AgentId): string {
    const o = this.agents.options()[a];
    return this.agents.prefs()[a]?.effort ?? (o && typeof o === 'object' ? (o.effort?.current ?? '') : '');
  }

  effortLabel(o: ConfigChoice): string {
    return EFFORT_VI[o.value] ?? o.name;
  }

  async planGit(): Promise<void> {
    await this.gitAction(async () => this.gitPlan.set(await this.backend.gitPlan(this.workspace.folder())));
  }

  async prepareGit(): Promise<void> {
    await this.gitAction(async () => {
      this.workspace.applyProject(await this.backend.gitPrepare(this.workspace.folder(), this.gitName() || null, this.gitEmail() || null));
      this.gitPlan.set(null);
    });
  }

  private async gitAction(work: () => Promise<void>): Promise<void> {
    this.gitBusy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.gitBusy.set(false);
    }
  }

  sendAnyway(): Promise<void> {
    this.dirtyAccepted = true;
    this.dirtyWarning.set(null);
    return this.send();
  }

  readonly scopeShown = computed(() => {
    const r = this.run();
    return r ? r.scope : this.threads.draftScope();
  });
  readonly placeholder = computed(() => {
    const r = this.run();
    if (this.mode() === 'read' && r && !r.task && r.status !== 'running') return `Hỏi tiếp ${AGENT_META[r.agent].name}… (Enter để gửi, Shift+Enter để xuống dòng)`;
    if (this.mode() === 'task' && r?.task && r.status !== 'running') return `Nhắn tiếp cho ${AGENT_META[r.agent].name}, hoặc @mention agent khác… (Enter để gửi, Shift+Enter để xuống dòng)`;
    return 'Giao việc, hỏi, hoặc @mention agent… (Enter để gửi, Shift+Enter để xuống dòng)';
  });
  readonly sending = signal(false);
  /**
   * The open conversation's agent session has closed (app restarted, idle limit, finished).
   * Its next message either reloads that session, whose whole history the model reads again,
   * or opens a new one told a summary: far fewer tokens for a long conversation, fewer details.
   */
  readonly resumeChoice = computed(() => {
    const r = this.run();
    if (!r || this.team() !== 'single' || this.agent() !== r.agent || r.status === 'running') return null;
    if (!r.restored && r.status === 'idle') return null; // still open: the next message is cheap
    if (this.perm() === 'read' ? r.task || this.readViaAcp() : !r.task || r.perm === 'read') return null;
    const turns = 1 + r.lines.filter((l) => l.tone === 'user').length;
    const chars = r.lines.reduce((n, l) => n + l.text.length, r.prompt.length);
    return { turns, long: chars > LONG_CONVERSATION || turns >= 10, recapTokens: Math.max(1, Math.round(recapOf(r).length / 3)) };
  });
  /** The user's pick for that choice; null: the default for its length. */
  readonly resumePick = signal<'resume' | 'fresh' | null>(null);
  readonly resumeMode = computed(() => {
    const choice = this.resumeChoice();
    return choice ? (this.resumePick() ?? (choice.long ? 'fresh' : 'resume')) : null;
  });
  private readonly forgetResumePick = effect(() => {
    this.run()?.id;
    untracked(() => this.resumePick.set(null));
  });

  readonly canRun = computed(() => !this.blocked() && (!!this.text() || this.attachments().length > 0) && !this.sending());

  async addFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    const { drafts, refused } = await this.files.read(files, this.attachments().length);
    this.attachments.update((all) => [...all, ...drafts]);
    this.error.set(refused.length ? `Không đính kèm được: ${refused.join(', ')}.` : null);
  }

  removeAttachment(id: number): void {
    this.attachments.update((all) => all.filter((a) => a.id !== id));
  }

  /** A pasted screenshot or file becomes an attachment; pasted text stays text. */
  onPaste(e: ClipboardEvent): void {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    if (!e.clipboardData?.getData('text/plain')) e.preventDefault();
    void this.addFiles(files);
  }

  onDragOver(e: DragEvent): void {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    this.dragging.set(true);
  }

  onDrop(e: DragEvent): void {
    this.dragging.set(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    void this.addFiles(files);
  }

  // Pipeline steps, remembered for the next task.
  readonly editSteps = signal(false);
  private readonly savedSteps = signal<PipelineStep[] | null>(loadSteps());
  readonly steps = computed<PipelineStep[]>(() => {
    const saved = this.savedSteps();
    if (saved) return saved;
    const ids = this.choices().map((a) => a.id);
    const pick = (i: number): AgentId => (ids[i % Math.max(ids.length, 1)] ?? 'claude') as AgentId;
    return [
      { name: 'Plan', agent: pick(0), template: DEFAULT_TEMPLATES.plan },
      { name: 'Build', agent: pick(1), template: DEFAULT_TEMPLATES.build },
      { name: 'Review', agent: pick(2), template: DEFAULT_TEMPLATES.review },
    ];
  });

  setStep(i: number, change: Partial<PipelineStep>): void {
    const next = this.steps().map((s, j) => (j === i ? { ...s, ...change } : s));
    this.savedSteps.set(next);
    try {
      localStorage.setItem(PIPELINE_KEY, JSON.stringify(next));
    } catch {
      /* remembered for this session only */
    }
  }

  resetSteps(): void {
    this.savedSteps.set(null);
    try {
      localStorage.removeItem(PIPELINE_KEY);
    } catch {
      /* nothing saved */
    }
  }

  toggle(id: AgentId): void {
    const now = this.picked();
    this.picks.set(now.includes(id) ? now.filter((a) => a !== id) : [...now, id]);
  }

  onEnter(e: KeyboardEvent): void {
    // Enter while a Vietnamese input method is composing only commits the word.
    if (e.shiftKey || e.isComposing) return;
    e.preventDefault();
    void this.send();
  }

  // Skills and commands: "/" at the start of the message, or "$" for Codex.
  /** The composer's text box, set by the composer, so a picked command can move the caret. */
  box: HTMLTextAreaElement | null = null;
  readonly caret = signal(0);
  readonly groupLabel = GROUP_LABEL;
  private readonly cmdIndex = signal(0);
  /** Closed with Esc until the typed word changes. */
  private readonly cmdDismissed = signal<string | null>(null);
  private readonly cmdQuery = computed(() => commandQuery(this.prompt(), this.caret(), this.agent()));
  readonly cmdMenu = computed(() => {
    const q = this.cmdQuery();
    const agent = this.agent();
    if (!q || !agent || this.cmdDismissed() === `${q.start}:${q.query}`) return null;
    const list = this.agents.commandsFor(agent, this.workspace.folder());
    const name = AGENT_META[agent].name;
    if (list === null || list === 'loading') return { agent: name, query: q.query, loading: true, groups: [], active: null as AgentCommand | null };
    const groups = filterCommands(list, q);
    const flat = groups.flatMap((g) => g.items);
    const active = flat.length ? flat[Math.min(this.cmdIndex(), flat.length - 1)] : null;
    return { agent: name, query: q.query, loading: false, groups, active, flat };
  });
  /** The list is read the first time the user asks for it, not on every folder opened. */
  private readonly cmdLoad = effect(() => {
    const agent = this.agent();
    if (!this.cmdQuery() || !agent) return;
    const folder = this.workspace.folder();
    untracked(() => void this.agents.loadCommands(agent, folder));
  });

  onInput(box: HTMLTextAreaElement): void {
    this.prompt.set(box.value);
    this.caret.set(box.selectionStart);
    this.cmdIndex.set(0);
  }

  onKeyUp(e: KeyboardEvent): void {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) this.caret.set((e.target as HTMLTextAreaElement).selectionStart);
  }

  onKeyDown(e: KeyboardEvent): void {
    const menu = this.cmdMenu();
    const flat = menu && !menu.loading ? menu.flat ?? [] : [];
    if (menu && !e.isComposing) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const q = this.cmdQuery()!;
        this.cmdDismissed.set(`${q.start}:${q.query}`);
        return;
      }
      if (flat.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const i = flat.indexOf(menu.active!);
        this.cmdIndex.set((i + (e.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length);
        return;
      }
      if (menu.active && ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')) {
        e.preventDefault();
        this.pickCommand(menu.active);
        return;
      }
    }
    if (e.key === 'Enter') this.onEnter(e);
  }

  pickCommand(c: AgentCommand): void {
    const q = this.cmdQuery();
    if (!q) return;
    const done = insertCommand(this.prompt(), this.caret(), q, c);
    this.prompt.set(done.text);
    this.caret.set(done.caret);
    const box = this.box;
    if (box) {
      box.value = done.text;
      box.focus();
      box.setSelectionRange(done.caret, done.caret);
    }
  }

  newChat(): void {
    this.runs.selectedId.set(null);
    this.threads.draftScope.set(null);
    this.chosen.set('');
    this.prompt.set('');
    this.attachments.set([]);
    this.error.set(null);
  }

  async send(): Promise<void> {
    if (!this.canRun()) return;
    const agent = this.agent();
    let text = this.text();
    const cwd = this.workspace.folder();
    this.error.set(null);
    this.sending.set(true);
    let typed: string | null = null;
    let drafts: DraftAttachment[] = [];
    try {
      const current = this.run();
      const perm = this.perm();
      const approval: Approval = perm === 'read' ? 'deny' : perm;
      const place = this.effectivePlace();
      const base = place === 'draft' ? this.base() : null;
      // Only a new draft starts from the latest commit; warn once per decision.
      const newDraft = this.mode() !== 'read' && place === 'draft' && !current?.task;
      if (newDraft && !this.dirtyAccepted) {
        await this.workspace.reloadProject();
        const dirty = this.workspace.project()?.uncommitted ?? 0;
        if (dirty > 0) {
          this.dirtyWarning.set(dirty);
          return;
        }
      }
      this.dirtyAccepted = false;
      typed = this.prompt();
      drafts = this.attachments();
      this.prompt.set('');
      this.attachments.set([]);
      if (drafts.length) text = await this.files.attach(text, drafts);
      this.pending.set({ text, agent: this.team() === 'single' && agent ? agent : null, at: Date.now(), before: current?.id ?? null, sent: false });
      if (this.mode() === 'pipeline') {
        const started = await this.pipelines.start(text, cwd, this.steps(), { place, base, approval });
        // No run exists yet to show this in the thread, and the prompt must not be lost.
        if (started.status === 'failed') {
          this.error.set(started.error);
          this.restore(typed, drafts);
          return;
        }
      } else if (this.mode() === 'parallel') {
        const failed = await this.runs.startParallel(this.picked(), text, cwd, this.threads.draftScope(), { base, approval });
        if (failed.length) this.error.set(`Không chạy được: ${failed.join('; ')}`);
      } else if (agent) {
        // Switching agent or permission keeps the conversation: same thread, with a recap.
        const thread = current?.thread;
        const recap = current ? recapOf(current) : undefined;
        const scope = current ? current.scope : this.threads.draftScope();
        const liveSession = current?.task && current.agent === agent && current.status === 'idle';
        // A question's throwaway draft must never receive edits: leaving Chỉ hỏi starts afresh.
        const leavingThrowaway = current?.perm === 'read' && perm !== 'read';
        if (liveSession && !leavingThrowaway && (perm !== 'read' || current!.perm === 'read' || this.readViaAcp())) {
          // The open session takes the message; only its approval mode changes.
          if (current!.perm !== perm) await this.runs.setApproval(current!.id, approval);
          await this.runs.sendMessage(current!.id, text);
        } else if (perm === 'read' && !this.readViaAcp() && current && !current.task && current.agent === agent && current.status === 'idle') {
          // Claude's Chỉ hỏi process is still open: the question goes straight to it. It may
          // have just closed (idle limit, crash) before its exit reached the UI: resume instead.
          try {
            await this.runs.sendMessage(current.id, text);
          } catch (e) {
            if (!(errorText(e)).includes('đã đóng')) throw e;
            await this.runs.start(agent, text, cwd, thread, current.id, scope, null);
          }
        } else if (perm === 'read' && !this.readViaAcp()) {
          // Read-only CLI run on the real folder; the core resumes this agent's CLI session.
          const fresh = this.resumeMode() === 'fresh';
          const resumable = !fresh && current && !current.task && current.agent === agent && current.status !== 'running' ? current : null;
          await this.runs.start(agent, text, cwd, thread, resumable?.id ?? null, scope, resumable || !current ? null : (recap ?? null));
        } else {
          // A code task (or an ACP question). An earlier code task's draft or folder is reused.
          const reuse = current?.task && current.perm !== 'read' && perm !== 'read' ? current.id : undefined;
          await this.runs.startTask(agent, text, cwd, { reuse, recap, thread, scope, place, base, approval, fresh: this.resumeMode() === 'fresh' });
        }
      }
      this.tab.set('thread');
      const sent = this.pending();
      if (sent) {
        this.pending.set({ ...sent, sent: true });
        // An agent that never reports the turn must not leave the message hanging.
        setTimeout(() => { if (this.pending()?.at === sent.at) this.pending.set(null); }, 4000);
      }
    } catch (e) {
      this.error.set(errorText(e));
      this.restore(typed, drafts);
    } finally {
      this.sending.set(false);
    }
  }

  /** Why the plan cannot be carried out here (code tasks need a Git repo with a commit). */
  blockedForEdit(): string | null {
    if (!this.workspace.repo()) return 'Sửa code cần một repo Git.';
    if (this.workspace.project()?.git === 'no_commits') return 'Sửa code cần ít nhất một commit.';
    return null;
  }

  /** Yes to a Chỉ hỏi plan: the conversation moves to Hỏi trước and the agent carries it out. */
  async actOnProposal(r: Run): Promise<void> {
    if (!r.proposal) return;
    this.chosen.set(r.agent);
    this.setPerm('ask');
    this.prompt.set(`Làm theo kế hoạch đã đề xuất:\n\n${r.proposal}`);
    await this.send();
  }

  /** A failed send gives the words back, unless the user already typed something new. */
  private restore(typed: string | null, drafts: DraftAttachment[] = []): void {
    this.pending.set(null);
    if (typed !== null && !this.prompt().trim()) this.prompt.set(typed);
    if (drafts.length && !this.attachments().length) this.attachments.set(drafts);
  }
}

function loadSteps(): PipelineStep[] | null {
  try {
    const raw = localStorage.getItem(PIPELINE_KEY);
    const steps = raw ? (JSON.parse(raw) as PipelineStep[]) : null;
    return Array.isArray(steps) && steps.every((s) => s && typeof s.name === 'string' && typeof s.template === 'string') ? steps : null;
  } catch {
    return null;
  }
}
