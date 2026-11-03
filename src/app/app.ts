import { Component } from '@angular/core';
import { AgentsPanel } from './shell/agents-panel';
import { RunConsole } from './shell/run-console';
import { StatusBar } from './shell/status-bar';
import { TitleBar } from './shell/title-bar';
import { UsagePanel } from './shell/usage-panel';

@Component({
  selector: 'app-root',
  imports: [TitleBar, AgentsPanel, RunConsole, UsagePanel, StatusBar],
  templateUrl: './app.html',
})
export class App {}
