import { Component, computed, input } from '@angular/core';

/** Short label and colour per file type, like an editor's file icons. */
const TYPES: [RegExp, string, string][] = [
  [/\.(ts|tsx|mts|cts)$/, 'TS', '#4f9cf0'],
  [/\.(js|jsx|mjs|cjs)$/, 'JS', '#e8c547'],
  [/\.json[c5]?$/, '{}', '#d4b04c'],
  [/\.(html?|xml|svg)$/, '<>', '#e2763f'],
  [/\.(s?css|sass|less)$/, '#', '#d36aa8'],
  [/\.(md|mdx|txt)$/, 'M', '#8e8e98'],
  [/\.rs$/, 'RS', '#dc8a5a'],
  [/\.(py|pyi)$/, 'PY', '#5aa0d8'],
  [/\.go$/, 'GO', '#5cc6d8'],
  [/\.(ya?ml|toml|ini|env)$/, '≡', '#b48ce0'],
  [/\.(sh|zsh|bash|ps1)$/, '$', '#7ec27e'],
  [/\.(png|jpe?g|gif|webp|ico|icns)$/, '▣', '#56b6a3'],
  [/\.(lock)$/, '•', '#6a6a74'],
];

@Component({
  selector: 'tg-file-icon',
  host: { class: 'file-icon', 'aria-hidden': 'true', '[style.color]': 'type()[1]' },
  template: `{{ type()[0] }}`,
})
export class FileIcon {
  readonly name = input.required<string>();
  protected readonly type = computed<[string, string]>(() => {
    const n = this.name().toLowerCase();
    const hit = TYPES.find(([re]) => re.test(n));
    return hit ? [hit[1], hit[2]] : ['·', '#6a6a74'];
  });
}
