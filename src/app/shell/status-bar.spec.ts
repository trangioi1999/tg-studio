import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../core/backend';
import { AgentsService } from '../core/agents.service';
import { MockBackend } from '../core/mock-backend';
import { AccountLimits } from '../core/protocol';
import { StatusBar } from './status-bar';

class FakeBackend extends MockBackend {
  saved: AccountLimits[] = [];
  override async accountLimits() {
    return this.saved;
  }
  claude: AccountLimits | null = null;
  claudeCalls = 0;
  override async refreshClaudeLimits() {
    this.claudeCalls += 1;
    return this.claude;
  }
}

async function render(saved: AccountLimits[], claude: AccountLimits | null = null) {
  const backend = new FakeBackend();
  backend.saved = saved;
  backend.claude = claude;
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  await TestBed.inject(AgentsService).refresh();
  const fixture = TestBed.createComponent(StatusBar);
  await new Promise((resolve) => setTimeout(resolve));
  fixture.detectChanges();
  await fixture.whenStable();
  const bar = (fixture.nativeElement as HTMLElement).querySelector('.statusbar') as HTMLElement;
  return Object.assign(bar, { backend, fixture });
}

describe('StatusBar plan limits', () => {
  it('always shows the 5-hour and weekly windows, whatever run is selected', async () => {
    const future = Date.now() + 3600000;
    const bar = await render([{ agent: 'codex', at: Date.now(), windows: [
      { id: 'five_hour', utilization: 0.99, resetsAt: future, status: null },
      { id: 'seven_day', utilization: 0.32, resetsAt: future, status: null },
    ] }]);
    expect(bar.textContent).toContain('5 giờ 99%');
    expect(bar.textContent).toContain('7 ngày 32%');
    expect(bar.querySelector('[data-level="warn"]')?.textContent).toContain('99%');
  });

  it('says a known source has no number yet, rather than hiding it', async () => {
    const bar = await render([]);
    expect(bar.textContent).toContain('chưa có số');
  });

  it('reads Claude limits without a chat, and again only when asked within 5 minutes', async () => {
    const bar = await render([], { agent: 'claude', at: Date.now(), windows: [
      { id: 'five_hour', utilization: 0.14, resetsAt: Date.now() + 3600000, status: null },
    ] });
    expect(bar.textContent).toContain('5 giờ 14%');
    expect(bar.backend.claudeCalls).toBe(1);
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve));
    expect(bar.backend.claudeCalls).toBe(1);
    (bar.querySelector('button.limit') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve));
    expect(bar.backend.claudeCalls).toBe(2);
  });
});

describe('StatusBar version', () => {
  it('shows the build and its commit, and says when a newer release is out', async () => {
    const bar = await render([]);
    const button = () => bar.querySelector('.version') as HTMLButtonElement;
    expect(button().textContent!.trim()).toBe('v0.5.1 · mock');
    expect(button().title).toContain('Đang dùng bản mới nhất (v0.5.1)');

    bar.backend.latestVersion = async () => ({ latest: '0.6.0', newer: true });
    button().click();
    await new Promise((resolve) => setTimeout(resolve));
    bar.fixture.detectChanges();
    expect(button().textContent).toContain('có v0.6.0');
    expect(button().classList).toContain('newer');
  });

  it('a failed check says why in the tooltip', async () => {
    const bar = await render([]);
    bar.backend.latestVersion = () => Promise.reject(new Error('Không kết nối được GitHub để kiểm tra bản mới.'));
    (bar.querySelector('.version') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve));
    bar.fixture.detectChanges();
    expect((bar.querySelector('.version') as HTMLButtonElement).title).toContain('Không kiểm tra được bản mới: Không kết nối được GitHub');
  });
});
