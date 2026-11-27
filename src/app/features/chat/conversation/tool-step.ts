/** One edited file as a few changed lines: counts, the first `max` +/- rows, and how many more were left out. */
export interface MiniDiff { path: string; added: number; removed: number; lines: { sign: '+' | '-'; text: string }[]; more: number }
export interface ToolHead { name: string; arg: string | null }

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v !== null && typeof v === 'object' ? v as Json : {};
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
const names: Record<string, string> = { execute: 'Bash', read: 'Read', edit: 'Update', delete: 'Delete', move: 'Move', search: 'Search', fetch: 'Fetch', think: 'Think' };

/** The tool's display name (Bash, Read, Update…) and its main argument (command, path, pattern, url), if any. */
export function toolHead(update: Json): ToolHead {
  const raw = obj(update['rawInput']);
  const command = Array.isArray(raw['command']) ? raw['command'].filter(v => typeof v === 'string').join(' ') : raw['command'];
  const locations = update['locations'];
  return {
    name: str(obj(obj(update['_meta'])['claudeCode'])['toolName']) ?? names[String(update['kind'])] ?? str(update['title']) ?? 'Công cụ',
    arg: str(command) ?? str(raw['file_path']) ?? str(raw['path']) ?? str(raw['pattern']) ?? str(raw['url']) ?? (Array.isArray(locations) ? str(obj(locations[0])['path']) : null),
  };
}

/** Shortens a long path to `max` characters with a middle ellipsis, keeping the file name readable. */
export function middleTruncate(path: string, max = 48): string {
  max = Math.max(1, Math.floor(max));
  if (path.length <= max) return path;
  const filename = path.split(/[\\/]/).at(-1)!;
  const tail = Math.min(max - 1, Math.max(filename.length, Math.floor((max - 1) / 2)));
  return path.slice(0, max - tail - 1) + '…' + path.slice(path.length - tail);
}

function content(update: Json): Json[] {
  return Array.isArray(update['content']) ? update['content'].map(obj) : [];
}

/**
 * The one-line result under a tool step: the last non-empty output line, cut to 120 characters.
 * For Read it is the line count instead ("212 dòng"), since a file's last line says nothing.
 */
export function resultLine(update: Json, tool?: string): string | null {
  const texts = content(update).flatMap(c => {
    const block = c['type'] === 'content' ? obj(c['content']) : c;
    return block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : [];
  });
  if (tool === 'Read') {
    const count = split(texts.join('\n')).length;
    return count ? `${count} dòng` : null;
  }
  const last = texts.join('\n').split(/\r?\n/).map(s => s.trim()).filter(Boolean).at(-1);
  return last ? (last.length > 120 ? last.slice(0, 119) + '…' : last) : null;
}

const split = (text: string): string[] => text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

/** LCS rows use linear memory even when an agent sends an entire file. */
function lengths(a: string[], b: string[]): Uint32Array {
  const row = new Uint32Array(b.length + 1);
  for (const text of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const before = row[j];
      row[j] = text === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = before;
    }
  }
  return row;
}

function changes(a: string[], b: string[], emit: (sign: '+' | '-', text: string) => void): void {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  a = a.slice(start); b = b.slice(start);
  while (a.length && b.length && a.at(-1) === b.at(-1)) { a.pop(); b.pop(); }
  if (a.length * b.length > 2_000_000) {
    a.forEach(text => emit('-', text));
    b.forEach(text => emit('+', text));
    return;
  }
  if (!a.length) { b.forEach(text => emit('+', text)); return; }
  if (!b.length) { a.forEach(text => emit('-', text)); return; }
  if (a.length === 1) {
    const match = b.indexOf(a[0]);
    if (match < 0) emit('-', a[0]);
    b.forEach((text, i) => { if (i !== match) emit('+', text); });
    return;
  }
  const mid = Math.floor(a.length / 2);
  const left = lengths(a.slice(0, mid), b);
  const right = lengths(a.slice(mid).reverse(), [...b].reverse());
  let cut = 0;
  for (let i = 1; i <= b.length; i++) {
    if (left[i] + right[b.length - i] > left[cut] + right[b.length - cut]) cut = i;
  }
  changes(a.slice(0, mid), b.slice(0, cut), emit);
  changes(a.slice(mid), b.slice(cut), emit);
}

// Weak keys let cached source text go when its console line is discarded.
const diffSources = new WeakMap<MiniDiff, { path: string; oldText: string; newText: string; max: number }>();

export function miniDiff(update: Json, max = 6, previous?: MiniDiff): MiniDiff | null {
  const diff = content(update).find(c => c['type'] === 'diff' && typeof c['newText'] === 'string');
  if (!diff) return null;
  const source = { path: str(diff['path']) ?? '', oldText: typeof diff['oldText'] === 'string' ? diff['oldText'] : '', newText: diff['newText'] as string, max };
  const cached = previous && diffSources.get(previous);
  if (cached && cached.path === source.path && cached.oldText === source.oldText && cached.newText === source.newText && cached.max === max) return previous!;
  const out: MiniDiff = { path: source.path, added: 0, removed: 0, lines: [], more: 0 };
  changes(split(source.oldText), split(source.newText), (sign, text) => {
    if (sign === '+') out.added++; else out.removed++;
    if (out.lines.length < Math.max(0, Math.floor(max))) out.lines.push({ sign, text }); else out.more++;
  });
  diffSources.set(out, source);
  return out;
}
