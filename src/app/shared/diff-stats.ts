import { FileDiff } from '../core/protocol';

/** Lines added and removed across files, as the review shows them (+n −m). */
export function diffStats(files: FileDiff[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) for (const h of f.hunks) { added += h.added; removed += h.removed; }
  return { added, removed };
}
