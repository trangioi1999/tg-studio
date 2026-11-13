import { delegateMessage } from './handoff-cards';

describe('handoff cards', () => {
  it('asks the proposing agent to delegate the task instead of moving the conversation', () => {
    const text = delegateMessage({ id: 'h', runId: 'r', from: 'claude', agent: 'kiro', task: 'Viết test cho tiêu đề', files: ['src/app.spec.ts'], at: 0 });
    expect(text).toContain('Đừng chuyển cuộc trò chuyện');
    expect(text).toContain('tool delegate');
    expect(text).toContain('agent: "kiro"');
    expect(text).toContain('wait_delegated');
    expect(text).toContain('Viết test cho tiêu đề');
    expect(text).toContain('src/app.spec.ts');
  });
});
