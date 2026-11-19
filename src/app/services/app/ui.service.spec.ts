import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../../core/backend';
import { MockBackend } from '../../core/mock/mock-backend';
import { SIDEBAR_KEY, UiService } from './ui.service';

function setup(): UiService {
  TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useClass: MockBackend }] });
  return TestBed.inject(UiService);
}

describe('UiService sidebar', () => {
  afterEach(() => localStorage.removeItem(SIDEBAR_KEY));

  it('folds and unfolds on a wide window, and remembers the choice', () => {
    localStorage.removeItem(SIDEBAR_KEY);
    const ui = setup();
    ui.narrow.set(false);
    expect(ui.sidebarCollapsed()).toBe(false);
    ui.toggleSidebar();
    expect(ui.sidebarCollapsed()).toBe(true);
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe('closed');
  });

  it('folds on its own on a narrow window; ⌘B opens it over the chat without changing the saved choice', () => {
    localStorage.removeItem(SIDEBAR_KEY);
    const ui = setup();
    ui.narrow.set(true);
    expect(ui.sidebarCollapsed()).toBe(true);
    ui.toggleSidebar();
    expect(ui.sidebarCollapsed()).toBe(false);
    expect(ui.sidebarPeek()).toBe(true);
    expect(localStorage.getItem(SIDEBAR_KEY)).toBeNull();
    ui.closePeek();
    expect(ui.sidebarCollapsed()).toBe(true);
  });

  it('opens Cài đặt on the asked tab', () => {
    const ui = setup();
    ui.openSettings('prices');
    expect(ui.screen()).toBe('settings');
    expect(ui.settingsTab()).toBe('prices');
  });

  it('folds the file tree in a narrow code panel unless the user asks for it', () => {
    const ui = setup();
    expect(ui.filesShown()).toBe(true);
    ui.sideCompact.set(true);
    expect(ui.filesShown()).toBe(false);
    ui.filesOpen.set(true);
    expect(ui.filesShown()).toBe(true);
  });
});
