import { Component, DestroyRef, ElementRef, afterRenderEffect, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { marked } from 'marked';
import { nextReveal } from './reveal';
import { copyText } from './clipboard';

/**
 * An agent's message as rendered Markdown. Angular sanitizes the HTML bound to
 * `innerHTML` (no scripts, no handlers). Links never navigate the app's window:
 * a click copies the address instead. Each code block gets its own copy button.
 */
@Component({
  selector: 'tg-markdown',
  host: { class: 'md', '(click)': 'onClick($event)', '[class.revealing]': 'shown().length < text().length' },
  template: `<div [innerHTML]="html()"></div>`,
})
export class Markdown {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly text = input.required<string>();
  readonly animate = input(false);
  protected readonly shown = signal('');
  protected readonly html = computed(() => renderMarkdown(this.shown()));
  private frame: number | null = null;
  private lastFrameTime = 0;

  constructor() {
    effect(() => {
      const text = this.text();
      const animate = this.animate();
      const shown = untracked(this.shown);
      if (!text.startsWith(shown) || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        this.cancelFrame();
        this.shown.set(text);
      } else if (this.frame !== null || animate) {
        if (shown !== text && this.frame === null) {
          this.lastFrameTime = performance.now();
          this.frame = requestAnimationFrame(this.revealFrame);
        }
      } else {
        this.shown.set(text);
      }
    });
    inject(DestroyRef).onDestroy(() => this.cancelFrame());

    // The sanitizer drops buttons from bound HTML, so they are added to the DOM afterwards.
    afterRenderEffect(() => {
      this.html();
      for (const pre of Array.from(this.host.nativeElement.querySelectorAll('pre'))) {
        if (pre.querySelector('.copy-code')) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'copy-code';
        button.textContent = 'Chép';
        button.setAttribute('aria-label', 'Chép đoạn code');
        pre.prepend(button);
      }
    });
  }

  private readonly revealFrame = (now: number): void => {
    this.frame = null;
    const text = this.text();
    const next = nextReveal(this.shown().length, text, now - this.lastFrameTime);
    this.lastFrameTime = now;
    this.shown.set(text.slice(0, next));
    if (next < text.length) this.frame = requestAnimationFrame(this.revealFrame);
  };

  private cancelFrame(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  protected onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    const copy = target?.closest('.copy-code');
    if (copy) {
      const code = copy.parentElement?.querySelector('code')?.textContent ?? '';
      void copyText(code).then((ok) => ok && flash(copy as HTMLElement));
      return;
    }
    const link = target?.closest('a');
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute('href');
    if (href) void copyText(href);
  }
}

export function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  } catch {
    return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  }
}

/** The text a reader sees, without Markdown marks. */
export function plainText(markdown: string): string {
  const doc = new DOMParser().parseFromString(renderMarkdown(markdown), 'text/html');
  doc.querySelectorAll('li').forEach((li) => li.prepend('• '));
  doc.querySelectorAll('p, li, pre, h1, h2, h3, h4, tr, blockquote').forEach((el) => el.append('\n'));
  return (doc.body.textContent ?? '').replace(/\n\s*\n+/g, '\n').trim();
}

function flash(button: HTMLElement): void {
  button.textContent = 'Đã chép ✓';
  button.classList.add('done');
  setTimeout(() => {
    button.textContent = 'Chép';
    button.classList.remove('done');
  }, 1500);
}
