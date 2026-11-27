import { AgentId } from '../core/protocol';
import { Run } from '../services/runs/run';
import { AGENT_META } from '../services/agents/agent-meta';
import { withoutAttachments } from '../shared/utils/attachments';

export interface RunningRow {
  id: string;
  agent: AgentId;
  title: string;
  child: boolean;
  status: 'running' | 'needs_you';
  project: string;
}

/** Run đang chạy hoặc chờ duyệt ở mọi dự án; con nằm ngay dưới cha còn hoạt động. */
export function runningRows(runs: Run[], max = 8): { rows: RunningRow[]; more: number } {
  const active = runs.filter((r) => r.status === 'running' || r.permissions.length > 0);
  const ids = new Set(active.map((r) => r.id));
  const parentOf = (r: Run): string | undefined => r.parent || /^(.*)~\d+$/.exec(r.id)?.[1];
  const children = new Map<string, Run[]>();
  for (const r of active) {
    const parent = parentOf(r);
    if (parent && ids.has(parent)) children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const rows: RunningRow[] = [];
  const seen = new Set<string>();
  const append = (r: Run, child: boolean): void => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const title = (withoutAttachments(r.prompt).trim() || 'Cuộc trò chuyện').slice(0, 80);
    rows.push({
      id: r.id, agent: r.agent, project: r.project, child,
      title: parentOf(r) ? `↳ ${AGENT_META[r.agent].name} · ${title}` : title,
      status: r.permissions.length ? 'needs_you' : 'running',
    });
    for (const nested of children.get(r.id) ?? []) append(nested, true);
  };
  for (const r of active) {
    const parent = parentOf(r);
    if (!parent || !ids.has(parent)) append(r, false);
  }
  // Không bỏ mất run nếu dữ liệu quan hệ cha–con bị tạo vòng.
  for (const r of active) if (!seen.has(r.id)) append(r, false);
  const kept = rows.slice(0, Math.max(0, max));
  return { rows: kept, more: rows.length - kept.length };
}
