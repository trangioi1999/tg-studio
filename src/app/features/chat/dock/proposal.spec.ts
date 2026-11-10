import { planProposal } from './proposal';

const write = (path: string, content = '# Đổi a.txt\n\n- Ghi đè thành `xin chào`') =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path, content } }] } });

describe('planProposal', () => {
  it('takes the plan Claude writes to its plans folder while it may not edit', () => {
    expect(planProposal('claude', write('/Users/a/.claude/plans/doi-a-txt.md'))).toContain('xin chào');
    expect(planProposal('claude', write('C:\\Users\\a\\.claude\\plans\\doi-a-txt.md'))).toContain('xin chào');
  });

  it('takes an ExitPlanMode plan', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'Bước 1' } }] } });
    expect(planProposal('claude', line)).toBe('Bước 1');
  });

  it('ignores other writes, other agents and plain text', () => {
    expect(planProposal('claude', write('/repo/src/a.ts'))).toBeNull();
    expect(planProposal('codex', write('/Users/a/.claude/plans/x.md'))).toBeNull();
    expect(planProposal('claude', 'Đang đọc tệp…')).toBeNull();
    expect(planProposal('claude', '{"type":"tool_use" broken')).toBeNull();
  });
});
