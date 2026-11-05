import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { AgentId, Approval, FileDiff, Place } from './protocol';
import { Run, RunsService } from './runs.service';

export interface PipelineStep {
  name: string;
  agent: AgentId;
  /** {{task}}, {{previous}} (last message of the step before) and {{diff}} are filled in. */
  template: string;
}

export type PipelineStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface Pipeline {
  id: string;
  task: string;
  repo: string;
  steps: PipelineStep[];
  /** Run of each step once started. */
  runIds: (string | null)[];
  current: number;
  status: PipelineStatus;
  error: string | null;
}

export const DEFAULT_TEMPLATES = {
  plan: 'Bước Plan. Đọc code liên quan và lập kế hoạch ngắn gọn, đánh số từng bước, cho yêu cầu dưới đây. KHÔNG sửa tệp nào.\n\nYêu cầu: {{task}}',
  build: 'Bước Build. Thực hiện yêu cầu dưới đây theo kế hoạch của bước trước. Không commit.\n\nYêu cầu: {{task}}\n\nKế hoạch của bước trước:\n{{previous}}',
  review: 'Bước Review. Review các thay đổi chưa commit trong thư mục này cho yêu cầu dưới đây: lỗi, trường hợp biên, test còn thiếu. Chỉ nhận xét, KHÔNG sửa tệp.\n\nYêu cầu: {{task}}\n\nDiff:\n{{diff}}',
};

const DIFF_LIMIT = 30_000;

/** Unified diff text of a run's pending changes, cut to a size an agent prompt can carry. */
export function diffText(files: FileDiff[]): string {
  const text = files.map((f) => f.patchHeader + f.hunks.map((h) => `${h.header}\n${h.lines.join('\n')}\n`).join('')).join('');
  if (!text.trim()) return '(không có thay đổi)';
  return text.length > DIFF_LIMIT ? `${text.slice(0, DIFF_LIMIT)}\n… (đã cắt, diff dài hơn ${DIFF_LIMIT} ký tự)` : text;
}

export function render(template: string, vars: { task: string; previous: string; diff: string }): string {
  return template.replace(/\{\{(task|previous|diff)\}\}/g, (_, k: keyof typeof vars) => vars[k]);
}

/**
 * Runs steps one after another in one worktree: each step starts when the previous
 * one finishes, and gets its last message and the worktree's diff in its prompt.
 */
@Injectable({ providedIn: 'root' })
export class PipelineService {
  private readonly runs = inject(RunsService);
  readonly pipelines = signal<Pipeline[]>([]);
  private advancing = new Set<string>();

  constructor() {
    effect(() => {
      const runs = this.runs.runs();
      const live = this.pipelines().filter((p) => p.status === 'running');
      untracked(() => live.forEach((p) => void this.check(p, runs)));
    });
  }

  /** `place`/`base` decide where the first step works; later steps continue there. */
  private readonly where = new Map<string, { place?: Place; base?: string | null; approval?: Approval }>();

  async start(task: string, repo: string, steps: PipelineStep[], opts: { place?: Place; base?: string | null; approval?: Approval } = {}): Promise<Pipeline> {
    if (!steps.length) throw new Error('Pipeline cần ít nhất một bước.');
    const p: Pipeline = { id: crypto.randomUUID(), task, repo, steps, runIds: steps.map(() => null), current: 0, status: 'running', error: null };
    this.where.set(p.id, opts);
    this.pipelines.update((list) => [p, ...list]);
    await this.launch(p.id, 0);
    return this.get(p.id)!;
  }

  /** The pipeline a run belongs to, with the run's step index. */
  of(runId: string | null | undefined): { pipeline: Pipeline; step: number } | null {
    if (!runId) return null;
    for (const pipeline of this.pipelines()) {
      const step = pipeline.runIds.indexOf(runId);
      if (step >= 0) return { pipeline, step };
    }
    return null;
  }

  private get(id: string): Pipeline | undefined {
    return this.pipelines().find((p) => p.id === id);
  }

  private patch(id: string, change: Partial<Pipeline>): void {
    this.pipelines.update((list) => list.map((p) => (p.id === id ? { ...p, ...change } : p)));
  }

  private async check(p: Pipeline, runs: Run[]): Promise<void> {
    const runId = p.runIds[p.current];
    const run = runId ? runs.find((r) => r.id === runId) : null;
    if (!run || run.status === 'running' || this.advancing.has(p.id)) return;
    if (run.status !== 'done') {
      this.patch(p.id, { status: run.status === 'stopped' ? 'stopped' : 'failed', error: run.status === 'stopped' ? null : `Bước ${p.steps[p.current].name} không hoàn tất.` });
      return;
    }
    if (p.current + 1 >= p.steps.length) {
      this.patch(p.id, { status: 'done' });
      return;
    }
    this.advancing.add(p.id);
    try {
      await this.launch(p.id, p.current + 1);
    } finally {
      this.advancing.delete(p.id);
    }
  }

  private async launch(id: string, index: number): Promise<void> {
    const p = this.get(id)!;
    const step = p.steps[index];
    const previousId = index > 0 ? p.runIds[index - 1] : null;
    const previous = previousId ? this.runs.runs().find((r) => r.id === previousId) : null;
    try {
      const diff = previousId ? diffText(await this.runs.getDiff(previousId)) : '(chưa có thay đổi)';
      const prompt = render(step.template, { task: p.task, previous: previous?.lastMessage || '(bước trước không để lại tin nhắn)', diff });
      this.patch(id, { current: index });
      const where = this.where.get(id) ?? {};
      const runId = await this.runs.startTask(step.agent, prompt, p.repo, { singleTurn: true, thread: id, reuse: previousId ?? undefined, title: `${step.name} · ${p.task}`, place: where.place, base: where.base, approval: where.approval });
      this.patch(id, { runIds: this.get(id)!.runIds.map((r, i) => (i === index ? runId : r)) });
    } catch (e) {
      this.patch(id, { status: 'failed', error: `Không chạy được bước ${step.name}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
}
