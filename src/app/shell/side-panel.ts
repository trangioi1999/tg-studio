import { Component } from '@angular/core';
import { Explorer } from './explorer';
import { Workbench } from './workbench';

/** The code beside the chat: the project or draft's files, editors and reviews. */
@Component({
  selector: 'tg-side-panel',
  imports: [Explorer, Workbench],
  template: `
    <tg-explorer class="side-files" />
    <tg-workbench class="side-work" />
  `,
})
export class SidePanel {}
