import { TestBed } from '@angular/core/testing';
import { AgentBackend } from './backend';
import { MockBackend } from './mock-backend';
import { DEFAULT_TEMPLATES, PipelineService, diffText, render } from './pipeline.service';
import { RunsService } from './runs.service';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RecordingBackend extends MockBackend {
  calls: { agent: string; prompt: string; reuse: string | null }[] = [];
  override startTask(agent: Parameters<MockBackend['startTask']>[0], prompt: string, repo: string, group: string | null = null, reuse: string | null = null, singleTurn = false) {
    this.calls.push({ agent, prompt, reuse });
    return super.startTask(agent, prompt, repo, group, reuse, singleTurn);
  }
}

describe('PipelineService', () => {
  function setup() {
    const backend = new RecordingBackend();
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
    return { backend, runs: TestBed.inject(RunsService), pipelines: TestBed.inject(PipelineService) };
  }
  async function approveCurrent(runs: RunsService) {
    await wait(300);
    const r = runs.selected()!;
    await runs.respondPermission(r.id, r.permissions[0].requestId, 'allow', false);
    await wait(800);
  }

  it('runs steps in order in one worktree, passing message and diff along', async () => {
    const { backend, runs, pipelines } = setup();
    const p = await pipelines.start('Đổi tiêu đề', '/repo', [
      { name: 'Plan', agent: 'claude', template: DEFAULT_TEMPLATES.plan },
      { name: 'Build', agent: 'codex', template: DEFAULT_TEMPLATES.build },
      { name: 'Review', agent: 'gemini', template: DEFAULT_TEMPLATES.review },
    ]);
    expect(runs.selected()!.prompt).toBe('Plan · Đổi tiêu đề');
    for (let i = 0; i < 3; i++) await approveCurrent(runs);
    const done = pipelines.pipelines()[0];
    expect(done.status).toBe('done');
    expect(done.runIds.every(Boolean)).toBe(true);
    expect(backend.calls.map((c) => [c.agent, c.reuse])).toEqual([['claude', null], ['codex', done.runIds[0]], ['gemini', done.runIds[1]]]);
    expect(backend.calls[0].prompt).toContain('Yêu cầu: Đổi tiêu đề');
    // Build gets the plan; Review gets the worktree's diff.
    expect(backend.calls[1].prompt).toContain('fix: sửa lỗi theo yêu cầu');
    expect(backend.calls[2].prompt).toContain('@@ -10,3 +10,4 @@');
    expect(pipelines.of(done.runIds[1])).toEqual({ pipeline: done, step: 1 });
    expect(pipelines.of('nope')).toBeNull();
    expect(p.id).toBe(done.id);
  });

  it('stops when a step is stopped', async () => {
    const { runs, pipelines } = setup();
    await pipelines.start('x', '/repo', [
      { name: 'Plan', agent: 'claude', template: '{{task}}' },
      { name: 'Build', agent: 'codex', template: '{{task}}' },
    ]);
    await wait(300);
    await runs.stop(runs.selected()!.id);
    await wait(50);
    expect(pipelines.pipelines()[0].status).toBe('stopped');
    expect(pipelines.pipelines()[0].runIds[1]).toBeNull();
  });

  it('renders templates and summarizes diffs', () => {
    expect(render('{{task}} | {{previous}} | {{diff}} | {{other}}', { task: 'a', previous: 'b', diff: 'c' })).toBe('a | b | c | {{other}}');
    expect(diffText([])).toBe('(không có thay đổi)');
    const big = diffText([{ path: 'a', status: 'M', binary: false, patchHeader: 'diff --git a/a b/a\n', hunks: [{ id: 'h', header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+' + 'x'.repeat(40_000)], added: 1, removed: 0 }] }]);
    expect(big).toContain('đã cắt');
    expect(big.length).toBeLessThan(31_000);
  });
});
