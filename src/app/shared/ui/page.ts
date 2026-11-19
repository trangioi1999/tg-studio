import { Component, input } from '@angular/core';

/**
 * The frame of every screen beyond the chat: one H1, one line on what the screen is for,
 * actions on the right (`[pageActions]`), then the content at one width.
 */
@Component({
  selector: 'tg-page',
  template: `
    <div class="page">
      <header class="pg-head">
        <div class="pg-title">
          <h1>{{ title() }}</h1>
          @if (lead()) { <p>{{ lead() }}</p> }
        </div>
        <ng-content select="[pageMeta]" />
        <div class="pg-actions"><ng-content select="[pageActions]" /></div>
      </header>
      <ng-content />
    </div>
  `,
})
export class Page {
  readonly title = input.required<string>();
  readonly lead = input<string>('');
}
