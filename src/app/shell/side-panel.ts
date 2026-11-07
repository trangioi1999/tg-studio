import { Component } from '@angular/core';
import { Explorer } from './explorer';
import { Splitter } from './splitter';
import { Workbench } from './workbench';

/** The code beside the chat: the project or draft's files, editors and reviews. */
@Component({
  selector: 'tg-side-panel',
  imports: [Explorer, Splitter, Workbench],
  template: `
    <tg-splitter class="split-edge" pane="side" target="parent" [grow]="-1" />
    <tg-explorer class="side-files" />
    <tg-splitter pane="files" />
    <tg-workbench class="side-work" />
  `,
})
export class SidePanel {}
