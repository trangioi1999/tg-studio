import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { AgentBackend } from './core/backend';
import { MockBackend } from './core/mock-backend';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: AgentBackend, useClass: MockBackend }],
    }).compileComponents();
  });

  it('renders the shell with the brand', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.brand')?.textContent).toContain('TG Studio');
  });
});
