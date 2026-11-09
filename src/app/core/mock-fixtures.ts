import { AgentId, FileDiff, LimitWindow, Skill } from './protocol';

/** Demo data for the mock backend: a small project, the agent's edits to it, plan limits. */

export function mockDiff(agent: AgentId = 'claude'): FileDiff[] {
  // Ranges come from the header, like the core's parser.
  const hunk = (id: string, header: string, lines: string[]) => {
    const [, oldStart, oldLines, newStart, newLines] = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(header)!.map(Number);
    return {
      id, header, oldStart, oldLines, newStart, newLines, lines,
      added: lines.filter((l) => l.startsWith('+')).length,
      removed: lines.filter((l) => l.startsWith('-')).length,
    };
  };
  return [
    {
      path: 'src/app/app.ts', status: 'M', binary: false, patchHeader: '',
      hunks: [
        hunk('h1', '@@ -10,3 +10,4 @@ export class App', [' export class App {', '-  title = "cũ";', `+  title = "mới (${agent})";`, '+  ready = true;', ' }']),
        hunk('h2', '@@ -40,2 +41,2 @@ export function retries', [' export function retries(): number {', '-  return 1;', '+  return 2;']),
      ],
    },
    ...(agent === 'codex' ? [] : [{
      path: 'docs/ghi chú mới.md', status: 'A', binary: false, patchHeader: '',
      hunks: [hunk('h3', '@@ -0,0 +1,2 @@', ['+# Ghi chú', '+Nội dung mới'])],
    }]),
  ];
}

/**
 * Worktree contents. `edited` matches `mockDiff(agent)`: new lines 11–12 and 42 of
 * app.ts are the agent's. Before the edit the worktree equals the base commit.
 */
export function mockContents(agent: AgentId, edited: boolean): Map<string, string> {
  // Plausible code around the two places the agent changes (lines 10–13 and 41–43).
  const app = [
    "import { Session, verify } from './auth';",
    "import { Retry } from './retry';",
    '',
    '/** Trang chủ của ứng dụng demo. */',
    "const DEFAULT_TITLE = 'TG Studio demo';",
    '',
    'interface AppState {',
    '  user: Session | null;',
    '}',
    'export class App {', '  title = "cũ";', '  ready = false;', '}',
    '',
    'export function greet(state: AppState): string {',
    "  return state.user ? `Xin chào, ${state.user.name}` : 'Xin chào';",
    '}',
    '',
    'export async function login(token: string): Promise<AppState> {',
    '  const user = await verify(token);',
    '  if (!user) {',
    "    throw new Error('Phiên đăng nhập hết hạn');",
    '  }',
    '  return { user };',
    '}',
    '',
    'export function logout(): AppState {',
    '  return { user: null };',
    '}',
    '',
    '/** Chờ lâu dần khi mạng chập chờn: 2s, 4s, 8s… tối đa 30s. */',
    'export function backoff(attempt: number): number {',
    '  return Math.min(1000 * 2 ** attempt, 30_000);',
    '}',
    '',
    'export function title(): string {',
    '  return DEFAULT_TITLE;',
    '}',
    '',
    '// Số lần thử lại khi đăng nhập',
    'export function retries(): number {', '  return 1;', '}',
    '',
    'export const retry = new Retry(retries(), backoff);',
    '',
    'export function ready(app: App): boolean {',
    '  return app.ready;',
    '}',
  ];
  app.splice(9, 4, 'export class App {', `  title = "mới (${agent})";`, '  ready = true;', '}');
  app.splice(40, 3, 'export function retries(): number {', '  return 2;', '}');
  if (!edited) {
    app.splice(10, 2, '  title = "cũ";');
    app[app.indexOf('  return 2;')] = '  return 1;';
  }
  const files: [string, string][] = [
    ['README.md', '# Demo\n\nRepo mô phỏng cho chế độ trình duyệt.\n'],
    ['package.json', '{\n  "name": "demo",\n  "private": true\n}\n'],
    ['src/app/app.ts', app.join('\n') + '\n'],
  ];
  if (edited && agent !== 'codex') files.push(['docs/ghi chú mới.md', '# Ghi chú\nNội dung mới\n']);
  return new Map(files);
}

/** Claude-style plan windows, so the limits panel has something to show in the browser. */
export function mockLimits(): { windows: LimitWindow[] } {
  const now = Date.now();
  return { windows: [
    { id: 'five_hour', utilization: 0.42, resetsAt: now + 2.5 * 3_600_000, status: 'allowed' },
    { id: 'seven_day', utilization: 0.18, resetsAt: now + 4 * 86_400_000, status: 'allowed' },
  ] };
}

/**
 * Used when the UI runs in a normal browser (`npm start`), so you can build
 * screens without launching the desktop app. Emits a fake but realistic run.
 */
export function parseSkill(content: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) throw new Error('SKILL.md phải bắt đầu bằng front matter (---).');
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1])?.[1].trim().replace(/^"|"$/g, '') ?? '';
  const name = field('name');
  const description = field('description');
  if (!name) throw new Error('Front matter thiếu name.');
  if (!description) throw new Error('Front matter thiếu description.');
  return { name, description, content };
}
