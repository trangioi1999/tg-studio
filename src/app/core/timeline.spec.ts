import { ConsoleLine } from './describe-line';
import { segmentsOf } from './timeline';

const L = (tone: ConsoleLine['tone'], text: string): ConsoleLine => ({ tone, text });

describe('segmentsOf', () => {
  it('drops protocol noise and groups tool calls between messages', () => {
    const lines = [
      L('muted', 'C:\\Users\\me\\npm\\claude.cmd -p …'),
      L('muted', '● hook_progress'),
      L('muted', '● init'),
      L('muted', '[thinking_tokens]'),
      L('tool', '› Read package.json ✓'),
      L('tool', '› Bash ng version ✕'),
      L('text', 'Dự án dùng **Angular 21**.'),
      L('ok', '✓ success'),
      L('user', 'Nâng cấp đi'),
      L('tool', '› Edit package.json'),
    ];
    expect(segmentsOf(lines, false)).toEqual([
      { kind: 'work', steps: [{ text: 'Read package.json', state: 'done' }, { text: 'Bash ng version', state: 'failed' }], failed: 1, live: false },
      { kind: 'text', text: 'Dự án dùng **Angular 21**.' },
      { kind: 'user', text: 'Nâng cấp đi' },
      { kind: 'work', steps: [{ text: 'Edit package.json', state: 'done' }], failed: 0, live: false },
    ]);
  });

  it('marks the trailing step as in progress while the run works', () => {
    const segs = segmentsOf([L('tool', '› Read a.ts ✓'), L('tool', '› Edit a.ts')], true);
    expect(segs).toEqual([{ kind: 'work', steps: [{ text: 'Read a.ts', state: 'done' }, { text: 'Edit a.ts', state: 'running' }], failed: 0, live: true }]);
    // A message after the tools means the work log is finished.
    expect(segmentsOf([L('tool', '› Read a.ts'), L('text', 'xong')], true)[0]).toMatchObject({ live: false, steps: [{ state: 'done' }] });
  });

  it('keeps notes from the core inside the work log', () => {
    expect(segmentsOf([L('error', 'Đang chuẩn bị adapter.')], false)).toEqual([
      { kind: 'work', steps: [{ text: 'Đang chuẩn bị adapter.', state: 'note' }], failed: 0, live: false },
    ]);
  });
});
