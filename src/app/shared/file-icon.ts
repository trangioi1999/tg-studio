import { Component, computed, input } from '@angular/core';
import { iconId, iconManifest, iconUrl } from './file-icons';

/** Short label and colour per file type, like an editor's file icons. */
const TYPES: [RegExp, string, string][] = [
  [/\.d\.ts$/, 'TS', '#3b7fc4'],
  [/\.(ts|tsx|mts|cts)$/, 'TS', '#4f9cf0'],
  [/\.(js|jsx|mjs|cjs)$/, 'JS', '#e8c547'],
  [/\.json[c5]?$/, '{}', '#d4b04c'],
  [/\.(html?|xml|svg|vue|svelte|astro)$/, '<>', '#e2763f'],
  [/\.(s?css|sass|less)$/, '#', '#d36aa8'],
  [/\.(md|mdx)$/, 'M', '#6fa8dc'],
  [/\.(txt|log|csv|tsv)$/, '≡', '#8e8e98'],
  [/\.rs$/, 'RS', '#dc8a5a'],
  [/\.(py|pyi|ipynb)$/, 'PY', '#5aa0d8'],
  [/\.go$/, 'GO', '#5cc6d8'],
  [/\.(java|kt|kts|gradle|scala)$/, 'JV', '#e07a5f'],
  [/\.swift$/, 'SW', '#f0754a'],
  [/\.(c|h)$/, 'C', '#7f9cc8'],
  [/\.(cc|cpp|cxx|hpp|hh)$/, 'C+', '#6c8ed4'],
  [/\.cs$/, 'C#', '#8f7cd6'],
  [/\.php$/, 'PHP', '#8b8fd1'],
  [/\.rb$/, 'RB', '#d45a5a'],
  [/\.(dart)$/, 'DT', '#4fb3d9'],
  [/\.sql$/, 'DB', '#d0a35a'],
  [/\.(ya?ml|toml|ini|conf|cfg|properties|plist)$/, '⚙', '#b48ce0'],
  [/(^|\/)\.env(\..+)?$/, '⚙', '#c9b45a'],
  [/\.(sh|zsh|bash|fish|ps1|bat|cmd)$/, '$', '#7ec27e'],
  [/\.(png|jpe?g|gif|webp|ico|icns|bmp|avif|tiff?)$/, '▣', '#56b6a3'],
  [/\.(mp4|mov|webm|mp3|wav|ogg|flac)$/, '▶', '#56b6a3'],
  [/\.(ttf|otf|woff2?)$/, 'Aa', '#9a9aa6'],
  [/\.(zip|tar|gz|tgz|7z|rar|dmg|pkg)$/, '▤', '#a08a6a'],
  [/\.(pdf)$/, 'PDF', '#d65a5a'],
  [/\.(lock)$|^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/, '•', '#6a6a74'],
  [/^(dockerfile|containerfile)$|\.dockerfile$|^docker-compose/, 'DK', '#4a9fe0'],
  [/^\.git(ignore|attributes|modules|keep)$/, 'GIT', '#e06a4a'],
  [/^(\.editorconfig|\.prettierrc.*|\.eslintrc.*|\.npmrc|\.nvmrc)$/, '⚙', '#8e8e98'],
  [/^(makefile|justfile|rakefile|procfile)$/, 'MK', '#b0a070'],
  [/^(license|licence|copying)(\..*)?$/, '©', '#c9b45a'],
];

/**
 * Material Icon Theme icon for a file or folder (`core/file-icons.ts`). Until its manifest
 * has loaded, or if it cannot, a small type badge or folder glyph stands in.
 */
@Component({
  selector: 'tg-file-icon',
  host: { class: 'file-icon', 'aria-hidden': 'true', '[class.folder]': 'dir()', '[style.color]': 'color()' },
  template: `
    @if (url(); as u) {
      <img [src]="u" alt="" width="16" height="16" draggable="false" />
    } @else if (dir()) {
      <svg viewBox="0 0 16 16" width="15" height="15">
        @if (open()) {
          <path d="M1.5 4.25c0-.69.56-1.25 1.25-1.25h3.1l1.4 1.5h5.5c.69 0 1.25.56 1.25 1.25v.75H4.2c-.55 0-1.03.36-1.19.88L1.5 11.9z" fill="currentColor" opacity=".55" />
          <path d="M3.4 7.2c.13-.42.52-.7.96-.7h10.1c.67 0 1.15.65.95 1.3l-1.5 4.75c-.13.42-.52.7-.95.7H2.25c-.5 0-.85-.48-.7-.95z" fill="currentColor" />
        } @else {
          <path d="M1.5 4.25c0-.69.56-1.25 1.25-1.25h3.1l1.4 1.5h5.5c.69 0 1.25.56 1.25 1.25v6.25c0 .69-.56 1.25-1.25 1.25H2.75c-.69 0-1.25-.56-1.25-1.25z" fill="currentColor" />
        }
      </svg>
    } @else if (type(); as t) {
      {{ t[0] }}
    } @else {
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path d="M4 1.75h5l3.25 3.25v8.25c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1V2.75c0-.55.45-1 1-1z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
        <path d="M8.75 1.9V5.3h3.4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
      </svg>
    }
  `,
})
export class FileIcon {
  readonly name = input.required<string>();
  readonly dir = input(false);
  readonly open = input(false);
  private readonly base = computed(() => this.name().slice(this.name().lastIndexOf('/') + 1));
  protected readonly url = computed(() => {
    const m = iconManifest();
    return m ? iconUrl(m, iconId(m, this.base(), this.dir(), this.open())) : null;
  });
  protected readonly type = computed<[string, string] | null>(() => {
    const n = this.base().toLowerCase();
    const hit = TYPES.find(([re]) => re.test(n));
    return hit ? [hit[1], hit[2]] : null;
  });
  protected readonly color = computed(() => (this.dir() ? '#c9a95c' : (this.type()?.[1] ?? '#8a8a94')));
}
