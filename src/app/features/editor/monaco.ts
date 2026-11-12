/** The editor core only; the full `monaco-editor` entry also bundles language services. */
export type MonacoApi = typeof import('monaco-editor/editor/editor.api.js');

import type * as Monaco from 'monaco-editor/editor/editor.api.js';

/** What the status line under an editor shows. */
export interface EditorStatus {
  line: number;
  column: number;
  selected: number;
  lines: number;
  language: string;
}

/** Options shared by the project viewer and the draft editor, so both feel like one editor. */
export const EDITOR_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: 'tg-dark',
  automaticLayout: true,
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12.5,
  lineHeight: 19,
  minimap: { enabled: true, renderCharacters: false, maxColumn: 80, showSlider: 'mouseover', scale: 1 },
  stickyScroll: { enabled: true, maxLineCount: 4 },
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: 'active', indentation: true },
  smoothScrolling: true,
  cursorSmoothCaretAnimation: 'on',
  mouseWheelZoom: true,
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line',
  renderWhitespace: 'selection',
  padding: { top: 6 },
};

/** Keeps `set` up to date with the cursor, selection and model of `editor`. */
export function trackStatus(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor, set: (s: EditorStatus | null) => void): void {
  const update = () => {
    const model = editor.getModel();
    const pos = editor.getPosition();
    if (!model || !pos) return set(null);
    const sel = editor.getSelection();
    const id = model.getLanguageId();
    const language = monaco.languages.getLanguages().find((l) => l.id === id)?.aliases?.[0] ?? id;
    set({ line: pos.lineNumber, column: pos.column, selected: sel ? model.getValueInRange(sel).length : 0, lines: model.getLineCount(), language: id === 'plaintext' ? 'Văn bản' : language });
  };
  editor.onDidChangeCursorSelection(update);
  editor.onDidChangeModel(update);
  editor.onDidChangeModelContent(update);
  update();
}

/** Alt+Z toggles word wrap, as in most editors. Returns a function that toggles it too. */
export function addWrapToggle(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor, changed: (on: boolean) => void): () => void {
  let on = false;
  const toggle = () => {
    on = !on;
    editor.updateOptions({ wordWrap: on ? 'on' : 'off' });
    changed(on);
  };
  editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, toggle);
  return toggle;
}

let loading: Promise<MonacoApi> | null = null;

/**
 * Loads Monaco from the app bundle on first use (no CDN, works offline).
 * Only the base worker and Monarch highlighting are included, not language services.
 */
export function loadMonaco(): Promise<MonacoApi> {
  return (loading ??= (async () => {
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: () => new Worker(new URL('./editor.worker', import.meta.url), { type: 'module' }),
    };
    // esbuild splits the CSS imported by Monaco's modules into a lazy file nothing loads,
    // so the editor's own stylesheet ships as an asset and is linked here.
    await loadStylesheet('monaco/editor.main.css');
    const [api] = await Promise.all([
      import('monaco-editor/editor/editor.api.js'),
      import('monaco-editor/basic-languages/monaco.contribution.js'),
    ]);
    defineTheme(api);
    return api;
  })().catch((e) => {
    loading = null;
    throw e;
  }));
}

function loadStylesheet(href: string): Promise<void> {
  const existing = document.querySelector<HTMLLinkElement>(`link[data-tg="${href}"]`);
  if (existing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset['tg'] = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Không tải được ${href}`));
    document.head.append(link);
  });
}

/** Colours from docs/06-design-system.md. */
function defineTheme(monaco: MonacoApi): void {
  monaco.editor.defineTheme('tg-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'C4A7FF' },
      { token: 'identifier.function', foreground: '7CC4FF' },
      { token: 'string', foreground: 'A5D6FF' },
      { token: 'type', foreground: 'F2CC8F' },
      { token: 'type.identifier', foreground: 'F2CC8F' },
      { token: 'comment', foreground: '7D8590' },
      { token: 'delimiter', foreground: 'A1A1AA' },
      { token: 'number', foreground: 'F2CC8F' },
    ],
    colors: {
      'editor.background': '#0a0a0b',
      'editor.foreground': '#e4e4e7',
      'editorLineNumber.foreground': '#4a4a52',
      'editorLineNumber.activeForeground': '#8a8a93',
      'editor.lineHighlightBackground': '#131316',
      'editor.selectionBackground': '#2a3550',
      'editorGutter.background': '#0a0a0b',
      'editorWidget.background': '#131316',
      'editorWidget.border': '#1e1e22',
      'scrollbarSlider.background': '#ffffff14',
      'scrollbarSlider.hoverBackground': '#ffffff22',
    },
  });
}
