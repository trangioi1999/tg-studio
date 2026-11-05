import { Component, computed, input } from '@angular/core';
import { marked } from 'marked';

/**
 * An agent's message as rendered Markdown. Angular sanitizes the HTML bound to
 * `innerHTML` (no scripts, no handlers). Links never navigate the app's window:
 * a click copies the address instead.
 */
@Component({
  selector: 'tg-markdown',
  host: { class: 'md', '(click)': 'onClick($event)' },
  template: `<div [innerHTML]="html()"></div>`,
})
export class Markdown {
  readonly text = input.required<string>();
  protected readonly html = computed(() => renderMarkdown(this.text()));

  protected onClick(e: MouseEvent): void {
    const link = (e.target as HTMLElement | null)?.closest('a');
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute('href');
    if (href) void navigator.clipboard?.writeText(href).catch(() => {});
  }
}

export function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  } catch {
    return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  }
}
