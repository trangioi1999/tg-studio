import { Component, computed, inject } from '@angular/core';
import { AgentsService } from './core/agents.service';
import { RunsService } from './core/runs.service';
import { Screen, Sidebar, UiService } from './core/ui.service';
import { AgentPanel } from './shell/agent-panel';
import { AgentsPanel } from './shell/agents-panel';
import { Explorer } from './shell/explorer';
import { MissionControl } from './shell/mission-control';
import { StatusBar } from './shell/status-bar';
import { TitleBar } from './shell/title-bar';
import { UsagePanel } from './shell/usage-panel';
import { Workbench } from './shell/workbench';

@Component({
  selector: 'app-root',
  imports: [TitleBar, AgentsPanel, Explorer, Workbench, AgentPanel, MissionControl, UsagePanel, StatusBar],
  templateUrl: './app.html',
})
export class App {
  protected readonly ui = inject(UiService);
  private readonly runs = inject(RunsService);
  /** Approval cards open in any run: shown on the Mission control button. */
  protected readonly waiting = computed(() => this.runs.runs().reduce((n, r) => n + r.permissions.length, 0));

  constructor() {
    // Detect CLIs at startup: the composer needs them whichever sidebar is open.
    void inject(AgentsService).refresh();
  }

  protected show(screen: Screen, sidebar: Sidebar): void {
    this.ui.screen.set(screen);
    this.ui.sidebar.set(sidebar);
  }
}
