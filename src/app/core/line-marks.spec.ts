import { describe, expect, it } from 'vitest';
import { lineMarks } from './line-marks';
import { FileDiff, Hunk } from './protocol';

const hunk = (newStart: number, newLines: number, lines: string[]): Hunk => ({
  id: 'h', header: '', oldStart: newStart, oldLines: 0, newStart, newLines, lines, added: 0, removed: 0,
});
const file = (...hunks: Hunk[]): FileDiff => ({ path: 'a.ts', status: 'M', binary: false, patchHeader: '', hunks });

describe('lineMarks', () => {
  it('numbers added lines from newStart and skips removed ones', () => {
    const marks = lineMarks(file(hunk(10, 4, [' a', '-b', '+c', '+d', ' e'])));
    expect(marks).toEqual({ added: [11, 12], removedBefore: [] });
  });

  it('marks the line after a pure deletion', () => {
    const marks = lineMarks(file(hunk(5, 2, [' a', '-b', '-c', ' d'])));
    expect(marks).toEqual({ added: [], removedBefore: [6] });
  });

  it('handles deletion-only hunks, trailing deletions and no-newline markers', () => {
    expect(lineMarks(file(hunk(3, 0, ['-x']))).removedBefore).toEqual([4]);
    expect(lineMarks(file(hunk(1, 1, [' a', '-b']))).removedBefore).toEqual([2]);
    expect(lineMarks(file(hunk(1, 2, [' a', '+b', '\\ No newline at end of file']))).added).toEqual([2]);
  });

  it('covers several hunks and new files', () => {
    const marks = lineMarks(file(hunk(1, 2, ['+x', '+y']), hunk(20, 2, [' a', '+b'])));
    expect(marks.added).toEqual([1, 2, 21]);
    expect(lineMarks(undefined)).toEqual({ added: [], removedBefore: [] });
  });
});
