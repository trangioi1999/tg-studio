import { Injectable, computed, inject, signal } from '@angular/core';
import { AgentBackend } from './backend';
import { DetectedAgent } from './protocol';

/** What the last detection found, to show at once on the next start. */
function parseCache(raw: string | null): DetectedAgent[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as DetectedAgent[];
    if (!Array.isArray(list) || !list.every((a) => a && typeof a.id === 'string')) return [];
    return list.map((a) => ({ ...a, auth: a.auth ?? 'unknown' }));
  } catch {
    return [];
  }
}

@Injectable({ providedIn: 'root' })
export class AgentsService {
  private readonly backend = inject(AgentBackend);
  private cacheRead = false;

  readonly agents = signal<DetectedAgent[]>([]);
  /** Detection is running and there is nothing to show yet. */
  readonly loading = signal(false);
  /** Detection is running, behind what is already shown. */
  readonly checking = signal(false);
  readonly runnable = computed(() => this.agents().filter((a) => a.path && a.headless));

  async refresh(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    await this.showCache();
    this.loading.set(!this.agents().length);
    try {
      const found = await this.backend.detectAgents();
      this.agents.set(found);
      await this.backend.setSetting('agents', JSON.stringify(found)).catch(() => {});
    } finally {
      this.loading.set(false);
      this.checking.set(false);
    }
  }

  private async showCache(): Promise<void> {
    if (this.cacheRead) return;
    this.cacheRead = true;
    const cached = parseCache(await this.backend.getSetting('agents').catch(() => null));
    if (cached.length && !this.agents().length) this.agents.set(cached);
  }
}
