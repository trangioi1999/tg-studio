import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AgentId } from '../core/protocol';
import { Run, RunsService } from './runs.service';
import { WorkspaceService } from '../workspace/workspace.service';

export type ThreadStatus = 'needs_you' | 'running' | 'failed' | 'waiting' | 'ended';

export const THREAD_STATUS_LABEL: Record<ThreadStatus, string> = {
  needs_you: 'Chờ duyệt', running: 'Đang làm', failed: 'Lỗi', waiting: 'Xong', ended: 'Xong',
};

/** What the user sees and chats in. Each of its runs is one agent session. */
export interface Thread {
  id: string;
  project: string;
  /** The subfolder it is about, if any. */
  scope: string | null;
  title: string;
  agents: AgentId[];
  status: ThreadStatus;
  updatedAt: number;
  /** The run the conversation continues with: the newest. */
  latest: Run;
}

export interface ProjectGroup {
  root: string;
  name: string;
  /** Conversations about the whole project. */
  threads: Thread[];
  /** Conversations about one subfolder. A project that uses none shows no such level. */
  scopes: { scope: string; threads: Thread[] }[];
}

const ORDER: ThreadStatus[] = ['needs_you', 'running', 'failed', 'waiting', 'ended'];
const RECENT_KEY = 'tg.recent';
const MAX_RECENT = 8;

function statusOf(runs: Run[], latest: Run): ThreadStatus {
  if (runs.some((r) => r.permissions.length)) return 'needs_you';
  if (runs.some((r) => r.status === 'running')) return 'running';
  if (runs.some((r) => r.status === 'idle')) return 'waiting';
  return latest.status === 'failed' || latest.status === 'interrupted' ? 'failed' : 'ended';
}

export function buildThreads(runs: Run[]): Thread[] {
  const byThread = new Map<string, Run[]>();
  for (const r of runs) byThread.set(r.thread, [...(byThread.get(r.thread) ?? []), r]);
  const threads = [...byThread.entries()].map(([id, list]): Thread => {
    const sorted = [...list].sort((a, b) => a.startedAt - b.startedAt);
    // The user talks to top-level runs; a delegated agent only keeps the conversation busy.
    const main = sorted.filter((r) => !r.parent);
    const talked = main.length ? main : sorted;
    const latest = talked.at(-1)!;
    return {
      id,
      project: sorted.find((r) => r.project)?.project ?? '',
      scope: talked[0].scope,
      title: (talked[0].prompt || 'Cuộc trò chuyện').slice(0, 80),
      agents: [...new Set(talked.map((r) => r.agent))],
      status: statusOf(sorted, latest),
      updatedAt: Math.max(...sorted.map((r) => r.endedAt ?? r.startedAt)),
      latest,
    };
  });
  return threads.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.updatedAt - a.updatedAt);
}

function baseName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

/** Conversations per project. The open folder and recent ones show even with no conversation. */
export function groupByProject(threads: Thread[], folder: string, recent: string[]): ProjectGroup[] {
  const roots = [...new Set([...(folder ? [folder] : []), ...threads.map((t) => t.project).filter(Boolean), ...recent])];
  return roots.map((root) => {
    const mine = threads.filter((t) => t.project === root);
    const scopes = [...new Set(mine.flatMap((t) => (t.scope ? [t.scope] : [])))].sort();
    return {
      root,
      name: baseName(root),
      threads: mine.filter((t) => !t.scope),
      scopes: scopes.map((scope) => ({ scope, threads: mine.filter((t) => t.scope === scope) })),
    };
  });
}

function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

@Injectable({ providedIn: 'root' })
export class ThreadsService {
  private readonly runs = inject(RunsService);
  private readonly workspace = inject(WorkspaceService);
  readonly recent = signal<string[]>(readRecent());
  readonly threads = computed(() => buildThreads(this.runs.runs()));
  readonly projects = computed(() => groupByProject(this.threads(), this.workspace.folder(), this.recent()));
  /** The subfolder the next new conversation is about. */
  readonly draftScope = signal<string | null>(null);
  readonly selectedId = computed(() => this.runs.selected()?.thread ?? null);

  constructor() {
    effect(() => {
      const folder = this.workspace.folder();
      if (folder) untracked(() => this.remember(folder));
    });
  }

  private remember(folder: string): void {
    const next = [folder, ...this.recent().filter((p) => p !== folder)].slice(0, MAX_RECENT);
    this.recent.set(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* not essential */
    }
  }

  forget(root: string): void {
    const next = this.recent().filter((p) => p !== root);
    this.recent.set(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* not essential */
    }
  }

  /** Opens a conversation, and its project if another one is open. */
  async select(thread: Thread): Promise<void> {
    this.runs.selectedId.set(thread.latest.id);
    if (thread.project && thread.project !== this.workspace.folder()) await this.workspace.setFolder(thread.project);
  }

  /** Empties the composer's target, in the given project. */
  /** Deletes a conversation: its history and drafts. Usage stays counted. */
  async remove(threadId: string): Promise<void> {
    const ids = this.runs.runs().filter((r) => r.thread === threadId).map((r) => r.id);
    try {
      await this.runs.deleteRuns(ids);
    } finally {
      // Gone from history (even when a draft could not be cleaned): its tabs go too.
      for (const id of ids) if (!this.runs.runs().some((r) => r.id === id)) this.workspace.closeRun(id);
    }
  }

  async newChat(root?: string, scope: string | null = null): Promise<void> {
    this.runs.selectedId.set(null);
    this.draftScope.set(scope);
    if (root && root !== this.workspace.folder()) await this.workspace.setFolder(root);
  }
}
