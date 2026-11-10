import { Component, ElementRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { fuzzyFiles } from '../../shared/utils/fuzzy';
import { KEYS } from '../../shared/utils/keys';
import { UiService } from '../../services/app/ui.service';
import { WorkspaceService } from '../../services/workspace.service';
import { FileIcon } from '../../shared/ui/file-icon';

/** ⌘P / Ctrl+P: find a file of the open project by typing part of its name. */
@Component({
  selector: 'tg-quick-open',
  imports: [FileIcon],
  template: `
    @if (open()) {
      <div class="qo-backdrop" (pointerdown)="close()"></div>
      <div class="qo" role="dialog" aria-label="Mở nhanh tệp">
        <input #input class="qo-input" [value]="query()" (input)="query.set(input.value); index.set(0)" (keydown)="key($event)"
          placeholder="Gõ tên tệp để mở…" aria-label="Tên tệp" aria-controls="qo-list" spellcheck="false" autocomplete="off" />
        <div id="qo-list" class="qo-list" role="listbox" aria-label="Tệp khớp">
          @for (path of results(); track path; let i = $index) {
            <button class="qo-row" role="option" [class.active]="i === index()" [attr.aria-selected]="i === index()"
              (pointermove)="index.set(i)" (click)="choose(path)">
              <tg-file-icon [name]="path" />
              <span class="qo-name">{{ nameOf(path) }}</span>
              <span class="qo-dir dim ellipsis">{{ dirOf(path) }}</span>
            </button>
          } @empty {
            <p class="dim pad">{{ workspace.folder() ? 'Không có tệp nào khớp.' : 'Mở một thư mục dự án trước.' }}</p>
          }
        </div>
        <div class="qo-foot dim"><span>↑↓ chọn</span><span>↵ mở</span><span>Esc đóng</span><span class="spacer"></span><span>{{ keys.quickOpen }}</span></div>
      </div>
    }
  `,
})
export class QuickOpen {
  protected readonly workspace = inject(WorkspaceService);
  private readonly ui = inject(UiService);
  protected readonly keys = KEYS;
  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly index = signal(0);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');
  protected readonly results = computed(() => (this.open() ? fuzzyFiles(this.workspace.projectFiles(), this.query(), 60) : []));

  @HostListener('window:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      if (this.open()) this.close();
      else this.show();
    }
  }

  private show(): void {
    this.query.set('');
    this.index.set(0);
    this.open.set(true);
    queueMicrotask(() => setTimeout(() => this.input()?.nativeElement.focus()));
  }

  protected close(): void {
    this.open.set(false);
  }

  protected key(e: KeyboardEvent): void {
    const n = this.results().length;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === 'ArrowDown' && n) {
      e.preventDefault();
      this.index.set((this.index() + 1) % n);
      this.scrollActive();
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault();
      this.index.set((this.index() - 1 + n) % n);
      this.scrollActive();
    } else if (e.key === 'Enter' && n) {
      e.preventDefault();
      this.choose(this.results()[Math.min(this.index(), n - 1)]);
    }
  }

  private scrollActive(): void {
    queueMicrotask(() => document.querySelector('.qo-row.active')?.scrollIntoView({ block: 'nearest' }));
  }

  protected choose(path: string): void {
    this.close();
    this.ui.screen.set('chat');
    this.ui.sideOpen.set(true);
    this.workspace.openSource(path);
  }

  protected nameOf(path: string): string {
    return path.split('/').pop() ?? path;
  }

  protected dirOf(path: string): string {
    return path.split('/').slice(0, -1).join('/');
  }
}
