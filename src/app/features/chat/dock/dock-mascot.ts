import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { isQuiet, Run, RunStatus, turnStart } from '../../../services/runs/run';
import { Mascot, MascotPose } from '../../../shared/ui/mascot';
import { segmentsOf } from '../conversation/timeline';
import { ChatState } from '../chat.state';

/** How long the cat cheers after a turn it watched finish. */
export const CHEER_MS = 4000;
/** Nothing heard for this long and it falls asleep. */
export const NAP_MS = 5 * 60_000;

export interface MascotState {
  pose: MascotPose;
  /** When the pose changes by itself, if it does. */
  next: number | null;
}

export interface MascotClock {
  now: number;
  lastEvent?: number;
  /** When this screen saw the run go from running to idle/done: only then does it cheer. */
  finishedAt?: number;
}

/** What the cat does for a run: the run's state, plus a little time. */
export function mascotPose(run: Run, t: MascotClock): MascotState {
  if (run.status === 'running') {
    if (run.permissions.length || isQuiet(run, t.lastEvent, t.now)) return { pose: 'thinking', next: null };
    const last = segmentsOf(run.lines, true).at(-1)?.kind;
    return { pose: last === 'work' || last === 'text' || last === 'delegate' ? 'coding' : 'thinking', next: null };
  }
  // A closed session from an earlier app session: asleep until it is woken with a message.
  if (run.restored) return { pose: 'sleep', next: null };
  if (run.status === 'failed') return { pose: 'oops', next: null };
  if (t.finishedAt !== undefined && t.now < t.finishedAt + CHEER_MS) return { pose: 'success', next: t.finishedAt + CHEER_MS };
  const base = Math.max(t.lastEvent ?? 0, t.finishedAt ?? 0, run.endedAt ?? 0, turnStart(run));
  return t.now < base + NAP_MS ? { pose: 'idle', next: base + NAP_MS } : { pose: 'sleep', next: null };
}

/** The cat standing on the dock, acting out what the selected run is doing. Decorative. */
@Component({
  selector: 'tg-dock-mascot',
  imports: [Mascot],
  template: `@if (pose(); as p) { <div class="dock-mascot" [class.away]="away()" aria-hidden="true"><tg-mascot [pose]="p" [size]="56" /></div> }`,
})
export class DockMascot {
  private readonly chat = inject(ChatState);
  /** Faded out while the chat is scrolled up, so it never sits on the text being read. */
  readonly away = input(false);
  /** Ticks only when a pose is due to change (the runs clock stops when nothing runs). */
  private readonly clock = signal(Date.now());
  private readonly finishedAt = signal<Record<string, number>>({});
  private readonly seen = new Map<string, RunStatus>();

  private readonly state = computed(() => {
    const r = this.chat.run();
    if (!r) return null;
    return mascotPose(r, { now: Math.max(this.clock(), this.chat.runs.now()), lastEvent: this.chat.runs.lastEvent()[r.id], finishedAt: this.finishedAt()[r.id] });
  });
  protected readonly pose = computed(() => this.state()?.pose ?? null);

  constructor() {
    effect(() => {
      const r = this.chat.run();
      if (!r) return;
      const before = this.seen.get(r.id);
      this.seen.set(r.id, r.status);
      if (before === 'running' && (r.status === 'idle' || r.status === 'done')) {
        const at = Date.now();
        this.finishedAt.update((m) => ({ ...m, [r.id]: at }));
        this.clock.set(at);
      }
    });
    effect((onCleanup) => {
      const next = this.state()?.next;
      if (next == null) return;
      const timer = setTimeout(() => this.clock.set(Date.now()), Math.max(0, next - Date.now()) + 50);
      onCleanup(() => clearTimeout(timer));
    });
  }
}
