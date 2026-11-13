import { AgentId } from '../../core/protocol';
import { AGENT_META } from '../../services/agents/agent-meta';
import { Run } from '../../services/runs/run';
import { ConsoleLine } from '../chat/conversation/describe-line';
import { splitAttachments } from '../../shared/utils/attachments';

/** What the user said (a bubble), or one line of the agent's log. */
export type LogEntry = { kind: 'user'; text: string; files: number } | { kind: 'line'; line: ConsoleLine };

/** One run of the conversation, laid out like a turn of the chat. */
export interface LogSection {
  run: Run;
  /** `delegate`: another agent this conversation gave work to; `subagent`: an agent's own helper. */
  role: 'main' | 'delegate' | 'subagent';
  /** The agent that gave the work, for nested sections. */
  from: AgentId | null;
  entries: LogEntry[];
}

export interface LogFilter {
  agent: AgentId | null;
  errorsOnly: boolean;
  query: string;
}

function userEntry(message: string): LogEntry {
  const { text, files } = splitAttachments(message);
  return { kind: 'user', text, files: files.length };
}

/**
 * Every run of the selected conversation, sub-agents included, in the order they started:
 * one log to read instead of a tab per run. Sub-agents follow the run that started them.
 */
export function logSections(all: Run[], thread: string | null | undefined): LogSection[] {
  if (!thread) return [];
  const runs = all.filter((r) => r.thread === thread).sort((a, b) => a.startedAt - b.startedAt);
  const byId = new Map(runs.map((r) => [r.id, r]));
  const sections: LogSection[] = runs.map((run) => {
    const parent = run.parent ? byId.get(run.parent) ?? null : null;
    const role = !run.parent ? 'main' : run.id.includes('~') ? 'subagent' : 'delegate';
    const entries: LogEntry[] = [];
    // A run's first message is its prompt; later ones arrive as `user` lines.
    if (role === 'main' && run.prompt && run.lines[0]?.tone !== 'user') entries.push(userEntry(run.prompt));
    for (const line of run.lines) entries.push(line.tone === 'user' ? userEntry(line.text) : { kind: 'line', line });
    return { run, role, from: parent?.agent ?? null, entries };
  });
  // Keep each nested run right after the section of the run that started it.
  const ordered: LogSection[] = [];
  const place = (s: LogSection) => {
    if (ordered.includes(s)) return;
    ordered.push(s);
    for (const child of sections) if (child.run.parent === s.run.id) place(child);
  };
  for (const s of sections) if (!s.run.parent || !byId.has(s.run.parent)) place(s);
  return ordered;
}

/** The sections the filters leave, without the ones left empty (a header alone says nothing). */
export function filterSections(sections: LogSection[], f: LogFilter): LogSection[] {
  const q = f.query.trim().toLocaleLowerCase('vi');
  const hasFilter = f.errorsOnly || !!q;
  return sections
    .filter((s) => !f.agent || s.run.agent === f.agent)
    .map((s) => ({
      ...s,
      entries: s.entries.filter((e) => {
        if (f.errorsOnly && (e.kind !== 'line' || e.line.tone !== 'error')) return false;
        const text = e.kind === 'user' ? e.text : e.line.text;
        return !q || text.toLocaleLowerCase('vi').includes(q);
      }),
    }))
    .filter((s) => !hasFilter || s.entries.length > 0);
}

export function sectionTitle(s: LogSection): string {
  const name = AGENT_META[s.run.agent].name;
  if (s.role === 'delegate') return `${s.from ? AGENT_META[s.from].name : 'Agent'} giao cho ${name}`;
  if (s.role === 'subagent') return `Subagent của ${s.from ? AGENT_META[s.from].name : 'agent'}`;
  return name;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The log as plain text, to paste into a bug report. */
export function logText(sections: LogSection[]): string {
  return sections.map((s) => {
    const head = `## ${sectionTitle(s)} · ${clock(s.run.startedAt)} · ${s.run.status}`;
    const task = s.role !== 'main' && s.run.prompt ? [`Việc: ${s.run.prompt}`] : [];
    const body = s.entries.map((e) => (e.kind === 'user' ? `> Bạn: ${e.text}${e.files ? ` (${e.files} tệp đính kèm)` : ''}` : e.line.text));
    return [head, ...task, ...body].join('\n');
  }).join('\n\n');
}
