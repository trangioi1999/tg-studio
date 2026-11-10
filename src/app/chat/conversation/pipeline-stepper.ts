import { Component, inject } from '@angular/core';
import { AgentAvatar } from '../../shared/agent-avatar';
import { ChatState } from '../chat.state';

/** Where a pipeline is: each step's agent, done, running or still to come. */
@Component({
  selector: 'tg-pipeline-stepper',
  imports: [AgentAvatar],
  template: `
@if (chat.pipelineOf(); as po) {
  <ol class="stepper" aria-label="Các bước">
    @for (s of po.pipeline.steps; track $index; let i = $index) {
      <li [attr.data-state]="stepState(po.pipeline, i)" [class.current]="i === po.step">
        <button [disabled]="!po.pipeline.runIds[i]" (click)="chat.runs.selectedId.set(po.pipeline.runIds[i]!)">
          <span class="stepper-bar"></span>
          <tg-agent-avatar [agent]="s.agent" [size]="16" />
          <span class="stepper-name ellipsis">{{ s.name }}</span>
        </button>
      </li>
    }
  </ol>
  @if (po.pipeline.error) { <p class="error-text">{{ po.pipeline.error }}</p> }
}
  `,
})
export class PipelineStepper {
  protected readonly chat = inject(ChatState);
  protected stepState(p: { runIds: (string | null)[]; current: number; status: string }, i: number): string {
    const id = p.runIds[i];
    const run = id ? this.chat.runs.runs().find((r) => r.id === id) : null;
    if (!run) return i < p.current ? 'done' : 'pending';
    return run.status === 'running' ? 'running' : run.status === 'done' ? 'done' : 'failed';
  }
}
