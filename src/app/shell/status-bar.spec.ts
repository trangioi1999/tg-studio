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
}

async function render(saved: AccountLimits[]) {
  const backend = new FakeBackend();
  backend.saved = saved;
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  await TestBed.inject(AgentsService).refresh();
  const fixture = TestBed.createComponent(StatusBar);
  await new Promise((resolve) => setTimeout(resolve));
  fixture.detectChanges();
  await fixture.whenStable();
  return (fixture.nativeElement as HTMLElement).querySelector('.statusbar') as HTMLElement;
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
});
