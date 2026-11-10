import { TestBed } from '@angular/core/testing';
import { LAYOUT_KEY, LayoutService, clampSize } from './layout';

describe('clampSize', () => {
  it('keeps each pane within its limits', () => {
    expect(clampSize('sidebar', 50)).toBe(200);
    expect(clampSize('sidebar', 9999)).toBe(420);
    expect(clampSize('files', 300.6)).toBe(301);
  });
});

describe('LayoutService', () => {
  afterEach(() => localStorage.removeItem(LAYOUT_KEY));

  it('has no sizes until the user drags, so the CSS defaults apply', () => {
    localStorage.removeItem(LAYOUT_KEY);
    const layout = TestBed.inject(LayoutService);
    expect(layout.sizes()).toEqual({});
    expect(layout.style()).toEqual({});
  });

  it('clamps, remembers and resets a size', () => {
    localStorage.removeItem(LAYOUT_KEY);
    const layout = TestBed.inject(LayoutService);
    layout.set('term', 5);
    expect(layout.sizes().term).toBe(90);
    expect(layout.style()).toEqual({ '--h-term': '90px' });
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual({ term: 90 });
    layout.reset('term');
    expect(layout.sizes()).toEqual({});
  });

  it('restores saved sizes and drops junk', () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ side: 700, files: 'wide', nope: 3 }));
    const layout = TestBed.inject(LayoutService);
    expect(layout.sizes()).toEqual({ side: 700 });
  });
});
