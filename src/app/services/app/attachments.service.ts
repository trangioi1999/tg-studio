import { Injectable, inject, signal } from '@angular/core';
import { AgentBackend } from '../../core/backend';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, attachmentName, isImageName, toBase64, withAttachments } from '../../shared/utils/attachments';

/** A file picked for the next message, not saved yet. */
export interface DraftAttachment { id: number; name: string; size: number; image: boolean; data: string; url: string | null }

/** Previews of attached images, read once from the core and kept for the session. */
@Injectable({ providedIn: 'root' })
export class AttachmentsService {
  private readonly backend = inject(AgentBackend);
  private readonly urls = new Map<string, ReturnType<typeof signal<string | null>>>();
  private nextId = 1;

  /** The image as a data URL, or null while it loads or when it is gone. */
  preview(path: string) {
    let url = this.urls.get(path);
    if (!url) {
      url = signal<string | null>(null);
      this.urls.set(path, url);
      const target = url;
      this.backend.readAttachment(path).then((u) => target.set(u), () => target.set(null));
    }
    return url.asReadonly();
  }

  /** Reads picked, pasted or dropped files; too many or too large ones are refused by name. */
  async read(files: File[], already: number): Promise<{ drafts: DraftAttachment[]; refused: string[] }> {
    const drafts: DraftAttachment[] = [];
    const refused: string[] = [];
    for (const file of files) {
      const name = attachmentName(file);
      if (already + drafts.length >= MAX_ATTACHMENTS) { refused.push(`${name} (tối đa ${MAX_ATTACHMENTS} tệp)`); continue; }
      if (file.size > MAX_ATTACHMENT_BYTES) { refused.push(`${name} (quá 25 MB)`); continue; }
      const data = toBase64(await file.arrayBuffer());
      const image = isImageName(name);
      drafts.push({ id: this.nextId++, name, size: file.size, image, data, url: image ? `data:${file.type || 'image/png'};base64,${data}` : null });
    }
    return { drafts, refused };
  }

  /** Saves the drafts and returns the message with their lines appended. */
  async attach(text: string, drafts: DraftAttachment[]): Promise<string> {
    const paths: string[] = [];
    for (const d of drafts) {
      const path = await this.backend.saveAttachment(d.name, d.data);
      // The preview is already here: no need to read the file back.
      if (d.url) this.urls.set(path, signal<string | null>(d.url));
      paths.push(path);
    }
    return withAttachments(text, paths);
  }
}
