import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { RunsService } from '../runs/runs.service';
import { WorkspaceService } from '../workspace.service';

export type Screen = 'chat' | 'mission' | 'usage' | 'settings';
export type ConsoleView = 'log' | 'changes' | 'editor' | 'compare';
/** The parts of Cài đặt: agents, MCP and skills, prices and budgets, the diagnostics report. */
export type SettingsTab = 'agents' | 'connections' | 'prices' | 'diagnostics';

/** Below this width the sidebar folds to a rail on its own (spec §6). */
export const NARROW_QUERY = '(max-width: 1199px)';
export const SIDEBAR_KEY = 'tg.sidebar';
/** Below this the code panel is too narrow for the file tree and an editor side by side. */
export const SIDE_COMPACT_PX = 640;

/** Which screen shows, the sidebar and the code panel, so any screen can open a run. */
@Injectable({ providedIn: 'root' })
export class UiService {
  private readonly runs = inject(RunsService);
  private readonly workspace = inject(WorkspaceService);
  readonly screen = signal<Screen>('chat');
  readonly settingsTab = signal<SettingsTab>('agents');
  /** Files and changes beside the chat. Closed until wanted. */
  readonly sideOpen = signal(false);
  /** The panel is narrower than {@link SIDE_COMPACT_PX}: the file tree folds away unless asked for. */
  readonly sideCompact = signal(false);
  /** The user's choice for the file tree beside the editor; null follows the panel's width. */
  readonly filesOpen = signal<boolean | null>(null);
  readonly filesShown = computed(() => this.filesOpen() ?? !this.sideCompact());
  /** The run whose big terminal window is open, if any. */
  readonly agentWindow = signal<string | null>(null);
  /** Per parent run, the delegated agent open as a small terminal: one per message, even across markers. */
  readonly openDelegation = signal<Record<string, string>>({});
  private agentWindowFrom: HTMLElement | null = null;
  /** The window is narrower than {@link NARROW_QUERY}. */
  readonly narrow = signal(false);
  /** The user's choice on a wide window, kept per machine. */
  readonly sidebarPref = signal(readSidebar());
  /** On a narrow window the sidebar opens over the chat until a choice is made or ⌘B again. */
  readonly sidebarPeek = signal(false);
  /** The sidebar shows as a rail of icons. */
  readonly sidebarCollapsed = computed(() => (this.narrow() ? !this.sidebarPeek() : !this.sidebarPref()));

  constructor() {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(NARROW_QUERY);
    this.narrow.set(mq.matches);
    const onChange = (e: MediaQueryListEvent) => {
      this.narrow.set(e.matches);
      this.sidebarPeek.set(false);
    };
    mq.addEventListener?.('change', onChange);
    inject(DestroyRef).onDestroy(() => mq.removeEventListener?.('change', onChange));
  }

  /** ⌘B / Ctrl+B and the title bar button. */
  toggleSidebar(): void {
    if (this.narrow()) {
      this.sidebarPeek.set(!this.sidebarPeek());
      return;
    }
    const open = !this.sidebarPref();
    this.sidebarPref.set(open);
    writeSidebar(open);
  }

  /** A choice made in the sidebar drawer closes it. */
  closePeek(): void {
    this.sidebarPeek.set(false);
  }

  openSettings(tab: SettingsTab = 'agents'): void {
    this.settingsTab.set(tab);
    this.screen.set('settings');
  }

  /** Opens the big window of a delegated agent; `from` gets the focus back when it closes. */
  openAgentWindow(runId: string, from?: HTMLElement): void {
    this.agentWindowFrom = from ?? null;
    this.agentWindow.set(runId);
  }

  closeAgentWindow(): void {
    this.agentWindow.set(null);
    this.agentWindowFrom?.focus?.();
    this.agentWindowFrom = null;
  }

  openRun(runId: string, view: ConsoleView = 'log'): void {
    this.runs.selectedId.set(runId);
    this.screen.set('chat');
    const run = this.runs.runs().find((r) => r.id === runId);
    if (view === 'compare' && run?.group) {
      this.workspace.open({ kind: 'compare', group: run.group });
      this.sideOpen.set(true);
    } else if (view === 'changes' && run?.task) {
      this.workspace.open({ kind: 'changes', runId });
      this.sideOpen.set(true);
    }
  }
}

function readSidebar(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function writeSidebar(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? 'open' : 'closed');
  } catch {
    /* a convenience */
  }
}
