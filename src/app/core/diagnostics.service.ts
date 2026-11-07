import { Injectable, inject, signal } from '@angular/core';
import { AgentBackend } from './backend';

const MAX_ERRORS = 50;

/**
 * Keeps the UI's recent errors and saves them with the core's report into one JSON
 * file in Downloads. Nothing is sent anywhere; reporting a bug means sending the file.
 */
@Injectable({ providedIn: 'root' })
export class DiagnosticsService {
  private readonly backend = inject(AgentBackend);
  private readonly errors: { at: number; message: string }[] = [];
  readonly saved = signal<string | null>(null);
  readonly failed = signal<string | null>(null);

  constructor() {
    if (typeof window === 'undefined') return;
    // The browser reports a ResizeObserver that could not deliver every notice in one frame as an
    // error. Monaco's automatic layout does this while a pane is dragged; it is harmless, so stop it
    // before Angular's global listener logs it and keep it out of the report.
    window.addEventListener('error', (e) => {
      if (isResizeNoise(e.message)) e.stopImmediatePropagation();
    }, { capture: true });
    window.addEventListener('error', (e) => this.record(e.message || String(e.error)));
    window.addEventListener('unhandledrejection', (e) => this.record(e.reason instanceof Error ? e.reason.message : String(e.reason)));
  }

  record(message: string): void {
    if (isResizeNoise(message)) return;
    this.errors.push({ at: Date.now(), message: message.slice(0, 500) });
    if (this.errors.length > MAX_ERRORS) this.errors.shift();
  }

  async export(): Promise<string | null> {
    this.failed.set(null);
    try {
      const report = await this.backend.diagnostics();
      const full = { ...report, ui: { mode: this.backend.mode, userAgent: navigator.userAgent, errors: [...this.errors] } };
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const path = await this.backend.saveExport(`tg-studio-chan-doan-${stamp}.json`, JSON.stringify(full, null, 2));
      this.saved.set(path);
      return path;
    } catch (e) {
      this.failed.set(e instanceof Error ? e.message : String(e));
      return null;
    }
  }
}

export function isResizeNoise(message: string | undefined): boolean {
  return !!message && message.startsWith('ResizeObserver loop');
}
