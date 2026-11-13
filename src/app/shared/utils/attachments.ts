// Files attached to a message travel as one line `📎 <full path>` each at its end, so the
// message stays plain text in history, recaps and pipelines. The core sends images and
// small text files of those lines to the agent (system/attachments.rs).

export const ATTACH_MARK = '📎 ';
/** Per file; the core refuses more. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export interface Attached { path: string; name: string; image: boolean }

export const isImageName = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);
export const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/** The words of a message and the files attached at its end. */
export function splitAttachments(message: string): { text: string; files: Attached[] } {
  const lines = message.replace(/\s+$/, '').split('\n');
  let cut = lines.length;
  while (cut > 0 && lines[cut - 1].startsWith(ATTACH_MARK)) cut--;
  const files = lines.slice(cut).map((l) => {
    const path = l.slice(ATTACH_MARK.length).trim();
    const name = baseName(path);
    return { path, name, image: isImageName(name) };
  });
  return { text: lines.slice(0, cut).join('\n').replace(/\s+$/, ''), files };
}

export function withAttachments(text: string, paths: string[]): string {
  if (!paths.length) return text;
  const list = paths.map((p) => ATTACH_MARK + p).join('\n');
  return text ? `${text}\n\n${list}` : list;
}

/** For titles and labels: the words, or the attached names when there are none. */
export function withoutAttachments(message: string): string {
  const { text, files } = splitAttachments(message);
  return text || files.map((f) => f.name).join(', ');
}

/** A pasted screenshot has a generic name ("image.png"); give it one that says when. */
export function attachmentName(file: File, now = new Date()): string {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file.name;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const p = (n: number) => String(n).padStart(2, '0');
  return `anh-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}

export function toBase64(bytes: ArrayBuffer): string {
  const all = new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < all.length; i += 0x8000) out += String.fromCharCode(...all.subarray(i, i + 0x8000));
  return btoa(out);
}
