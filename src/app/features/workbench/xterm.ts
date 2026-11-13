import type { XtermLike } from '../../services/app/terminals.service';

/** xterm.js, loaded on first use so it stays out of the main bundle. Its CSS is a global style (angular.json). */
export async function loadXterm(): Promise<XtermLike> {
  // CommonJS packages: a production build puts their exports under `default`, `ng serve` does not.
  const [xterm, fitAddon] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
  const pick = <T>(mod: unknown, name: string): T => {
    const m = mod as Record<string, unknown> & { default?: Record<string, unknown> };
    return (m[name] ?? m.default?.[name]) as T;
  };
  const Terminal = pick<typeof import('@xterm/xterm').Terminal>(xterm, 'Terminal');
  const FitAddon = pick<typeof import('@xterm/addon-fit').FitAddon>(fitAddon, 'FitAddon');
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const term = new Terminal({
    fontFamily: v('--mono', 'monospace'),
    fontSize: 12.5,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: v('--bg', '#111'), foreground: v('--text', '#ddd'), cursor: v('--text', '#ddd'), selectionBackground: v('--line-strong', '#444') },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Quick Open stays the app's, even while the terminal has focus.
  term.attachCustomKeyEventHandler((e) => !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p'));
  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    open: (el) => term.open(el),
    write: (data) => term.write(data),
    onData: (cb) => void term.onData(cb),
    fit: () => {
      try { fit.fit(); } catch { /* hidden panel: no size yet */ }
    },
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  };
}
