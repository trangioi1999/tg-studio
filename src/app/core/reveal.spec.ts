import { nextReveal } from './reveal';

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

  it('catches up with a backlog', () => {
    const text = 'a'.repeat(2000);
    let shown = 0;
    for (let frame = 0; frame < 16; frame++) shown = nextReveal(shown, text, 16);
    expect(shown).toBeGreaterThan(1000);
  });

  it('finishes a huge message fast', () => {
    const text = 'a'.repeat(50_000);
    let shown = 0;
    for (let frame = 0; frame < 100 && shown < text.length; frame++) {
      shown = nextReveal(shown, text, 16);
    }
    expect(shown).toBe(text.length);
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
