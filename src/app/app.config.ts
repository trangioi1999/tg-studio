import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { AgentBackend, TauriBackend, isTauri } from './core/backend';
import { MockBackend } from './core/mock/mock-backend';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Real native core inside the desktop app; a fake one in a plain browser.
    { provide: AgentBackend, useFactory: () => (isTauri() ? new TauriBackend() : new MockBackend()) },
  ],
};
