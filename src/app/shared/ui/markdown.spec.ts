import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { nextReveal } from '../utils/reveal';
import { Markdown, plainText, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders bold, lists and inline code', () => {
    const html = renderMarkdown('Dùng **Angular 21**:\n\n- một\n- `hai`');
    expect(html).toContain('<strong>Angular 21</strong>');
    expect(html).toContain('<li>một</li>');
    expect(html).toContain('<code>hai</code>');
  });

  it('keeps fenced code as a code block', () => {
    expect(renderMarkdown('```ts\nconst a = 1;\n```')).toContain('<pre><code class="language-ts">const a = 1;');
  });

  it('copies as plain text without Markdown marks', () => {
    expect(plainText('Dùng **Angular 21**:\n\n- một\n- `hai`')).toBe('Dùng Angular 21:\n• một\n• hai');
  });
});


describe('Markdown reveal', () => {
  let fixture: ComponentFixture<Markdown>;
  let frames: Map<number, FrameRequestCallback>;
  let now: number;
  let frameId: number;
  const content = () => (fixture.nativeElement.textContent as string).trim();
  const revealing = () => fixture.nativeElement.classList.contains('revealing');

  beforeEach(() => {
    frames = new Map();
    now = 0;
    frameId = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.set(++frameId, cb);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    fixture = TestBed.createComponent(Markdown);
  });

  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function start(text: string, animate = false) {
    fixture.componentRef.setInput('text', text);
    fixture.componentRef.setInput('animate', animate);
    fixture.detectChanges();
  }

  function frame() {
    now += 16;
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(now);
    fixture.detectChanges();
  }

  function finish() {
    for (let i = 0; frames.size && i < 200; i++) frame();
    expect(frames.size).toBe(0);
  }

  it('shows text at once without animate', () => {
    start('Xin chào toàn văn');
    expect(content()).toBe('Xin chào toàn văn');
    expect(frames.size).toBe(0);
  });

  it('reveals over frames with animate', () => {
    start('a'.repeat(300), true);
    frame();
    expect(content().length).toBeGreaterThan(0);
    expect(content().length).toBeLessThan(300);
    expect(revealing()).toBe(true);
    finish();
    expect(content()).toBe('a'.repeat(300));
    expect(revealing()).toBe(false);
  });

  it('keeps revealing after animate turns off', () => {
    const text = 'a'.repeat(300);
    start(text, true);
    frame();
    const previous = content().length;
    fixture.componentRef.setInput('animate', false);
    fixture.detectChanges();
    frame();
    expect(content().length).toBe(nextReveal(previous, text, 16));
    expect(content().length).toBeLessThan(300);
    finish();
    expect(content()).toBe(text);
  });

  it('respects reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    start('a'.repeat(300), true);
    expect(content()).toBe('a'.repeat(300));
    expect(revealing()).toBe(false);
    expect(frames.size).toBe(0);
  });

  it('copy button survives reveal', () => {
    start('```ts\nconst a = 1;\n```', true);
    finish();
    expect(fixture.nativeElement.querySelector('pre .copy-code')).not.toBeNull();
  });

  it('cancels the pending frame on destroy', () => {
    start('a'.repeat(300), true);
    expect(frames.size).toBe(1);
    fixture.destroy();
    expect(frames.size).toBe(0);
  });

  it('continues toward appended text and shows replacements immediately', () => {
    start('a'.repeat(300), true);
    frame();
    fixture.componentRef.setInput('text', 'a'.repeat(600));
    fixture.detectChanges();
    finish();
    expect(content()).toBe('a'.repeat(600));
    fixture.componentRef.setInput('text', 'Tin nhắn thay thế');
    fixture.detectChanges();
    expect(content()).toBe('Tin nhắn thay thế');
    expect(frames.size).toBe(0);
  });
});

describe('Markdown copy button', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says "Đã chép" only when the clipboard took the code', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const fixture = TestBed.createComponent(Markdown);
    fixture.componentRef.setInput('text', '```ts\nconst a = 1;\n```');
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector('.copy-code') as HTMLElement;
    button.click();
    await new Promise((r) => setTimeout(r));
    expect(button.textContent).not.toContain('Đã chép');
    button.click();
    await new Promise((r) => setTimeout(r));
    expect(button.textContent).toContain('Đã chép');
    expect(writeText).toHaveBeenCalledWith('const a = 1;\n');
  });
});
