/** The editor core only; the full `monaco-editor` entry also bundles language services. */
export type MonacoApi = typeof import('monaco-editor/editor/editor.api.js');

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
