import { Component, computed, inject } from '@angular/core';
import { AgentsService } from './core/agents.service';
import { BudgetService } from './core/budget.service';
import { RunsService } from './core/runs.service';
import { Screen, Sidebar, UiService } from './core/ui.service';
import { AgentPanel } from './shell/agent-panel';
import { AgentsPanel } from './shell/agents-panel';
import { Explorer } from './shell/explorer';
import { Integrations } from './shell/integrations';
import { MissionControl } from './shell/mission-control';
import { StatusBar } from './shell/status-bar';
import { TitleBar } from './shell/title-bar';
import { UsageScreen } from './shell/usage-screen';
import { Workbench } from './shell/workbench';

@Component({
  selector: 'app-root',
  imports: [TitleBar, AgentsPanel, Explorer, Workbench, AgentPanel, MissionControl, UsageScreen, Integrations, StatusBar],
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
    // Loads prices and budgets, and enforces budgets from the start.
    inject(BudgetService);
  }

  protected show(screen: Screen, sidebar: Sidebar): void {
    this.ui.screen.set(screen);
    this.ui.sidebar.set(sidebar);
  }
}
