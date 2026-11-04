import { Component, computed, inject } from '@angular/core';
import { RunsService } from './core/runs.service';
import { UiService } from './core/ui.service';
import { AgentsPanel } from './shell/agents-panel';
import { MissionControl } from './shell/mission-control';
import { RunConsole } from './shell/run-console';
import { StatusBar } from './shell/status-bar';
import { TitleBar } from './shell/title-bar';
import { UsagePanel } from './shell/usage-panel';

@Component({
  selector: 'app-root',
  imports: [TitleBar, AgentsPanel, RunConsole, MissionControl, UsagePanel, StatusBar],
  templateUrl: './app.html',
})
export class App {
  protected readonly ui = inject(UiService);
  private readonly runs = inject(RunsService);
  /** Approval cards open in any run: shown on the Mission control button. */
  protected readonly waiting = computed(() => this.runs.runs().reduce((n, r) => n + r.permissions.length, 0));
}
