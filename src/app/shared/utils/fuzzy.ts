/**
 * Score of `query` as a subsequence of `path`, or null when it is not one.
 * Consecutive letters, word starts and letters in the file name score higher, like an editor's Quick Open.
 */
export function fuzzyScore(path: string, query: string): number | null {
  const p = path.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const nameStart = p.lastIndexOf('/') + 1;
  let score = 0;
  let at = -1;
  let streak = 0;
  for (const ch of q) {
    const next = p.indexOf(ch, at + 1);
    if (next < 0) return null;
    streak = next === at + 1 ? streak + 1 : 0;
    const prev = p[next - 1];
    score += 1 + streak * 3;
    if (next === 0 || prev === '/' || prev === '.' || prev === '-' || prev === '_') score += 4;
    if (next >= nameStart) score += 2;
    at = next;
  }
  // Shorter paths win ties.
  return score - path.length / 1000;
}

/** Best matches first; an empty query keeps the given order. */
export function fuzzyFiles(files: readonly string[], query: string, limit = 50): string[] {
  if (!query.trim()) return files.slice(0, limit);
  const scored: [string, number][] = [];
  for (const f of files) {
    const s = fuzzyScore(f, query);
    if (s !== null) scored.push([f, s]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, limit).map(([f]) => f);
}
