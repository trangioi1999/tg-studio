import { FileDiff } from '../core/protocol';
import { diffStats } from './diff-stats';

const file = (hunks: [number, number][]): FileDiff => ({
  path: 'a', status: 'M', binary: false, patchHeader: '',
  hunks: hunks.map(([added, removed], i) => ({ id: `${i}`, header: '', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [], added, removed })),
});

describe('diffStats', () => {
  it('adds up every hunk of every file', () => {
    expect(diffStats([file([[2, 1], [3, 0]]), file([[0, 4]])])).toEqual({ added: 5, removed: 5 });
    expect(diffStats([])).toEqual({ added: 0, removed: 0 });
  });
});
