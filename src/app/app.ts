import { Component, effect, inject, untracked } from '@angular/core';
import { AgentsService } from './services/agents/agents.service';
import { BudgetService } from './services/usage/budget.service';
import { DiagnosticsService } from './services/app/diagnostics.service';
import { RunsService } from './services/runs/runs.service';
import { UiService } from './services/app/ui.service';
import { WorkspaceService } from './services/workspace.service';
import { AgentPanel } from './features/chat/agent-panel';
import { AgentsPanel } from './features/agents/agents-panel';
import { Integrations } from './features/connections/integrations';
import { MissionControl } from './features/monitor/mission-control';
import { Onboarding } from './features/agents/onboarding';
import { SidePanel } from './layout/side-panel';
import { StatusBar } from './layout/status-bar';
import { ThreadList } from './layout/thread-list';
import { TitleBar } from './layout/title-bar';
import { UsageScreen } from './features/usage/usage-screen';
import { Splitter } from './shared/ui/splitter';
import { QuickOpen } from './features/files/quick-open';
import { LayoutService } from './services/app/layout';

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
