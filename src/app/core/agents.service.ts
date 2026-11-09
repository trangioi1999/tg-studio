import { Injectable, computed, inject, signal } from '@angular/core';
import { AgentBackend } from './backend';
import { AgentCommand, AgentId, AgentOptions, DetectedAgent, SessionPrefs } from './protocol';
import { errorText } from '../shared/errors';

const PREFS_KEY = 'tg.prefs';

function loadPrefs(): Partial<Record<AgentId, SessionPrefs>> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

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

function commandsKey(agent: AgentId, cwd: string | null): string {
  return `${agent}|${cwd ?? ''}`;
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
  /** Model and effort choices, read from each agent once per app session. */
  readonly options = signal<Partial<Record<AgentId, AgentOptions | 'loading' | 'error'>>>({});
  /** What the user picked per agent, remembered across sessions. */
  readonly prefs = signal<Partial<Record<AgentId, SessionPrefs>>>(loadPrefs());
  /** Why reading an agent's choices failed, word for word, so the user can report it. */
  readonly optionsError = signal<Partial<Record<AgentId, string>>>({});

  /**
   * Skills and commands each agent offers, per project folder: read once by opening a session
   * without a prompt, then kept current by the `commands` events of live sessions.
   */
  readonly commands = signal<Record<string, AgentCommand[] | 'loading'>>({});

  commandsFor(agent: AgentId | '', cwd: string | null): AgentCommand[] | 'loading' | null {
    return agent ? (this.commands()[commandsKey(agent, cwd)] ?? null) : null;
  }

  /** Asks the agent once per folder; a failure leaves the list empty until asked again. */
  async loadCommands(agent: AgentId, cwd: string | null): Promise<void> {
    const key = commandsKey(agent, cwd);
    if (this.commands()[key]) return;
    this.commands.update((c) => ({ ...c, [key]: 'loading' }));
    try {
      const found = await this.backend.agentCommands(agent, cwd || null);
      // A live session may have reported meanwhile; it is at least as fresh.
      this.commands.update((c) => (c[key] === 'loading' ? { ...c, [key]: found } : c));
    } catch (e) {
      console.warn('Không đọc được skill của agent', e);
      this.commands.update((c) => {
        const { [key]: _, ...rest } = c;
        return rest;
      });
    }
  }

  setCommands(agent: AgentId, cwd: string | null, list: AgentCommand[]): void {
    this.commands.update((c) => ({ ...c, [commandsKey(agent, cwd)]: list }));
  }

  prefsFor(agent: AgentId): SessionPrefs | null {
    const p = this.prefs()[agent];
    return p && (p.model || p.effort) ? p : null;
  }

  setPref(agent: AgentId, change: Partial<SessionPrefs>): void {
    this.prefs.update((all) => ({ ...all, [agent]: { model: null, effort: null, ...all[agent], ...change } }));
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs()));
    } catch {
      /* remembered for this session only */
    }
  }

  /** Asks the agent once; a failure can be retried by calling again. */
  async loadOptions(agent: AgentId, cwd: string | null): Promise<void> {
    const now = this.options()[agent];
    if (now === 'loading' || (now && now !== 'error')) return;
    this.options.update((o) => ({ ...o, [agent]: 'loading' }));
    try {
      const found = await this.backend.agentOptions(agent, cwd || null);
      this.options.update((o) => ({ ...o, [agent]: found }));
    } catch (e) {
      console.warn('Không đọc được model của agent', e);
      this.optionsError.update((m) => ({ ...m, [agent]: errorText(e) }));
      this.options.update((o) => ({ ...o, [agent]: 'error' }));
    }
  }

  /** Short label of the picked model, e.g. "Opus 4.6"; null when on the default. */
  modelLabel(agent: AgentId): string | null {
    const value = this.prefs()[agent]?.model;
    if (!value || value === 'default') return null;
    const opts = this.options()[agent];
    const found = opts && typeof opts === 'object' ? opts.model?.options.find((o) => o.value === value) : null;
    return found?.name ?? value;
  }

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
