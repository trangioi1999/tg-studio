import { UserMessage } from './user-message';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { JsonValue } from '../../../core/protocol';
import { TestBed } from '@angular/core/testing';
import { toolHead, miniDiff, resultLine, middleTruncate } from './tool-step';
import { segmentsOf } from './timeline';
import { ChatTurn } from './chat-turn';
import { ChatState } from '../chat.state';
import { Delegations } from './delegations';
import { Run } from '../../../services/runs/run';
import { applyEvent } from '../../../services/runs/run-events';

const path = 'src/app/features/chat/conversation/very/deep/folder/SiteLayout.astro';
const change = (oldText = 'x\nPlugins\n', newText = 'x\nMarketplace\n') => ({ content: [{ type: 'diff', path, oldText, newText }] });
const base = (): Run => ({ id: 'r', agent: 'claude', prompt: '', cwd: '', startedAt: 0, endedAt: 1, status: 'done', lines: [], usage: null, exitCode: 0, restored: false, task: true, permissions: [], lastMessage: '', group: null, thread: 'r', project: '', scope: null, waits: [], plan: [], progress: null });

describe('Dòng công cụ CLI', () => {
  it('lấy tên và đối số theo thứ tự ưu tiên', () => {
    expect(toolHead({ kind: 'execute', rawInput: { command: 'npm test' } })).toEqual({ name: 'Bash', arg: 'npm test' });
    expect(toolHead({ _meta: { claudeCode: { toolName: 'Grep' } }, rawInput: { pattern: 'Plugins' } })).toEqual({ name: 'Grep', arg: 'Plugins' });
    expect(toolHead({ kind: 'execute', rawInput: { command: ['npm', 'test'], path: 'a' } }).arg).toBe('npm test');
    expect(toolHead({ kind: 'read', locations: [{ path }] })).toEqual({ name: 'Read', arg: path });
    expect(toolHead({ title: 'Công cụ khác' })).toEqual({ name: 'Công cụ khác', arg: null });
  });
  it('chỉ lấy dòng thay đổi, giữ các dòng chung ở giữa', () => {
    expect(miniDiff(change())).toEqual({ path, added: 1, removed: 1, lines: [{ sign: '-', text: 'Plugins' }, { sign: '+', text: 'Marketplace' }], more: 0 });
    expect(miniDiff(change('a\ngiữ\nb\n', 'c\ngiữ\nd\n'))).toMatchObject({ added: 2, removed: 2 });
    expect(miniDiff({})).toBeNull();
  });
  it('lấy dòng kết quả cuối khác rỗng và giới hạn 120 ký tự', () => {
    expect(resultLine({ content: [{ type: 'content', content: { type: 'text', text: '212 dòng\n' } }] })).toBe('212 dòng');
    expect(resultLine({ content: [{ type: 'text', text: 'a\n' + 'b'.repeat(200) + '\n' }] })?.length).toBeLessThanOrEqual(120);
    expect(resultLine(change())).toBeNull();
  });
  it('long_path_is_middle_truncated', () => {
    const text = middleTruncate(path, 40);
    expect(text.length).toBeLessThanOrEqual(40);
    expect(text.endsWith('SiteLayout.astro')).toBe(true);
    expect(text).toContain('…');
    expect(middleTruncate('a.ts', 40)).toBe('a.ts');
  });
  it('mini_diff_is_capped', () => {
    expect(miniDiff(change('', Array.from({ length: 400 }, (_, i) => `dòng ${i}`).join('\n') + '\n'))).toMatchObject({ added: 400, removed: 0, more: 394 });
    expect(miniDiff(change('', 'a\n'.repeat(400)))?.lines).toHaveLength(6);
  });
  it('giữ dữ liệu qua cập nhật trạng thái, giữ text/label cũ và chuyển lỗi sang bước lỗi', () => {
    const event = (run: Run, data: Record<string, unknown>) => applyEvent(run, { runId: 'r', agent: 'claude', kind: 'tool', atMs: 0, line: null, usage: null, code: null, data: data as JsonValue }, { stopping: false }).run;
    let run = event(base(), { toolCallId: 't', title: 'Sửa tệp', kind: 'edit', rawInput: { file_path: path }, ...change() });
    run = event(run, { toolCallId: 't', status: 'failed' });
    expect(run.lines[0]).toMatchObject({ text: '› Sửa tệp ✕', label: 'Sửa tệp', head: { name: 'Update', arg: path }, diff: { added: 1 } });
    expect(segmentsOf(run.lines, false)[0]).toMatchObject({ kind: 'work', failed: 1, steps: [{ state: 'failed', head: { name: 'Update', arg: path }, diff: { added: 1 } }] });
  });
  it('giữ cấu trúc dòng cũ khi event chỉ có tiêu đề', () => {
    const run = applyEvent(base(), { runId: 'r', agent: 'claude', kind: 'tool', atMs: 0, line: null, usage: null, code: null, data: { toolCallId: 't', title: 'Chạy test', status: 'completed' } }, { stopping: false }).run;
    expect(run.lines).toEqual([{ key: 'tool:t', label: 'Chạy test', text: '› Chạy test ✓', tone: 'tool' }]);
  });
  it('hiện ba bước cuối, gộp hai bước trước và giữ title đầy đủ', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: ChatState, useValue: { runs: { now: () => 1 } } }] });
    TestBed.overrideComponent(ChatTurn, { remove: { imports: [Delegations, UserMessage] }, add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] } });
    const fixture = TestBed.createComponent(ChatTurn);
    const run = base();
    run.lines = Array.from({ length: 5 }, () => ({ text: '› Sửa tệp ✓', tone: 'tool' as const, head: { name: 'Update', arg: path }, diff: miniDiff(change('', 'a\n'.repeat(400)))! }));
    expect(segmentsOf(run.lines, false)[0]).toMatchObject({ steps: run.lines.map(l => ({ head: l.head, diff: l.diff })) });
    fixture.componentRef.setInput('run', run);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect([...el.querySelectorAll('.cl-step')].filter(e => !e.closest('details'))).toHaveLength(3);
    const earlier = el.querySelector('details')!;
    expect(earlier.open).toBe(false);
    expect(earlier.querySelector('summary')?.textContent).toContain('2 bước trước');
    expect(earlier.querySelectorAll('.cl-step')).toHaveLength(2);
    expect(el.querySelector('.cl-arg')?.getAttribute('title')).toBe(path);
    expect(el.querySelector('.cl-arg')?.textContent).toContain('…');
    expect(el.querySelector('.cl-step')?.textContent).toContain('… và 394 dòng nữa');
    expect(el.querySelector('.cl-step')?.textContent).toContain('+400 −0');
    expect(el.querySelectorAll('.cl-step')[0].querySelectorAll('.cl-diff-line')).toHaveLength(6);
  });
});
