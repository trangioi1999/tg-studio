import { Component, inject } from '@angular/core';
import { RunsService } from '../core/runs.service';
import { AgentAvatar } from './agent-avatar';

@Component({
  selector: 'tg-title-bar',
  imports: [AgentAvatar],
  template: `
    <header class="titlebar" data-tauri-drag-region [class.mac]="isMac">
      <span class="brand" data-tauri-drag-region>TG Studio</span>
      <span class="crumb" data-tauri-drag-region>Giai đoạn 2 · Nhiều agent</span>
      <div class="presence">
        @for (run of runs.running(); track run.id) {
          <span class="chip"><tg-agent-avatar [agent]="run.agent" [size]="16" /> running</span>
        }
      </div>
    </header>
  `,
})
export class TitleBar {
  protected readonly runs = inject(RunsService);
  protected readonly isMac = navigator.userAgent.includes('Mac');
}
