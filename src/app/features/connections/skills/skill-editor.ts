import { Component, inject, ElementRef, ViewChild } from '@angular/core';
import { IntegrationsState } from '../integrations.state';

/** The drawer that writes a SKILL.md into the library. */
@Component({
  selector: 'tg-skill-editor',
  imports: [],
  template: `
@if (conn.skillDraft() !== null) {
  <div class="sheet-backdrop" (click)="conn.closeDrawer()">
    <form
      class="sheet conn-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conn-skill-title"
      (click)="$event.stopPropagation()"
      (keydown)="conn.trapFocus($event)"
      (submit)="$event.preventDefault(); conn.saveSkill()"
    >
      <div class="sheet-head">
        <h3 id="conn-skill-title">Chỉnh sửa skill</h3>
        <span class="spacer"></span
        ><button
          type="button"
          class="icon-btn"
          aria-label="Đóng ngăn kéo"
          (click)="conn.closeDrawer()"
        >
          ×
        </button>
      </div>
      <label class="field conn-skill-editor"
        >SKILL.md<textarea
          #drawerFocus
          class="mono"
          rows="20"
          [value]="conn.skillDraft()"
          (input)="conn.skillDraft.set($any($event.target).value)"
        ></textarea>
      </label>
      <div class="sheet-foot">
        <span class="spacer"></span
        ><button class="btn" type="button" (click)="conn.closeDrawer()">Huỷ</button
        ><button class="btn primary" type="submit" [disabled]="conn.busy()">Lưu skill</button>
      </div>
    </form>
  </div>
}
  `,
})
export class SkillEditor {
  protected readonly conn = inject(IntegrationsState);
  /** The drawer takes the focus when it opens. */
  @ViewChild('drawerFocus') set drawerFocus(element: ElementRef<HTMLElement> | undefined) {
    if (element) element.nativeElement.focus();
  }
}
