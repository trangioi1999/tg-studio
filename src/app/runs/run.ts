import { ConsoleLine } from '../chat/conversation/describe-line';
import { Delegation, PermissionRequest, Place, PlanEntry, AgentId, RunStatus, Usage } from '../core/protocol';

export type { RunStatus };

/** A run's status in words, where lists show it. */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = { running: 'đang chạy', idle: 'chờ bạn', done: 'xong', failed: 'lỗi', stopped: 'đã dừng', interrupted: 'gián đoạn' };

/** Lines kept per run in memory; older ones stay in history. */
export const MAX_LINES = 2000;

export interface Run {
  id: string;
  agent: AgentId;
  prompt: string;
  cwd: string;
  startedAt: number;
  /** When the current question was sent: a session's later questions restart the clock. */
  turnAt?: number;
  endedAt: number | null;
  status: RunStatus;
  lines: ConsoleLine[];
  usage: Usage | null;
  exitCode: number | null;
  /** Loaded from an earlier app session: shown, but not part of this session's usage. */
  restored: boolean;
  /** A code task: it has a worktree with changes to review. */
  task: boolean;
  permissions: PermissionRequest[];
  /** Full text of the agent's latest message, used to suggest a commit message. */
  lastMessage: string;
  /** Shared by runs started together in parallel mode. */
  group: string | null;
  /** The conversation it belongs to. */
  thread: string;
  /** The folder the conversation is about. */
  project: string;
  /** Its subfolder, if the conversation is about one. */
  scope: string | null;
  /** Time spent waiting on approval cards; `to` is null while still waiting. Live runs only. */
  waits: { from: number; to: number | null }[];
  /** The agent's latest plan (ACP `plan` update). Live runs only. */
  plan: PlanEntry[];
  /** Latest tg-bridge `report_progress`. Live runs only. */
  progress: { step: string; pct: number | null; note: string | null; at: number } | null;
  /** How the last turn of an open session ended (`turn_end`); null while one runs. */
  lastTurn?: 'done' | 'failed' | 'stopped' | null;
  /** Model picked when it started, if not the agent's default. Live runs only. */
  model?: string | null;
  /** Chỉ hỏi / Hỏi trước / Tự động, as last set. Live runs only. */
  perm?: 'read' | 'ask' | 'auto';
  /** Code tasks: the user's folder or a draft. Live runs only. */
  place?: Place;
  /** Chỉ hỏi: the plan the agent wrote instead of editing, until the next question. Live runs only. */
  proposal?: string | null;
  /** The run that delegated this one (tg-bridge `delegate`): it shows nested in the parent. */
  parent?: string | null;
  /** What this run delegated, as tg-bridge reported it. Live runs only. */
  delegations?: Delegation[];
}

/** A tg-bridge `handoff_to` proposal waiting for the user. */
export interface Handoff {
  id: string;
  /** The run that proposed it. */
  runId: string;
  from: AgentId;
  agent: AgentId;
  task: string;
  files: string[];
  at: number;
}

/** Where an agent is working right now, from its latest tool call that names a file. */
export interface AgentActivity {
  toolCallId: string;
  /** As the agent sent it: usually absolute, inside the run's worktree. */
  path: string;
  line: number | null;
  /** The tool writes the file (edit kind or a diff in its content). */
  editing: boolean;
  /** The tool call finished (completed or failed). */
  done: boolean;
  at: number;
}

/** The run picked with "Use this" for a parallel group, kept while the user moves around. */
export interface GroupChoice {
  /** The run used whole, or null when a composite was used. */
  runId: string | null;
  compositeId: string | null;
  files: number;
  /** Short hash once committed. */
  commit: string | null;
}

export interface AgentUsage {
  agent: AgentId;
  runs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** Where the cost comes from: the CLI, our price table, or nowhere yet. */
  costSource: 'reported' | 'estimated' | 'unpriced' | 'none';
}

/** Where the shown duration of a run counts from: its current question. */
export function turnStart(r: Run): number {
  return r.turnAt ?? r.startedAt;
}

export const QUIET_MS = 30_000;

/** Running, not waiting for the user, and nothing heard for a while. It may still be working. */
export function isQuiet(run: Run, lastEvent: number | undefined, now: number): boolean {
  return run.status === 'running' && !run.permissions.length && now - (lastEvent ?? run.startedAt) >= QUIET_MS;
}

const RECAP_LIMIT = 8000;

/** What a new session is told about a conversation it cannot reopen. Newest text wins the space. */
export function recapOf(run: { prompt: string; lines: ConsoleLine[] }): string {
  const said = run.lines.filter((l) => l.tone === 'user' || l.tone === 'text').map((l) => `${l.tone === 'user' ? 'Người dùng' : 'Agent'}: ${l.text}`);
  const body = [`Người dùng: ${run.prompt}`, ...said].join('\n');
  const kept = body.length > RECAP_LIMIT ? `…${body.slice(-RECAP_LIMIT)}` : body;
  return `Tóm tắt cuộc trò chuyện trước. Thư mục này có thể đã có các thay đổi từ cuộc trò chuyện đó:\n${kept}`;
}
