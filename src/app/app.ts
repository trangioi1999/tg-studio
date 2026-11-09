import { Component, effect, inject, untracked } from '@angular/core';
import { AgentsService } from './agents/agents.service';
import { BudgetService } from './usage/budget.service';
import { DiagnosticsService } from './core/diagnostics.service';
import { RunsService } from './runs/runs.service';
import { UiService } from './shell/ui.service';
import { WorkspaceService } from './workspace/workspace.service';
import { AgentPanel } from './chat/agent-panel';
import { AgentsPanel } from './agents/agents-panel';
import { Integrations } from './integrations/integrations';
import { MissionControl } from './runs/mission-control';
import { Onboarding } from './agents/onboarding';
import { SidePanel } from './shell/side-panel';
import { StatusBar } from './shell/status-bar';
import { ThreadList } from './shell/thread-list';
import { TitleBar } from './shell/title-bar';
import { UsageScreen } from './usage/usage-screen';
import { Splitter } from './shared/splitter';
import { QuickOpen } from './workspace/quick-open';
import { LayoutService } from './shell/layout';

@Component({
  selector: 'app-root',
  imports: [TitleBar, ThreadList, AgentsPanel, SidePanel, AgentPanel, MissionControl, UsageScreen, Integrations, Onboarding, StatusBar, Splitter, QuickOpen],
  templateUrl: './app.html',
})
export class App {
  protected readonly ui = inject(UiService);
  protected readonly layout = inject(LayoutService);

  constructor() {
    // Detect CLIs at startup: the composer needs them whatever screen is open.
    void inject(AgentsService).refresh();
    // Loads prices and budgets, and enforces budgets from the start.
    inject(BudgetService);
    // Starts collecting UI errors for the diagnostics report.
    inject(DiagnosticsService);
    // Show the code panel once per conversation, when its first changes appear. Closing it stays closed.
    const runs = inject(RunsService);
    const workspace = inject(WorkspaceService);
    const shown = new Set<string>();
    effect(() => {
      const run = runs.selected();
      if (!run?.task || !workspace.diffs()[run.id]?.length || shown.has(run.thread)) return;
      shown.add(run.thread);
      untracked(() => this.ui.sideOpen.set(true));
    });
  }
}
