// Syntax colours for code blocks in chat messages. Only the core of highlight.js and the
// languages agents usually write, so the chat stays light; Monaco is for files.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import csharp from 'highlight.js/lib/languages/csharp';

const LANGUAGES = { bash, css, diff, go, java, javascript, json, powershell, python, rust, scss, sql, typescript, xml, yaml, csharp };
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['html', 'svg', 'angular'], { languageName: 'xml' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs'], { languageName: 'javascript' });
hljs.registerAliases(['ps1', 'pwsh'], { languageName: 'powershell' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['cs'], { languageName: 'csharp' });

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The block as HTML spans (`hljs-*` classes). Unknown or missing language: a guess among
 * the loaded ones, kept only when it is a confident one; otherwise plain text. */
export function highlightCode(code: string, lang?: string | null): { html: string; language: string | null } {
  const name = lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  try {
    if (name && hljs.getLanguage(name)) {
      return { html: hljs.highlight(code, { language: name, ignoreIllegals: true }).value, language: hljs.getLanguage(name)!.name ?? name };
    }
    if (code.length <= 20_000) {
      const guess = hljs.highlightAuto(code);
      if (guess.language && guess.relevance >= 5) return { html: guess.value, language: guess.language };
    }
  } catch { /* plain text below */ }
  return { html: escape(code), language: null };
}
