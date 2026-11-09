import { Injectable, inject, signal } from '@angular/core';
import { RunsService } from '../runs/runs.service';
import { WorkspaceService } from '../workspace/workspace.service';

export type Screen = 'chat' | 'mission' | 'usage' | 'integrations' | 'agents';
export type ConsoleView = 'log' | 'changes' | 'editor' | 'compare';

/** Which screen shows and whether the code panel is open, so any screen can open a run. */
@Injectable({ providedIn: 'root' })
export class UiService {
  private readonly runs = inject(RunsService);
  private readonly workspace = inject(WorkspaceService);
  readonly screen = signal<Screen>('chat');
  /** Files and changes beside the chat. Closed until wanted. */
  readonly sideOpen = signal(false);
  /** First-run guide; shown until finished or skipped once. */
  readonly onboarding = signal(!onboarded());

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

function onboarded(): boolean {
  try {
    return localStorage.getItem('tg.onboarded') === '1';
  } catch {
    return true; // without storage, do not nag on every start
  }
}
