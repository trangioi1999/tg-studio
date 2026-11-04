import { Injectable, inject, signal } from '@angular/core';
import { RunsService } from './runs.service';

export type Screen = 'agents' | 'mission';
export type ConsoleView = 'log' | 'changes' | 'editor' | 'compare';

/** Which screen and console view are showing, so any screen can open a run. */
@Injectable({ providedIn: 'root' })
export class UiService {
  private readonly runs = inject(RunsService);
  readonly screen = signal<Screen>('agents');
  readonly view = signal<ConsoleView>('log');

  openRun(runId: string, view: ConsoleView = 'log'): void {
    this.runs.selectedId.set(runId);
    this.view.set(view);
    this.screen.set('agents');
  }
}
