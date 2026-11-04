import { FileDiff } from './protocol';

/** Where the agent changed a file, in new-file line numbers (1-based). */
export interface LineMarks {
  /** Lines the agent added or rewrote. */
  added: number[];
  /** Lines right after a pure deletion; can be one past the last line. */
  removedBefore: number[];
}

export function lineMarks(file: FileDiff | undefined): LineMarks {
  const marks: LineMarks = { added: [], removedBefore: [] };
  for (const hunk of file?.hunks ?? []) {
    // A hunk that only deletes reports the line before the gap as newStart.
    let line = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    let deleted = false;
    const flush = () => {
      if (deleted) marks.removedBefore.push(line);
      deleted = false;
    };
    for (const text of hunk.lines) {
      if (text.startsWith('+')) {
        marks.added.push(line++);
        deleted = false; // a rewrite, already shown as added
      } else if (text.startsWith('-')) {
        deleted = true;
      } else if (!text.startsWith('\\')) {
        flush();
        line++;
      }
    }
    flush();
  }
  return marks;
}
