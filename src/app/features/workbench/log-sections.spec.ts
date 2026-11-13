import { Run } from '../../services/runs/run';
import { filterSections, logSections, logText, sectionTitle } from './log-sections';

const run = (over: Partial<Run>): Run => ({
  id: 'r', agent: 'claude', prompt: '', cwd: '/a', startedAt: 1, endedAt: null, status: 'done', lines: [], usage: null, exitCode: null, restored: false,
  task: true, permissions: [], lastMessage: '', group: null, thread: 't', project: '/a', scope: null, waits: [], plan: [], progress: null, ...over,
});

describe('conversation log', () => {
  const runs = [
    run({ id: 'main', prompt: 'Sửa tiêu đề\n\n📎 /x/a.png', startedAt: 10, lines: [
      { text: '› npm test', tone: 'tool' }, { text: 'Thêm test nữa', tone: 'user' }, { text: '2 test hỏng', tone: 'error' }] }),
    run({ id: 'later', agent: 'codex', prompt: 'Đổi sang Codex', startedAt: 40, lines: [{ text: 'xong', tone: 'text' }] }),
    run({ id: 'kid', agent: 'kiro', parent: 'main', prompt: 'Viết test cho tiêu đề', startedAt: 20, lines: [{ text: '› sửa app.spec.ts', tone: 'tool' }] }),
    run({ id: 'main~1', parent: 'main', prompt: 'Tìm tệp', startedAt: 30 }),
    run({ id: 'other', thread: 'x', startedAt: 15 }),
  ];

  it('puts every run of the conversation in one log, nested runs right after their parent', () => {
    const sections = logSections(runs, 't');
    expect(sections.map((s) => [s.run.id, s.role])).toEqual([['main', 'main'], ['kid', 'delegate'], ['main~1', 'subagent'], ['later', 'main']]);
    expect(sections[0].entries[0]).toEqual({ kind: 'user', text: 'Sửa tiêu đề', files: 1 });
    expect(sections[0].entries[2]).toEqual({ kind: 'user', text: 'Thêm test nữa', files: 0 });
    expect(sectionTitle(sections[1])).toBe('Claude Code giao cho Kiro CLI');
    expect(sectionTitle(sections[2])).toBe('Subagent của Claude Code');
    expect(logSections(runs, null)).toEqual([]);
  });

  it('filters by agent, errors and words without changing the conversation', () => {
    const sections = logSections(runs, 't');
    expect(filterSections(sections, { agent: 'kiro', errorsOnly: false, query: '' }).map((s) => s.run.id)).toEqual(['kid']);
    const errors = filterSections(sections, { agent: null, errorsOnly: true, query: '' });
    expect(errors.map((s) => s.run.id)).toEqual(['main']);
    expect(errors[0].entries).toHaveLength(1);
    expect(filterSections(sections, { agent: null, errorsOnly: false, query: 'APP.SPEC' }).map((s) => s.run.id)).toEqual(['kid']);
  });

  it('copies as plain text with who said what', () => {
    const text = logText(logSections(runs, 't'));
    expect(text).toContain('## Claude Code giao cho Kiro CLI');
    expect(text).toContain('Việc: Viết test cho tiêu đề');
    expect(text).toContain('> Bạn: Sửa tiêu đề (1 tệp đính kèm)');
    expect(text).toContain('2 test hỏng');
  });
});
