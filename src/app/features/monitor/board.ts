import { AgentId, PermissionRequest } from '../../core/protocol';
import { Run, turnStart } from '../../services/runs/run';
import { costOf } from '../../services/usage/pricing';
import { MascotPose } from '../../shared/ui/mascot';
import { withoutAttachments } from '../../shared/utils/attachments';
import { mascotPose, NAP_MS } from '../chat/dock/dock-mascot';
import { segmentsOf } from '../chat/conversation/timeline';
import { middleTruncate } from '../chat/conversation/tool-step';

export type BoardState = 'needs_you' | 'running' | 'done' | 'sleep' | 'failed';
export interface BoardCard {
  runId: string;
  agent: AgentId;
  title: string;
  project: string;
  parentTitle: string | null;
  state: BoardState;
  pose: MascotPose;
  tail: string[];
  durationMs: number;
  costUsd: number | null;
  contextPercent: number | null;
  permission: PermissionRequest | null;
}

const ORDER: BoardState[] = ['needs_you', 'running', 'failed', 'done', 'sleep'];
const DAY_MS = 24 * 60 * 60_000;
const titleOf = (r: Run): string => (withoutAttachments(r.prompt).trim() || 'Cuộc trò chuyện').slice(0, 80);
const activityAt = (r: Run, lastEvent: Record<string, number>): number =>
  Math.max(lastEvent[r.id] ?? 0, r.endedAt ?? 0, turnStart(r));

function stateOf(r: Run, lastEvent: Record<string, number>, now: number): BoardState {
  if (r.permissions.length) return 'needs_you';
  if (r.status === 'running') return 'running';
  if (r.status === 'failed') return 'failed';
  if (r.restored || now - activityAt(r, lastEvent) >= NAP_MS) return 'sleep';
  // Stopped/interrupted runs have no separate board state; recent endings are done.
  return 'done';
}

/** Same CLI rows as the agent terminal, without prompts or protocol noise. */
function tailOf(r: Run): string[] {
  const rows: string[] = [];
  const append = (text: string): void => {
    rows.push(...text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => middleTruncate(s, 80)));
  };
  for (const seg of segmentsOf(r.lines, r.status === 'running')) {
    if (seg.kind === 'text') append(seg.text);
    else if (seg.kind === 'work') {
      for (const step of seg.steps) {
        if (step.head) {
          const name = step.head.name.replace(/\s+/g, ' ');
          const arg = step.head.arg?.replace(/\s+/g, ' ');
          append(arg == null ? `● ${name}` : `● ${name}(${middleTruncate(arg, Math.max(1, 80 - name.length - 4))})`);
        } else append(`● ${step.text.replace(/\s+/g, ' ')}`);
        const result = step.diff ? `+${step.diff.added} −${step.diff.removed}` : step.result;
        if (result) append(`└ ${result.replace(/\s+/g, ' ')}`);
      }
    }
  }
  return rows.slice(-3);
}

/** One latest main run per eligible conversation, plus independently eligible children. */
export function boardCards(runs: Run[], lastEvent: Record<string, number>, now: number): BoardCard[] {
  const eligible = (r: Run): boolean => r.status === 'running' || r.permissions.length > 0 ||
    (r.endedAt !== null && r.endedAt >= now - DAY_MS);
  const byId = new Map(runs.map(r => [r.id, r]));
  const threads = new Map<string, Run[]>();
  for (const r of runs) {
    const key = r.thread || r.group || r.id;
    const list = threads.get(key) ?? [];
    list.push(r);
    threads.set(key, list);
  }
  const selected: { run: Run; title: string }[] = [];
  for (const list of threads.values()) {
    const main = list.filter(r => !r.parent).sort((a, b) => a.startedAt - b.startedAt);
    const latest = main.at(-1);
    if (latest && list.some(eligible)) selected.push({ run: latest, title: titleOf(main[0]) });
    for (const r of list) if (r.parent && eligible(r)) selected.push({ run: r, title: titleOf(r) });
  }
  return selected.sort((a, b) =>
    ORDER.indexOf(stateOf(a.run, lastEvent, now)) - ORDER.indexOf(stateOf(b.run, lastEvent, now)) ||
    activityAt(b.run, lastEvent) - activityAt(a.run, lastEvent) || b.run.startedAt - a.run.startedAt,
  ).map(({ run: r, title }): BoardCard => {
    const parent = r.parent ? byId.get(r.parent) : undefined;
    return {
      runId: r.id, agent: r.agent, title, project: r.project,
      parentTitle: parent ? titleOf(parent) : null,
      state: stateOf(r, lastEvent, now),
      // No observed running → done transition in this pure projection: do not invent a cheer.
      pose: mascotPose(r, { now, lastEvent: lastEvent[r.id] }).pose,
      tail: tailOf(r),
      durationMs: Math.max(0, (r.status === 'running' ? now : r.endedAt ?? turnStart(r)) - turnStart(r)),
      costUsd: costOf(r.agent, r.usage, r.startedAt).usd,
      contextPercent: r.context?.percent ?? null,
      permission: r.permissions[0] ?? null,
    };
  });
}

export function boardCounts(cards: BoardCard[]): Record<BoardState | 'all', number> {
  const counts = { all: cards.length, needs_you: 0, running: 0, failed: 0, done: 0, sleep: 0 };
  for (const card of cards) counts[card.state]++;
  return counts;
}
