import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { AgentBackend } from '../../core/backend';
import { errorText } from '../../shared/utils/errors';
import { loadXterm } from '../../features/workbench/xterm';

/** What the service needs of xterm.js, so tests can stand in for it. */
export interface XtermLike {
  readonly cols: number;
  readonly rows: number;
  open(el: HTMLElement): void;
  write(data: string): void;
  onData(cb: (data: string) => void): void;
  /** Fits the terminal to its element. */
  fit(): void;
  focus(): void;
  dispose(): void;
}

export const XTERM = new InjectionToken<() => Promise<XtermLike>>('xterm', { providedIn: 'root', factory: () => loadXterm });

export interface TerminalState {
  alive: boolean;
  shell: string;
  cwd: string;
}

interface Session {
  key: string;
  term: XtermLike;
  /** Moved between containers, so a conversation keeps its screen when the user switches. */
  host: HTMLDivElement;
  id: string | null;
}

/** One user shell per conversation, kept while the app runs. */
@Injectable({ providedIn: 'root' })
export class TerminalsService {
  private readonly backend = inject(AgentBackend);
  private readonly load = inject(XTERM);
  private readonly sessions = new Map<string, Session>();
  /** Output that arrived before `terminalOpen` returned the shell's id. */
  private readonly early = new Map<string, string>();
  private listening: Promise<void> | null = null;
  /** Per conversation: absent until its shell is first opened. */
  readonly state = signal<Record<string, TerminalState>>({});

  /** Shows the conversation's terminal in `el`, opening its shell in `cwd` the first time. */
  async attach(key: string, cwd: string, el: HTMLElement): Promise<void> {
    await this.listen();
    let s = this.sessions.get(key);
    if (!s) {
      const term = await this.load();
      const host = document.createElement('div');
      host.className = 'tty-term';
      const session: Session = { key, term, host, id: null };
      term.onData((data) => {
        if (session.id) this.backend.terminalWrite(session.id, data).catch(() => undefined);
      });
      this.sessions.set(key, session);
      el.replaceChildren(host);
      term.open(host);
      s = session;
    } else if (s.host.parentElement !== el) {
      el.replaceChildren(s.host);
    }
    s.term.fit();
    if (!(key in this.state())) await this.start(s, cwd);
    s.term.focus();
  }

  /** A new shell for the conversation in `cwd`, closing the old one if it still runs. */
  async reopen(key: string, cwd: string, el: HTMLElement): Promise<void> {
    const s = this.sessions.get(key);
    if (!s) return this.attach(key, cwd, el);
    if (s.id) {
      const id = s.id;
      s.id = null;
      await this.backend.terminalClose(id).catch(() => undefined);
    }
    s.term.write('\r\n');
    await this.start(s, cwd);
    s.term.focus();
  }

  /** Refits after the panel changed size and tells the shell. */
  resize(key: string): void {
    const s = this.sessions.get(key);
    if (!s) return;
    s.term.fit();
    if (s.id) this.backend.terminalResize(s.id, s.term.cols, s.term.rows).catch(() => undefined);
  }

  /** Ends and forgets the conversation's shell (the conversation was deleted). */
  async close(key: string): Promise<void> {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    if (s.id) await this.backend.terminalClose(s.id).catch(() => undefined);
    s.term.dispose();
    s.host.remove();
    this.state.update(({ [key]: _, ...rest }) => rest);
  }

  private async start(s: Session, cwd: string): Promise<void> {
    try {
      const info = await this.backend.terminalOpen(s.key, cwd, Math.max(s.term.cols, 2), Math.max(s.term.rows, 2));
      s.id = info.id;
      const early = this.early.get(info.id);
      if (early) {
        this.early.delete(info.id);
        s.term.write(early);
      }
      this.state.update((st) => ({ ...st, [s.key]: { alive: true, shell: info.shell, cwd: info.cwd } }));
    } catch (e) {
      s.term.write(`\x1b[31mKhông mở được terminal: ${errorText(e)}\x1b[0m\r\n`);
      this.state.update((st) => ({ ...st, [s.key]: { alive: false, shell: '', cwd } }));
    }
  }

  private byId(id: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.id === id) return s;
    return undefined;
  }

  private listen(): Promise<void> {
    this.listening ??= (async () => {
      await this.backend.onTerminalOutput((id, data) => {
        const s = this.byId(id);
        if (s) s.term.write(data);
        else this.early.set(id, (this.early.get(id) ?? '') + data);
      });
      await this.backend.onTerminalExit((id) => {
        const s = this.byId(id);
        if (!s) return;
        s.id = null;
        s.term.write('\r\n\x1b[2m[Shell đã thoát]\x1b[0m\r\n');
        this.state.update((st) => ({ ...st, [s.key]: { ...st[s.key], alive: false } }));
      });
    })();
    return this.listening;
  }
}
