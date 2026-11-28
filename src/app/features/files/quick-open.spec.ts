import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../../core/backend';
import { MockBackend } from '../../core/mock/mock-backend';
import { UiService } from '../../services/app/ui.service';
import { QuickOpen } from './quick-open';

describe('QuickOpen', () => {
  const press = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, ctrlKey: true }));

  it('does not open behind the agent window', () => {
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: new MockBackend() }] });
    const fixture = TestBed.createComponent(QuickOpen);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    TestBed.inject(UiService).agentWindow.set('c');
    press();
    fixture.detectChanges();
    expect(el.querySelector('.qo')).toBeNull();
    TestBed.inject(UiService).agentWindow.set(null);
    press();
    fixture.detectChanges();
    expect(el.querySelector('.qo')).not.toBeNull();
  });
});
