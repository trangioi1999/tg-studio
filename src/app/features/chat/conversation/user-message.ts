import { Component, computed, inject, input } from '@angular/core';
import { AttachmentsService } from '../../../services/app/attachments.service';
import { splitAttachments } from '../../../shared/utils/attachments';

/** What the user said, with the files attached to it. */
@Component({
  selector: 'tg-user-message',
  host: { class: 'msg-user' },
  template: `@if (parts().text) {<span>{{ parts().text }}</span>}@if (parts().files.length) {<div class="msg-files">@for (f of parts().files; track f.path) {@if (f.image && attachments.preview(f.path)(); as url) {<span class="msg-thumb" [title]="f.path"><img [src]="url" [alt]="f.name" /></span>} @else {<span class="file-chip" [title]="f.path"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>{{ f.name }}</span>}}</div>}`,
})
export class UserMessage {
  readonly text = input.required<string>();
  protected readonly attachments = inject(AttachmentsService);
  protected readonly parts = computed(() => splitAttachments(this.text()));
}
