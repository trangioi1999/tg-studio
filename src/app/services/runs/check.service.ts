import { Injectable, inject } from '@angular/core';
import { AgentBackend } from '../../core/backend';
import { AgentEvent, CheckResult } from '../../core/protocol';
import { errorText } from '../../shared/utils/errors';
import { WorkspaceService } from '../workspace.service';
import { RunsService } from './runs.service';

/** The end of a command's output, where test summaries are. */
function tail(output: string, lines: number): string {
  return output.trimEnd().split('\n').slice(-lines).join('\n');
}

/** What the agent is told when the project's check fails after its turn. */
export function fixMessage(command: string, r: CheckResult): string {
  const code = r.code === null ? 'bị dừng' : `mã ${r.code}`;
  return `Lệnh kiểm tra \`${command}\` của dự án báo lỗi (${code}). Hãy sửa cho đạt, đừng sửa hay bỏ qua test chỉ để qua. Phần cuối output:\n\`\`\`\n${tail(r.output, 60)}\n\`\`\``;
}

/**
 * Runs the project's check after each agent turn that changed files, and sends a failure
 * back to the agent a few times (Thiết lập dự án). A single-turn run (pipeline step) is
 * checked without a fix: its session has ended.
 */
@Injectable({ providedIn: 'root' })
export class CheckService {
  private readonly backend = inject(AgentBackend);
  private readonly runs = inject(RunsService);
  private readonly workspace = inject(WorkspaceService);
  /** The run's changes when its current turn began. */
  private readonly before = new Map<string, string>();
  /** Fix messages sent in a row; the user's own message starts over. */
  private readonly round = new Map<string, number>();
  private readonly sentFix = new Map<string, string>();
  /** Bumped by every new turn: a check that finishes after it is ignored. */
  private readonly ticket = new Map<string, number>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.backend.onEvent((e) => void this.on(e)).then(() => undefined);
  }

  rounds(runId: string): number {
    return this.round.get(runId) ?? 0;
  }

  private async on(e: AgentEvent): Promise<void> {
    if (e.kind === 'started' || e.kind === 'user') {
      if (e.kind === 'user') {
        const ours = this.sentFix.get(e.runId) === e.line;
        this.sentFix.delete(e.runId);
        if (!ours) this.round.set(e.runId, 0);
      }
      this.bump(e.runId);
      if (this.eligible(e.runId)) this.before.set(e.runId, await this.signature(e.runId));
      return;
    }
    if (e.kind !== 'turn_end' && e.kind !== 'exit') return;
    const status = (e.data as Record<string, unknown> | null)?.['status'];
    if (status !== 'done') return;
    await this.check(e.runId, e.kind === 'turn_end');
  }

  private eligible(runId: string): boolean {
    const run = this.runs.runs().find((r) => r.id === runId);
    return !!run && run.task && !run.parent && run.perm !== 'read';
  }

  private bump(runId: string): number {
    const t = (this.ticket.get(runId) ?? 0) + 1;
    this.ticket.set(runId, t);
    return t;
  }

  /** The run's changes as one string: equal strings, nothing changed. */
  private async signature(runId: string): Promise<string> {
    try {
      const files = await this.backend.getDiff(runId);
      return files.map((f) => `${f.path}:${f.hunks.map((h) => h.id).join(',')}`).sort().join('|');
    } catch {
      return '';
    }
  }

  private async check(runId: string, canFix: boolean): Promise<void> {
    if (!this.eligible(runId)) return;
    const run = this.runs.runs().find((r) => r.id === runId)!;
    const after = await this.signature(runId);
    const before = this.before.get(runId) ?? '';
    this.before.set(runId, after);
    if (after === before) return;
    const root = run.project || this.workspace.project()?.root;
    if (!root) return;
    let settings;
    try {
      settings = await this.backend.projectSettings(root);
    } catch {
      return; // the project is not open in this window
    }
    const command = settings.check.trim();
    if (!command) return;
    const t = this.bump(runId);
    const key = `check:${runId}:${t}`;
    const label = `Kiểm tra \`${command}\``;
    this.runs.note(runId, `${label}: đang chạy…`, key);
    let result: CheckResult | null;
    try {
      result = await this.backend.runProjectCheck(runId);
    } catch (e) {
      this.runs.note(runId, `${label}: không chạy được (${errorText(e)})`, key);
      return;
    }
    if (this.ticket.get(runId) !== t) {
      this.runs.note(runId, `${label}: bỏ qua, bạn đã gửi câu mới`, key);
      return;
    }
    if (!result) return this.runs.note(runId, `${label}: dự án không còn lệnh kiểm tra`, key);
    const secs = Math.round(result.durationMs / 1000);
    if (result.code === 0) {
      this.round.set(runId, 0);
      return this.runs.note(runId, `${label}: đạt (${secs} s)`, key);
    }
    const code = result.code === null ? 'bị dừng' : `mã ${result.code}`;
    const summary = tail(result.output, 3).split('\n').map((l) => l.trim()).filter(Boolean).join(' · ');
    this.runs.note(runId, `${label}: hỏng (${code})${summary ? ` — ${summary}` : ''}`, key);
    if (!canFix || !settings.autoFix) return;
    const n = this.rounds(runId);
    if (n >= settings.maxFixRounds) {
      this.runs.note(runId, `Đã thử ${n} lần, vẫn hỏng. Bạn xem giúp.`);
      return;
    }
    this.round.set(runId, n + 1);
    const message = fixMessage(command, result);
    this.sentFix.set(runId, message);
    try {
      await this.backend.sendMessage(runId, message);
    } catch (e) {
      this.sentFix.delete(runId);
      this.runs.note(runId, `Không gửi được lỗi cho agent: ${errorText(e)}`);
    }
  }
}
