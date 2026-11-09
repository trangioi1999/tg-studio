import { fuzzyFiles, fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('matches letters in order, ignoring case', () => {
    expect(fuzzyScore('src/app/core/runs.service.ts', 'rss')).not.toBeNull();
    expect(fuzzyScore('src/app/core/runs.service.ts', 'RUNS')).not.toBeNull();
    expect(fuzzyScore('src/app/core/runs.service.ts', 'zzz')).toBeNull();
    expect(fuzzyScore('abc', 'cba')).toBeNull();
  });

  it('prefers a match in the file name over one spread across folders', () => {
    const name = fuzzyScore('src/app/shell/explorer.ts', 'explorer')!;
    const spread = fuzzyScore('src/e/x/p/l/o/r/e/r/main.ts', 'explorer')!;
    expect(name).toBeGreaterThan(spread);
  });
});

describe('fuzzyFiles', () => {
  const files = ['docs/ui.md', 'src/app/core/ui.service.ts', 'src/app/shell/usage-screen.ts', 'src/styles.scss'];

  it('ranks the closest names first and limits the list', () => {
    expect(fuzzyFiles(files, 'ui.ser')[0]).toBe('src/app/core/ui.service.ts');
    expect(fuzzyFiles(files, 'u', 2)).toHaveLength(2);
  });

  it('lists files in order for an empty query', () => {
    expect(fuzzyFiles(files, '  ', 3)).toEqual(files.slice(0, 3));
  });

  it('matches a path typed with slashes', () => {
    expect(fuzzyFiles(files, 'shell/usage')).toEqual(['src/app/shell/usage-screen.ts']);
  });
});
