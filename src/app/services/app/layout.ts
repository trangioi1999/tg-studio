import { Injectable, computed, signal } from '@angular/core';

/** Panes the user can resize by dragging their edge. */
export type Pane = 'sidebar' | 'side' | 'files' | 'term';

export const LAYOUT_KEY = 'tg.layout';

/** Pixel limits; without a saved size the CSS default applies. */
const LIMITS: Record<Pane, { min: number; max: number; css: string }> = {
  sidebar: { min: 200, max: 420, css: '--w-sidebar' },
  side: { min: 380, max: 1600, css: '--w-side' },
  files: { min: 150, max: 480, css: '--w-files' },
  term: { min: 90, max: 640, css: '--h-term' },
};

export function clampSize(pane: Pane, px: number): number {
  const { min, max } = LIMITS[pane];
  return Math.round(Math.min(max, Math.max(min, px)));
}

/** Sizes of the resizable panes, kept per machine. */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  readonly sizes = signal<Partial<Record<Pane, number>>>(read());
  /** CSS variables for the shell; panes without one use their default. */
  readonly style = computed(() => {
    const out: Record<string, string> = {};
    for (const [pane, px] of Object.entries(this.sizes()) as [Pane, number][]) out[LIMITS[pane].css] = `${px}px`;
    return out;
  });

  set(pane: Pane, px: number): void {
    this.sizes.update((s) => ({ ...s, [pane]: clampSize(pane, px) }));
    write(this.sizes());
  }

  reset(pane: Pane): void {
    this.sizes.update((s) => {
      const { [pane]: _, ...rest } = s;
      return rest;
    });
    write(this.sizes());
  }
}

function read(): Partial<Record<Pane, number>> {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Record<string, unknown>;
    const out: Partial<Record<Pane, number>> = {};
    for (const pane of Object.keys(LIMITS) as Pane[]) {
      const v = raw[pane];
      if (typeof v === 'number' && Number.isFinite(v)) out[pane] = clampSize(pane, v);
    }
    return out;
  } catch {
    return {};
  }
}

function write(sizes: Partial<Record<Pane, number>>): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(sizes));
  } catch {
    /* sizes are a convenience */
  }
}
