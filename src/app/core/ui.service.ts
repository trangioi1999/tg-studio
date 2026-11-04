import { Injectable, inject, signal } from '@angular/core';
import { RunsService } from './runs.service';
import { WorkspaceService } from './workspace.service';

export type Screen = 'ide' | 'mission' | 'usage' | 'integrations';
export type Sidebar = 'files' | 'agents';
export type ConsoleView = 'log' | 'changes' | 'editor' | 'compare';

/** Which screen and sidebar are showing, so any screen can open a run in the IDE. */
@Injectable({ providedIn: 'root' })
export class UiService {
  private readonly runs = inject(RunsService);
  private readonly workspace = inject(WorkspaceService);
  readonly screen = signal<Screen>('ide');
  readonly sidebar = signal<Sidebar>('files');
  /** First-run guide; shown until finished or skipped once. */
  readonly onboarding = signal(!onboarded());

  openRun(runId: string, view: ConsoleView = 'log'): void {
    this.runs.selectedId.set(runId);
    this.screen.set('ide');
    const run = this.runs.runs().find((r) => r.id === runId);
    if (view === 'compare' && run?.group) this.workspace.open({ kind: 'compare', group: run.group });
    else if (view === 'changes' && run?.task) this.workspace.open({ kind: 'changes', runId });
  }
}

function onboarded(): boolean {
  try {
    return localStorage.getItem('tg.onboarded') === '1';
  } catch {
    return true; // without storage, do not nag on every start
  }
}
