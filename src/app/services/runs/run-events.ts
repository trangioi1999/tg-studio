import { addLine, ConsoleLine, describeLine, MESSAGE_KEY } from '../../features/chat/conversation/describe-line';
import { planProposal } from '../../features/chat/dock/proposal';
import { AgentCommand, AgentEvent, AgentId, Delegation, PermissionRequest, PlanEntry, RunStatus, StoredRun, Usage } from '../../core/protocol';
import { AGENT_IDS } from '../agents/agent-meta';
import { Handoff, MAX_LINES, Run } from './run';

/** What applying an event asks the service to do besides changing the run. */
export type RunEffect =
  /** Remember which file a tool call works on (tool updates repeat only what changed). */
  | { kind: 'track'; update: Json; at: number }
  /** A turn or the session ended: forget its tool calls. */
  | { kind: 'forget' }
  /** Plan limits may have moved. */
  | { kind: 'limits' }
  | { kind: 'commands'; list: AgentCommand[] }
  | { kind: 'handoff'; handoff: Handoff };

/**
 * One event applied to its run. `parent`: the run that delegated this one, for a `started`
 * event that names it; `stopping`: the user asked this run to stop.
 */
export function applyEvent(run: Run, e: AgentEvent, ctx: { parent?: Run; stopping: boolean }): { run: Run; effects: RunEffect[] } {
  const effects: RunEffect[] = [];
  const next = reduce(run, e, ctx, effects);
  return { run: next, effects };
}

function reduce(run: Run, e: AgentEvent, ctx: { parent?: Run; stopping: boolean }, effects: RunEffect[]): Run {
  switch (e.kind) {
    case 'message': {
      const text = dataOf(e)['text'];
      if (typeof text !== 'string') return run;
      const continues = run.lines.at(-1)?.key === MESSAGE_KEY;
      return {
        ...run,
        task: true,
        lastMessage: continues ? run.lastMessage + text : text,
        lines: addLine(run.lines, toConsoleLine(run.agent, 'message', text)).slice(-MAX_LINES),
      };
    }
    case 'tool':
      effects.push({ kind: 'track', update: dataOf(e), at: e.atMs });
      return { ...run, task: true, lines: applyTool(run.lines, dataOf(e)).slice(-MAX_LINES) };
    case 'plan': {
      const entries = dataOf(e)['entries'];
      const plan = Array.isArray(entries) ? (entries as PlanEntry[]).filter((p) => typeof p?.content === 'string') : run.plan;
      return { ...run, plan, lines: applyPlan(run.lines, dataOf(e)).slice(-MAX_LINES) };
    }
    case 'permission': {
      const request = e.data as unknown as PermissionRequest;
      return { ...run, task: true, permissions: [...run.permissions, request], waits: [...run.waits, { from: e.atMs, to: null }] };
    }
    case 'permission_resolved': {
      const id = dataOf(e)['requestId'];
      const open = run.waits.findIndex((w) => w.to === null);
      const waits = open < 0 ? run.waits : run.waits.map((w, i) => (i === open ? { ...w, to: e.atMs } : w));
      return { ...run, permissions: run.permissions.filter((p) => p.requestId !== id), waits };
    }
    case 'started':
    case 'log':
    case 'stderr': {
      const parentId = e.kind === 'started' ? dataOf(e)['parent'] : undefined;
      if (typeof parentId === 'string') {
        // A delegated run belongs to its parent's conversation, nested in it.
        // An agent's own subagent (ACP child session) has no draft of its own; a delegated agent does.
        const parent = ctx.parent;
        const sub = dataOf(e)['subagent'] === true;
        const title = dataOf(e)['title'];
        run = { ...run, parent: parentId, task: !sub, thread: parent?.thread ?? run.thread, project: parent?.project ?? run.project, scope: parent?.scope ?? run.scope,
          perm: parent?.perm, place: sub ? parent?.place : 'draft', prompt: run.prompt || (typeof title === 'string' ? title : '') };
      }
      const line = toConsoleLine(run.agent, e.kind, e.line);
      const proposal = e.kind === 'log' && run.perm === 'read' ? planProposal(run.agent, e.line) : null;
      const next = proposal ? { ...run, proposal } : run;
      return line ? { ...next, lines: addLine(run.lines, line).slice(-MAX_LINES) } : next;
    }
    case 'usage': {
      const d = dataOf(e);
      const credits = typeof d['credits'] === 'number' && typeof d['turnCredits'] === 'number'
        ? { total: d['credits'], turn: d['turnCredits'] } : run.credits;
      return { ...run, usage: mergeUsage(run.usage, e.usage), credits };
    }
    case 'limits':
      return run; // handled above: limits belong to the account, not the run
    case 'commands': {
      const list = dataOf(e)['commands'];
      if (Array.isArray(list)) effects.push({ kind: 'commands', list: list as AgentCommand[] });
      return run;
    }
    case 'bridge': {
      const d = dataOf(e);
      const lines = e.line ? addLine(run.lines, { text: e.line, tone: 'tool' }).slice(-MAX_LINES) : run.lines;
      if (d['tool'] === 'report_progress' && typeof d['step'] === 'string') {
        const pct = typeof d['pct'] === 'number' ? d['pct'] : null;
        return { ...run, lines, progress: { step: d['step'], pct, note: typeof d['note'] === 'string' ? d['note'] : null, at: e.atMs } };
      }
      if ((d['tool'] === 'delegate' || d['tool'] === 'delegate_done') && typeof d['id'] === 'string' && AGENT_IDS.includes(d['agent'] as AgentId)) {
        const { tool: _, ...rest } = d;
        const delegation = rest as unknown as Delegation;
        const list = run.delegations ?? [];
        const known = list.some((x) => x.id === delegation.id);
        const delegations = known ? list.map((x) => (x.id === delegation.id ? delegation : x)) : [...list, delegation];
        // The nested block shows it, where it was made; the work log does not repeat it.
        if (known) return { ...run, delegations };
        const mark = { text: e.line ?? delegation.task, tone: 'delegate' as const, label: delegation.id };
        return { ...run, delegations, lines: [...run.lines, mark].slice(-MAX_LINES) };
      }
      if (d['tool'] === 'handoff_to' && typeof d['id'] === 'string' && typeof d['task'] === 'string' && AGENT_IDS.includes(d['agent'] as AgentId)) {
        const handoff: Handoff = { id: d['id'], runId: run.id, from: run.agent, agent: d['agent'] as AgentId, task: d['task'],
          files: Array.isArray(d['files']) ? d['files'].filter((f): f is string => typeof f === 'string') : [], at: e.atMs };
        effects.push({ kind: 'handoff', handoff });
      }
      return { ...run, lines };
    }
    case 'user':
      return { ...run, status: 'running', turnAt: e.atMs, endedAt: null, exitCode: null, proposal: null, lastTurn: null, lines: e.line ? [...run.lines, { text: e.line, tone: 'user' as const }].slice(-MAX_LINES) : run.lines };
    case 'turn_end': {
      const reported = dataOf(e)['status'];
      const lastTurn = reported === 'failed' || reported === 'stopped' ? reported : ctx.stopping ? 'stopped' : 'done';
      effects.push({ kind: 'forget' }, { kind: 'limits' });
      const waits = run.waits.map((w) => (w.to === null ? { ...w, to: e.atMs } : w));
      return { ...run, status: 'idle', lastTurn, endedAt: e.atMs, permissions: [], waits };
    }
    case 'exit': {
      const reported = dataOf(e)['status'];
      const status: RunStatus = reported === 'done' || reported === 'failed' || reported === 'stopped'
        ? reported : ctx.stopping ? 'stopped' : e.code === 0 ? 'done' : 'failed';
      effects.push({ kind: 'forget' }, { kind: 'limits' });
      const waits = run.waits.map((w) => (w.to === null ? { ...w, to: e.atMs } : w));
      return { ...run, status, exitCode: e.code, endedAt: e.atMs, permissions: [], waits };
    }
  }
}

type Json = Record<string, unknown>;

export function dataOf(e: AgentEvent): Json {
  return e.data !== null && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Json) : {};
}

function toConsoleLine(agent: AgentId, kind: StoredRun['lines'][number]['kind'], line: string | null): ConsoleLine | null {
  if (kind === 'started') return { text: line ?? 'started', tone: 'muted' };
  if (!line) return null;
  if (kind === 'message') return { text: line, tone: 'text', key: MESSAGE_KEY };
  if (kind === 'user') return { text: line, tone: 'user' };
  if (kind === 'log') return describeLine(agent, line);
  return { text: line, tone: ADAPTER_TIMING.test(line) || line.startsWith('◇ kiro ') ? 'muted' : 'error' };
}

/** Timing notes the Claude ACP adapter writes to stderr while opening or resuming a session; local work, not errors. */
const ADAPTER_TIMING = /^\[session\/[\w-]+\] sessionId=\S+ phase=/;

/** A tool call has one console line, updated in place as its status changes. */
function applyTool(lines: ConsoleLine[], update: Json): ConsoleLine[] {
  const id = update['toolCallId'];
  if (typeof id !== 'string') return lines;
  const key = `tool:${id}`;
  const index = lines.findIndex((l) => l.key === key);
  const title = typeof update['title'] === 'string' ? update['title'] : null;
  const label = title ?? lines[index]?.label ?? 'tool';
  const status = update['status'];
  const failed = status === 'failed';
  const suffix = status === 'completed' ? ' ✓' : failed ? ' ✕' : '';
  const line: ConsoleLine = { key, label, text: `› ${label}${suffix}`, tone: failed ? 'error' : 'tool' };
  if (index < 0) return [...lines, line];
  return lines.map((l, i) => (i === index ? line : l));
}

const PLAN_MARK: Record<string, string> = { completed: '[x]', in_progress: '[~]' };

/** The plan has one block in the console, replaced each time the agent revises it. */
function applyPlan(lines: ConsoleLine[], update: Json): ConsoleLine[] {
  const entries = Array.isArray(update['entries']) ? (update['entries'] as Json[]) : [];
  const text = entries.map((e) => `${PLAN_MARK[String(e['status'])] ?? '[ ]'} ${String(e['content'] ?? '')}`).join('\n');
  const line: ConsoleLine = { key: 'plan', text, tone: 'muted' };
  return lines.some((l) => l.key === 'plan') ? lines.map((l) => (l.key === 'plan' ? line : l)) : [...lines, line];
}

export function restoreRun(s: StoredRun): Run {
  const lines = s.lines.reduce<ConsoleLine[]>((all, l) => addLine(all, toConsoleLine(s.agent, l.kind, l.line)), []);
  const lastMessage = lines.filter((l) => l.key === MESSAGE_KEY).at(-1)?.text ?? '';
  // A run still marked running or idle belongs to this app session: the UI was only reloaded.
  const { worktree, ...run } = s;
  return { ...run, thread: s.thread ?? s.group ?? s.id, lines, restored: s.status !== 'running' && s.status !== 'idle', task: worktree !== null, permissions: [], lastMessage, waits: [], plan: [], progress: null };
}

/**
 * Joins a saved run with events that reached the UI before history loaded. A line is
 * saved before it is emitted, so the end of the snapshot may repeat the first live lines.
 */
export function reattach(saved: Run, live: Run): Run {
  const ended = saved.status === 'done' || saved.status === 'failed' || saved.status === 'stopped';
  const final = live.status !== 'running' ? live : ended ? saved : live;
  return {
    ...saved,
    status: final.status,
    exitCode: final.exitCode,
    endedAt: final.endedAt,
    usage: live.usage?.cumulative ? live.usage : (saved.usage ?? live.usage),
    lines: joinLines(saved.lines, live.lines).slice(-MAX_LINES),
    restored: false,
    task: saved.task || live.task,
    permissions: live.permissions,
    lastMessage: live.lastMessage || saved.lastMessage,
    group: saved.group ?? live.group,
    parent: saved.parent ?? live.parent,
    delegations: live.delegations ?? saved.delegations,
    waits: live.waits,
    plan: live.plan,
    progress: live.progress,
  };
}

function joinLines(saved: ConsoleLine[], live: ConsoleLine[]): ConsoleLine[] {
  for (let overlap = Math.min(saved.length, live.length); overlap > 0; overlap--) {
    const tail = saved.slice(-overlap);
    if (tail.every((l, i) => l.text === live[i].text && l.tone === live[i].tone)) {
      return [...saved, ...live.slice(overlap)];
    }
  }
  return [...saved, ...live];
}

function mergeUsage(prev: Usage | null, next: Usage | null): Usage | null {
  if (!next) return prev;
  if (!prev || next.cumulative) return next;
  return {
    ...next,
    inputTokens: prev.inputTokens + next.inputTokens,
    cachedInputTokens: prev.cachedInputTokens + next.cachedInputTokens,
    outputTokens: prev.outputTokens + next.outputTokens,
    costUsd: prev.costUsd === null && next.costUsd === null ? null : (prev.costUsd ?? 0) + (next.costUsd ?? 0),
  };
}
