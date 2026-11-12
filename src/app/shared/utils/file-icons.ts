import { signal } from '@angular/core';

/**
 * File and folder icons from Material Icon Theme (MIT, the npm package
 * `material-icon-theme`). `angular.json` copies its SVGs and its manifest to
 * `file-icons/`; the manifest maps folder names, file names and extensions to icons,
 * like VS Code does, so `services/` and `*.component.ts` each get their own icon.
 */
export interface IconManifest {
  iconDefinitions: Record<string, { iconPath: string }>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
}

const BASE = 'file-icons/';
const manifest = signal<IconManifest | null>(null);
let loading = false;

/** The manifest once loaded; starts the one load on first use. Null until then, or if it fails. */
export function iconManifest(): IconManifest | null {
  if (!loading && typeof fetch === 'function') {
    loading = true;
    fetch(`${BASE}material-icons.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m: IconManifest | null) => manifest.set(m))
      .catch(() => manifest.set(null));
  }
  return manifest();
}

/** Icon id for a file or folder name, following VS Code's order: exact name, then the longest extension. */
export function iconId(m: IconManifest, name: string, dir = false, open = false): string {
  const n = name.toLowerCase();
  if (dir) {
    return (open ? m.folderNamesExpanded[n] : m.folderNames[n]) ?? (open ? m.folderExpanded : m.folder);
  }
  const named = m.fileNames[n];
  if (named) return named;
  // "app.component.spec.ts" tries "component.spec.ts", "spec.ts", "ts".
  for (let dot = n.indexOf('.', 1); dot !== -1; dot = n.indexOf('.', dot + 1)) {
    const hit = m.fileExtensions[n.slice(dot + 1)];
    if (hit) return hit;
  }
  return m.file;
}

export function iconUrl(m: IconManifest, id: string): string | null {
  const path = m.iconDefinitions[id]?.iconPath;
  if (!path) return null;
  return BASE + path.slice(path.lastIndexOf('/') + 1);
}
