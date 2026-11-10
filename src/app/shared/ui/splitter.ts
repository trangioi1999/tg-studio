import { Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { LayoutService, Pane } from '../../services/app/layout';

/**
 * A drag handle that resizes one pane. `target` says which element is the pane: the handle's
 * previous sibling or its parent. `grow` says which way of dragging makes the pane bigger.
 * Double-click restores the default size; arrow keys nudge it.
 */
@Component({
  selector: 'tg-splitter',
  host: {
    class: 'splitter',
    role: 'separator',
    tabindex: '0',
    '[class.x]': "axis() === 'x'",
    '[class.y]': "axis() === 'y'",
    '[class.dragging]': 'dragging()',
    '[attr.aria-orientation]': "axis() === 'x' ? 'vertical' : 'horizontal'",
    '[attr.aria-label]': 'label()',
    '[attr.aria-valuenow]': 'layout.sizes()[pane()] ?? null',
    '[title]': "label() + ' — kéo để đổi cỡ, bấm đúp để về mặc định'",
    '(pointerdown)': 'start($event)',
    '(dblclick)': 'layout.reset(pane())',
    '(keydown)': 'key($event)',
  },
  template: '',
})
export class Splitter {
  protected readonly layout = inject(LayoutService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly pane = input.required<Pane>();
  readonly axis = input<'x' | 'y'>('x');
  readonly target = input<'prev' | 'parent'>('prev');
  /** +1 when dragging right/down grows the pane, -1 when it shrinks it. */
  readonly grow = input<1 | -1>(1);
  protected readonly dragging = signal(false);
  protected readonly label = computed(() => LABELS[this.pane()]);

  private paneEl(): HTMLElement | null {
    const me = this.el.nativeElement;
    return (this.target() === 'parent' ? me.parentElement : me.previousElementSibling) as HTMLElement | null;
  }

  private current(): number {
    const el = this.paneEl();
    if (!el) return this.layout.sizes()[this.pane()] ?? 0;
    const r = el.getBoundingClientRect();
    return this.axis() === 'x' ? r.width : r.height;
  }

  protected start(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const me = this.el.nativeElement;
    const from = this.axis() === 'x' ? e.clientX : e.clientY;
    const size = this.current();
    this.dragging.set(true);
    me.setPointerCapture?.(e.pointerId);
    document.body.classList.add(this.axis() === 'x' ? 'resizing-x' : 'resizing-y');
    const move = (ev: PointerEvent) => {
      const at = this.axis() === 'x' ? ev.clientX : ev.clientY;
      this.layout.set(this.pane(), size + (at - from) * this.grow());
    };
    const end = () => {
      this.dragging.set(false);
      document.body.classList.remove('resizing-x', 'resizing-y');
      me.removeEventListener('pointermove', move);
      me.removeEventListener('pointerup', end);
      me.removeEventListener('pointercancel', end);
    };
    me.addEventListener('pointermove', move);
    me.addEventListener('pointerup', end);
    me.addEventListener('pointercancel', end);
  }

  protected key(e: KeyboardEvent): void {
    const back = this.axis() === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = this.axis() === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    const step = (e.shiftKey ? 48 : 16) * (e.key === fwd ? 1 : -1) * this.grow();
    this.layout.set(this.pane(), this.current() + step);
  }
}

const LABELS: Record<Pane, string> = {
  sidebar: 'Đổi cỡ cột trò chuyện',
  side: 'Đổi cỡ khung code',
  files: 'Đổi cỡ cây tệp',
  term: 'Đổi cỡ khung log',
};
