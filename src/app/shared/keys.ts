/** Shortcut labels for the current OS: ⌘ on macOS, Ctrl elsewhere. Handlers accept both. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

export const KEYS = IS_MAC
  ? { enter: '⌘↵', backspace: '⌘⌫', save: '⌘S', newChat: '⌘N', model: '⌘⇧M', quickOpen: '⌘P' }
  : { enter: 'Ctrl+↵', backspace: 'Ctrl+⌫', save: 'Ctrl+S', newChat: 'Ctrl+N', model: 'Ctrl+Shift+M', quickOpen: 'Ctrl+P' };
