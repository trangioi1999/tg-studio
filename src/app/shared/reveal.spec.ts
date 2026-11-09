import { REVEAL_MAX_MS, nextReveal } from './reveal';

/** Characters shown after `ms` of 60 fps frames. */
function after(text: string, ms: number): number {
  let shown = 0;
  for (let t = 0; t < ms && shown < text.length; t += 16) shown = nextReveal(shown, text, 16);
  return shown;
}

describe('nextReveal', () => {
  it('advances at least one char per frame', () => {
    expect(nextReveal(0, 'abc', 1)).toBeGreaterThanOrEqual(1);
  });

  it('never passes the end', () => {
    expect(nextReveal(2, 'abc', 1000)).toBe(3);
  });

  it('jumps when text shrank', () => {
    expect(nextReveal(10, 'abc', 16)).toBe(3);
  });

  it('types a short reply out instead of flashing it', () => {
    const text = 'a'.repeat(300);
    expect(after(text, 500)).toBeLessThan(200);
    expect(after(text, REVEAL_MAX_MS + 16)).toBe(300);
  });

  it('catches up with a backlog within about a second, not at once', () => {
    const text = 'a'.repeat(2000);
    expect(after(text, 250)).toBeLessThan(1000);
    expect(after(text, 1000)).toBeGreaterThan(1000);
  });

  it('finishes a huge message within the cap', () => {
    const text = 'a'.repeat(50_000);
    expect(after(text, REVEAL_MAX_MS + 16)).toBe(text.length);
  });

  it('never splits a surrogate pair', () => {
    const text = 'a😀b';
    let shown = 0;
    for (let frame = 0; frame < 10 && shown < text.length; frame++) {
      shown = nextReveal(shown, text, 1);
      expect(shown).not.toBe(2);
    }
    expect(shown).toBe(text.length);
  });
});
