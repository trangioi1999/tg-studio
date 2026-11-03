import { Injectable, computed, inject, signal } from '@angular/core';
import { AgentBackend } from './backend';
import { DetectedAgent } from './protocol';

@Injectable({ providedIn: 'root' })
export class AgentsService {
  private readonly backend = inject(AgentBackend);

  readonly agents = signal<DetectedAgent[]>([]);
  readonly loading = signal(false);
  readonly runnable = computed(() => this.agents().filter((a) => a.path && a.headless));

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      this.agents.set(await this.backend.detectAgents());
    } finally {
      this.loading.set(false);
    }
  }
}
