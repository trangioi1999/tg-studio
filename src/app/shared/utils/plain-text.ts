/** Plain text for compact agent-message previews; code contents stay literal. */
export function plainText(md: string): string {
  const code: string[] = [];
  const save = (text: string): string => `\u0000${code.push(text) - 1}\u0000`;
  return md
    .replace(/^\s*```[^\n]*\n([\s\S]*?)^\s*```\s*$/gm, (_, text: string) => save(text.trimEnd()))
    .replace(/(`+)([\s\S]*?)\1/g, (_, _ticks: string, text: string) => save(text))
    .replace(/! ?\[([^\]]*)\]\([^\n]*?\)|\[([^\]]*)\]\([^\n]*?\)/g, (_, alt: string, label: string) => alt ?? label)
    .replace(/^\s{0,3}(?:>\s*)+/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/gm, '$1')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/\*\*([\s\S]+?)\*\*|__([\s\S]+?)__/g, (_, stars: string, underscores: string) => stars ?? underscores)
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/`/g, '')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)]);
}
