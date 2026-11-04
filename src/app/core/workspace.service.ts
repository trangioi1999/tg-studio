import { Injectable, computed, inject, signal } from '@angular/core';
import { AgentBackend } from './backend';
import { FileDiff, RepoInfo } from './protocol';
import { RunsService } from './runs.service';

/** What the center area shows. Files and reviews belong to a run's worktree. */
export type Tab =
  | { kind: 'file'; runId: string; path: string }
  | { kind: 'changes'; runId: string }
  | { kind: 'compare'; group: string };

const REPO_KEY = 'tg.repo';

export function tabKey(t: Tab): string {
  return t.kind === 'file' ? `file:${t.runId}:${t.path}` : t.kind === 'changes' ? `changes:${t.runId}` : `compare:${t.group}`;
}

/** The repository being worked on and the open editor tabs. */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private readonly backend = inject(AgentBackend);
  private readonly runs = inject(RunsService);

  /** Folder chosen by the user; tasks run in the Git repo that contains it. */
  readonly folder = signal('');
  readonly repo = signal<RepoInfo | null>(null);
  readonly repoError = signal<string | null>(null);
  readonly tabs = signal<Tab[]>([]);
  readonly activeKey = signal<string | null>(null);
  readonly active = computed(() => this.tabs().find((t) => tabKey(t) === this.activeKey()) ?? null);
  /** While the agent runs, open the file it is working on. */
  readonly follow = signal(true);
  /** Worktree files and pending changes per task run, shared by explorer, editor and tabs. */
  readonly files = signal<Record<string, string[]>>({});
  readonly diffs = signal<Record<string, FileDiff[]>>({});
  private loads: Record<string, number> = {};

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(REPO_KEY);
    } catch {
      /* storage can be unavailable; fall back to the home folder */
    }
    await this.setFolder(saved ?? (await this.backend.homeDir()) ?? '');
  }

  async setFolder(path: string): Promise<void> {
    this.folder.set(path);
    try {
      localStorage.setItem(REPO_KEY, path);
    } catch {
      /* not essential */
    }
    if (!path.trim()) {
      this.repo.set(null);
      return;
    }
    try {
      this.repo.set(await this.backend.repoInfo(path));
      this.repoError.set(null);
    } catch (e) {
      this.repo.set(null);
      this.repoError.set(e instanceof Error ? e.message : String(e));
    }
  }

  open(tab: Tab): void {
    const key = tabKey(tab);
    if (!this.tabs().some((t) => tabKey(t) === key)) this.tabs.update((list) => [...list, tab]);
    this.activeKey.set(key);
    const runId = tab.kind === 'compare' ? this.runs.groupRuns(tab.group)[0]?.id : tab.runId;
    if (runId && this.runs.selectedId() !== runId && tab.kind !== 'compare') this.runs.selectedId.set(runId);
  }

  openFile(runId: string, path: string): void {
    this.open({ kind: 'file', runId, path });
  }

  close(key: string): void {
    const list = this.tabs();
    const i = list.findIndex((t) => tabKey(t) === key);
    if (i < 0) return;
    const next = list.filter((_, j) => j !== i);
    this.tabs.set(next);
    if (this.activeKey() === key) {
      const neighbour = next[Math.min(i, next.length - 1)];
      this.activeKey.set(neighbour ? tabKey(neighbour) : null);
    }
  }

  /** Reloads a run's file list and pending changes; a newer call wins. */
  async refresh(runId: string): Promise<void> {
    const ticket = (this.loads[runId] = (this.loads[runId] ?? 0) + 1);
    try {
      const [files, diffs] = await Promise.all([this.runs.listFiles(runId), this.runs.getDiff(runId)]);
      if (ticket !== this.loads[runId]) return;
      this.files.update((f) => ({ ...f, [runId]: files }));
      this.diffs.update((d) => ({ ...d, [runId]: diffs }));
    } catch {
      if (ticket !== this.loads[runId]) return;
      this.files.update((f) => ({ ...f, [runId]: [] }));
      this.diffs.update((d) => ({ ...d, [runId]: [] }));
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

  /** Drops tabs of a run whose worktree is gone. */
  closeRun(runId: string): void {
    for (const t of this.tabs()) if (t.kind !== 'compare' && t.runId === runId) this.close(tabKey(t));
  }
}
