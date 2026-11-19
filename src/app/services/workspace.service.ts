import { Injectable, WritableSignal, computed, inject, linkedSignal, signal, untracked } from '@angular/core';
import { AgentBackend } from '../core/backend';
import { FileDiff, Project, RepoInfo } from '../core/protocol';
import { RunsService } from './runs/runs.service';
import { errorText } from '../shared/utils/errors';

/** What the center area shows. Files and reviews belong to a run's worktree. */
export type Tab =
  | { kind: 'file'; runId: string; path: string }
  | { kind: 'source'; root: string; path: string }
  | { kind: 'changes'; runId: string }
  | { kind: 'compare'; group: string };

const REPO_KEY = 'tg.repo';

export function tabKey(t: Tab): string {
  if (t.kind === 'source') return `source:${t.root}:${t.path}`;
  return t.kind === 'file' ? `file:${t.runId}:${t.path}` : t.kind === 'changes' ? `changes:${t.runId}` : `compare:${t.group}`;
}

/** The repository being worked on and the open editor tabs. */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private readonly backend = inject(AgentBackend);
  private readonly runs = inject(RunsService);

  /** The open folder, resolved by the core. Empty until the user picks one. */
  readonly folder = signal('');
  readonly project = signal<Project | null>(null);
  /** Null outside a Git repository. */
  readonly repo = signal<RepoInfo | null>(null);
  /** Why the last open failed. The previous project stays open. */
  readonly folderError = signal<string | null>(null);
  /** The opened project's own files, viewable before any task exists. */
  readonly projectFiles = signal<string[]>([]);
  readonly projectFilesError = signal<string | null>(null);
  /** Settles when the latest listing is done. */
  filesLoaded: Promise<void> = Promise.resolve();
  private filesTicket = 0;
  /**
   * Tabs belong to a conversation: opening another one shows its own files, and a new
   * conversation starts without the last one's (they come back when it is opened again).
   * Before its first message a conversation is `new:<folder>`; that message's run takes its tabs.
   */
  readonly tabScope = computed(() => this.runs.selected()?.thread ?? `new:${this.folder()}`);
  private readonly stashes: Map<string, unknown>[] = [];
  readonly tabs = this.scoped<Tab[]>([]);
  readonly activeKey = this.scoped<string | null>(null);
  /** The one tab that the next preview replaces; shown in italics. */
  readonly previewKey = this.scoped<string | null>(null);
  readonly active = computed(() => this.tabs().find((t) => tabKey(t) === this.activeKey()) ?? null);
  /** While the agent runs, open the file it is working on. */
  readonly follow = signal(true);
  /** Worktree files and pending changes per task run, shared by explorer, editor and tabs. */
  readonly files = signal<Record<string, string[]>>({});
  readonly diffs = signal<Record<string, FileDiff[]>>({});
  /** Unsaved edits, kept while the editor is closed by moving to another kind of tab. */
  readonly unsaved = new Map<string, string>();
  /** A draft's files once applied to the folder, by run: what its commit takes. Kept here,
   * not in the Changes tab, because they leave the diff once applied. */
  readonly applied = signal<Record<string, string[]>>({});
  private loads: Record<string, number> = {};

  /** Settles once the saved folder has been restored or dropped. */
  readonly ready: Promise<void>;
  private openTicket = 0;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const saved = readSaved();
    if (!saved) return;
    const ticket = ++this.openTicket;
    try {
      const project = await this.backend.openProject(saved);
      if (ticket === this.openTicket) this.apply(project);
    } catch {
      // It moved or was deleted: nothing the user just did, so no error to show.
      if (ticket === this.openTicket) writeSaved(null);
    }
  }

  /** Opens a typed or picked path. On failure the current project stays as it was. */
  async setFolder(path: string): Promise<boolean> {
    const ticket = ++this.openTicket;
    try {
      const project = await this.backend.openProject(path);
      if (ticket !== this.openTicket) return false;
      this.apply(project);
      return true;
    } catch (e) {
      if (ticket === this.openTicket) this.folderError.set(errorText(e));
      return false;
    }
  }

  async pickFolder(): Promise<void> {
    let picked: string | null;
    try {
      picked = await this.backend.pickFolder();
    } catch (e) {
      this.folderError.set(errorText(e));
      return;
    }
    if (picked) await this.setFolder(picked);
  }

  /** Takes the state of the open project again, say after the user committed. */
  async reloadProject(): Promise<void> {
    const root = this.folder();
    if (!root) return;
    try {
      const project = await this.backend.openProject(root);
      if (project.root === this.folder()) this.apply(project);
    } catch {
      /* the next action reports it */
    }
  }

  applyProject(project: Project): void {
    this.apply(project);
  }

  private apply(project: Project): void {
    this.project.set(project);
    this.folder.set(project.root);
    this.repo.set(project.git === 'none' ? null : { root: project.root, name: project.name, branch: project.branch });
    this.folderError.set(null);
    writeSaved(project.root);
    this.reloadProjectFiles();
  }

  reloadProjectFiles(): void {
    const root = this.folder();
    if (!root) return;
    const ticket = ++this.filesTicket;
    this.filesLoaded = this.backend.listProjectFiles(root).then(
      (files) => {
        if (ticket !== this.filesTicket) return;
        this.projectFiles.set(files);
        this.projectFilesError.set(null);
      },
      (e) => {
        if (ticket !== this.filesTicket) return;
        this.projectFiles.set([]);
        this.projectFilesError.set(errorText(e));
      },
    );
  }

  openSource(path: string, preview = false): void {
    this.open({ kind: 'source', root: this.folder(), path }, { preview });
  }

  /**
   * Opens or activates a tab. A preview tab (a file glanced at from the tree, or followed while
   * the agent works) is replaced by the next preview, like an editor's single click; opening
   * it again without `preview` keeps it.
   */
  open(tab: Tab, opts: { preview?: boolean } = {}): void {
    // A tab of another run joins that run's conversation, so select it first.
    if ((tab.kind === 'file' || tab.kind === 'changes') && this.runs.selectedId() !== tab.runId) this.runs.selectedId.set(tab.runId);
    const key = tabKey(tab);
    const list = this.tabs();
    const preview = this.previewKey();
    if (list.some((t) => tabKey(t) === key)) {
      if (!opts.preview && preview === key) this.previewKey.set(null);
    } else if (opts.preview && preview && list.some((t) => tabKey(t) === preview)) {
      this.tabs.set(list.map((t) => (tabKey(t) === preview ? tab : t)));
      this.previewKey.set(key);
    } else {
      this.tabs.set([...list, tab]);
      if (opts.preview) this.previewKey.set(key);
    }
    this.activeKey.set(key);
  }

  openFile(runId: string, path: string, preview = false): void {
    this.open({ kind: 'file', runId, path }, { preview });
  }

  /** Keeps a preview tab open, say once the user double-clicks or edits it. */
  pin(key: string): void {
    if (this.previewKey() === key) this.previewKey.set(null);
  }

  close(key: string): void {
    const list = this.tabs();
    const i = list.findIndex((t) => tabKey(t) === key);
    if (i < 0) return;
    const next = list.filter((_, j) => j !== i);
    this.tabs.set(next);
    if (this.previewKey() === key) this.previewKey.set(null);
    if (this.activeKey() === key) {
      const neighbour = next[Math.min(i, next.length - 1)];
      this.activeKey.set(neighbour ? tabKey(neighbour) : null);
    }
  }

  /** Why the last reload of a run failed; its files and changes stay as last read. */
  readonly refreshErrors = signal<Record<string, string>>({});

  /** Reloads a run's file list and pending changes; a newer call wins. */
  async refresh(runId: string): Promise<void> {
    const ticket = (this.loads[runId] = (this.loads[runId] ?? 0) + 1);
    try {
      const [files, diffs] = await Promise.all([this.runs.listFiles(runId), this.runs.getDiff(runId)]);
      if (ticket !== this.loads[runId]) return;
      this.files.update((f) => ({ ...f, [runId]: files }));
      this.diffs.update((d) => ({ ...d, [runId]: diffs }));
      this.refreshErrors.update(({ [runId]: _, ...rest }) => rest);
    } catch (e) {
      if (ticket !== this.loads[runId]) return;
      // A Git lock or a read error is not "no changes": keep what was last read.
      this.refreshErrors.update((all) => ({ ...all, [runId]: errorText(e) }));
    }
  }

  /** Agents send absolute paths; map them into the run's worktree. */
  relative(runId: string, path: string): string | null {
    const norm = path.replace(/\\/g, '/');
    const marker = `/.tg/worktrees/${runId}/`;
    const at = norm.indexOf(marker);
    if (at >= 0) return norm.slice(at + marker.length);
    const files = this.files()[runId] ?? [];
    return files.filter((f) => norm === f || norm.endsWith(`/${f}`)).sort((a, b) => b.length - a.length)[0] ?? null;
  }

  /** Drops tabs of a run whose worktree is gone, in every conversation. */
  closeRun(runId: string): void {
    const ofRun = (t: Tab) => (t.kind === 'file' || t.kind === 'changes') && t.runId === runId;
    // Settle all three on the current conversation first, so the stashes are up to date.
    this.activeKey();
    this.previewKey();
    for (const t of this.tabs()) if (ofRun(t)) this.close(tabKey(t));
    const tabs = this.stashes[0] as Map<string, Tab[]>;
    const active = this.stashes[1] as Map<string, string | null>;
    const preview = this.stashes[2] as Map<string, string | null>;
    for (const [scope, list] of tabs) {
      const gone = new Set(list.filter(ofRun).map(tabKey));
      if (!gone.size) continue;
      const kept = list.filter((t) => !gone.has(tabKey(t)));
      tabs.set(scope, kept);
      if (gone.has(active.get(scope) ?? '')) active.set(scope, kept[0] ? tabKey(kept[0]) : null);
      if (gone.has(preview.get(scope) ?? '')) preview.set(scope, null);
    }
  }

  /**
   * A signal whose value is kept per {@link tabScope}: switching conversation puts the current
   * value aside and brings back that conversation's own (or `initial`).
   */
  private scoped<T>(initial: T): WritableSignal<T> {
    const stash = new Map<string, T>();
    this.stashes.push(stash as Map<string, unknown>);
    return linkedSignal<string, T>({
      source: this.tabScope,
      computation: (scope, prev) => {
        if (!prev) return stash.get(scope) ?? initial;
        stash.set(prev.source, prev.value);
        const own = stash.get(scope);
        if (own !== undefined) return own;
        // The first message of a new conversation: what was open while writing it stays open.
        if (prev.source.startsWith('new:') && untracked(() => this.isNewThread(scope))) {
          stash.delete(prev.source);
          return prev.value;
        }
        return initial;
      },
    });
  }

  /** A conversation that has only just started in this session. */
  private isNewThread(thread: string): boolean {
    const runs = this.runs.runs().filter((r) => r.thread === thread);
    return runs.length > 0 && runs.every((r) => !r.restored) && runs.length <= 1;
  }
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(REPO_KEY);
  } catch {
    return null;
  }
}

function writeSaved(path: string | null): void {
  try {
    if (path === null) localStorage.removeItem(REPO_KEY);
    else localStorage.setItem(REPO_KEY, path);
  } catch {
    /* not essential */
  }
}
