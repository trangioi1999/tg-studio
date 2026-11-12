import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../../core/backend';
import { MockBackend } from '../../core/mock/mock-backend';
import { TerminalInfo } from '../../core/protocol';
import { TerminalsService, XTERM, XtermLike } from './terminals.service';

class FakeTerm implements XtermLike {
  cols = 80;
  rows = 24;
  written = '';
  input: ((data: string) => void) | null = null;
  opened: HTMLElement | null = null;
  disposed = false;
  open(el: HTMLElement) { this.opened = el; }
  write(data: string) { this.written += data; }
  onData(cb: (data: string) => void) { this.input = cb; }
  fit() {}
  focus() {}
  dispose() { this.disposed = true; }
}

class Backend extends MockBackend {
  opens: [string, string][] = [];
  closes: string[] = [];
  writes: string[] = [];
  override async terminalOpen(key: string, cwd: string, cols: number, rows: number): Promise<TerminalInfo> {
    this.opens.push([key, cwd]);
    return super.terminalOpen(key, cwd, cols, rows);
  }
  override async terminalClose(id: string) { this.closes.push(id); return super.terminalClose(id); }
  override async terminalWrite(id: string, data: string) { this.writes.push(data); return super.terminalWrite(id, data); }
}

const tick = () => new Promise((r) => setTimeout(r));

function setup() {
  const terms: FakeTerm[] = [];
  const backend = new Backend();
  TestBed.configureTestingModule({
    providers: [
      { provide: AgentBackend, useValue: backend },
      { provide: XTERM, useValue: async () => { const t = new FakeTerm(); terms.push(t); return t; } },
    ],
  });
  return { service: TestBed.inject(TerminalsService), backend, terms };
}

describe('TerminalsService', () => {
  it('opens a conversation shell only when attached, in the given folder', async () => {
    const { service, backend, terms } = setup();
    expect(backend.opens).toEqual([]);
    const host = document.createElement('div');
    await service.attach('t1', '/repo/.tg/worktrees/r1', host);
    await tick();
    expect(backend.opens).toEqual([['t1', '/repo/.tg/worktrees/r1']]);
    expect(host.children.length).toBe(1);
    expect(terms[0].written).toContain('/repo/.tg/worktrees/r1');
    expect(service.state()['t1']).toEqual({ alive: true, shell: 'zsh', cwd: '/repo/.tg/worktrees/r1' });
  });

  it('keeps one shell per conversation across switches, with its output', async () => {
    const { service, backend, terms } = setup();
    const host = document.createElement('div');
    await service.attach('t1', '/a', host);
    terms[0].input!('ls\r');
    await service.attach('t2', '/b', host);
    await service.attach('t1', '/a', host);
    await tick();
    expect(backend.opens.map(([k]) => k)).toEqual(['t1', 't2']);
    expect(terms.length).toBe(2);
    expect(terms[0].written).toContain('(mô phỏng) ls');
    expect(terms[1].written).not.toContain('ls');
    expect(host.children.length).toBe(1);
  });

  it('marks an exited shell and opens a new one on reopen', async () => {
    const { service, backend, terms } = setup();
    const host = document.createElement('div');
    await service.attach('t1', '/a', host);
    terms[0].input!('exit\r');
    await tick();
    expect(service.state()['t1'].alive).toBe(false);
    expect(terms[0].written).toContain('Shell đã thoát');
    await service.reopen('t1', '/b', host);
    await tick();
    expect(backend.opens).toEqual([['t1', '/a'], ['t1', '/b']]);
    expect(service.state()['t1']).toEqual({ alive: true, shell: 'zsh', cwd: '/b' });
  });

  it('closes and forgets the shell of a deleted conversation', async () => {
    const { service, backend, terms } = setup();
    await service.attach('t1', '/a', document.createElement('div'));
    await service.close('t1');
    expect(backend.closes.length).toBe(1);
    expect(terms[0].disposed).toBe(true);
    expect(service.state()['t1']).toBeUndefined();
    await service.close('unknown'); // nothing open: no error
  });
});
