import { Component } from '@angular/core';
import { Explorer } from '../features/files/explorer';
import { Splitter } from '../shared/ui/splitter';
import { Workbench } from '../features/workbench/workbench';

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
