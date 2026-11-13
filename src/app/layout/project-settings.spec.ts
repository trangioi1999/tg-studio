import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../core/backend';
import { MockBackend } from '../core/mock/mock-backend';
import { ProjectSettings } from '../core/protocol';
import { ProjectSettingsForm } from './project-settings';

class Backend extends MockBackend {
  saved: [string, ProjectSettings][] = [];
  override async projectSettings() { return { setup: 'npm ci', check: 'npm test', autoFix: true, maxFixRounds: 2 }; }
  override async setProjectSettings(root: string, s: ProjectSettings) { this.saved.push([root, s]); }
}

async function setup() {
  const backend = new Backend();
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
  const fixture = TestBed.createComponent(ProjectSettingsForm);
  fixture.componentRef.setInput('root', '/repo');
  const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r)); fixture.detectChanges(); } };
  fixture.detectChanges();
  await settle();
  return { backend, el: fixture.nativeElement as HTMLElement, settle };
}

describe('ProjectSettingsForm', () => {
  it('shows the saved settings of the project', async () => {
    const { el } = await setup();
    expect(el.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('npm ci');
    expect(el.querySelector<HTMLInputElement>('input.mono')!.value).toBe('npm test');
  });

  it('saves the edited settings with the rounds kept within 1–5', async () => {
    const { backend, el, settle } = await setup();
    const check = el.querySelector<HTMLInputElement>('input.mono')!;
    check.value = 'npm run lint && npm test';
    check.dispatchEvent(new Event('input'));
    const rounds = el.querySelector<HTMLInputElement>('.hk-rounds')!;
    rounds.value = '9';
    rounds.dispatchEvent(new Event('input'));
    el.querySelector<HTMLButtonElement>('.hk-save')!.click();
    await settle();
    expect(backend.saved).toEqual([['/repo', { setup: 'npm ci', check: 'npm run lint && npm test', autoFix: true, maxFixRounds: 5 }]]);
    expect(el.textContent).toContain('Đã lưu');
  });
});
