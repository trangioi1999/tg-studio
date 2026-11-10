import { AgentCommand, AgentId } from '../../core/protocol';

/** The word being typed that asks for a skill: "/" at the start of the message, or "$" for Codex. */
export interface CommandQuery {
  trigger: '/' | '$';
  /** Index of the trigger in the text. */
  start: number;
  /** What follows the trigger, up to the caret. */
  query: string;
}

export function commandQuery(text: string, caret: number, agent: AgentId | ''): CommandQuery | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)([/$])([\w:.-]*)$/.exec(before);
  if (!m) return null;
  const trigger = m[2] as '/' | '$';
  const start = before.length - m[3].length - 1;
  // A "/" command only means something at the very start; "$skill" is Codex's, anywhere.
  if (trigger === '/' && before.slice(0, start).trim() !== '') return null;
  if (trigger === '$' && agent !== 'codex') return null;
  return { trigger, start, query: m[3] };
}

export type CommandGroup = 'project' | 'user' | 'plugin' | 'command';

export const GROUP_LABEL: Record<CommandGroup, string> = {
  project: 'Skill của dự án',
  user: 'Skill trên máy',
  plugin: 'Plugin',
  command: 'Lệnh',
};

export function groupOf(c: AgentCommand): CommandGroup {
  if (c.kind === 'skill' && c.source) return c.source;
  return 'command';
}

const ORDER: CommandGroup[] = ['project', 'user', 'plugin', 'command'];

/** Matches for the query, grouped in a fixed order; names that start with it come first. */
export function filterCommands(list: AgentCommand[], q: CommandQuery, limit = 40): { group: CommandGroup; items: AgentCommand[] }[] {
  const needle = q.query.toLowerCase();
  const usable = list.filter((c) => (q.trigger === '$' ? c.insert.startsWith('$') : c.insert.startsWith('/')));
  const bare = (c: AgentCommand) => c.name.replace(/^\$/, '').toLowerCase();
  const score = (c: AgentCommand) => {
    const n = bare(c);
    if (!needle) return 1;
    if (n.startsWith(needle) || n.split(':').pop()!.startsWith(needle)) return 2;
    // One or two letters appear in almost every description; only names count until then.
    return n.includes(needle) || (needle.length >= 3 && c.description.toLowerCase().includes(needle)) ? 1 : 0;
  };
  const hits = usable.map((c) => ({ c, s: score(c) })).filter((x) => x.s > 0);
  const out: { group: CommandGroup; items: AgentCommand[] }[] = [];
  let left = limit;
  for (const group of ORDER) {
    const items = hits.filter((x) => groupOf(x.c) === group).sort((a, b) => b.s - a.s).map((x) => x.c).slice(0, left);
    left -= items.length;
    if (items.length) out.push({ group, items });
  }
  return out;
}

/** The text with the typed trigger word replaced by the command, and where the caret goes. */
export function insertCommand(text: string, caret: number, q: CommandQuery, c: AgentCommand): { text: string; caret: number } {
  const next = text.slice(0, q.start) + c.insert + text.slice(caret).replace(/^\s+/, '');
  return { text: next, caret: q.start + c.insert.length };
}
