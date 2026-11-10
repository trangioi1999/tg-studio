import { AgentCommand } from '../../core/protocol';
import { commandQuery, filterCommands, insertCommand } from './commands';

const c = (name: string, kind: AgentCommand['kind'], source: AgentCommand['source'], insert = `/${name} `, description = ''): AgentCommand =>
  ({ name, description, kind, source, plugin: null, hint: null, insert });

const claude = [
  c('compact', 'command', null),
  c('superpowers:writing-plans', 'skill', 'plugin'),
  c('formflow-init', 'skill', 'user'),
  c('release-notes', 'skill', 'project', '/release-notes ', 'Viết ghi chú phát hành'),
];

describe('commandQuery', () => {
  it('opens on "/" at the start only', () => {
    expect(commandQuery('/rel', 4, 'claude')).toEqual({ trigger: '/', start: 0, query: 'rel' });
    expect(commandQuery('  /', 3, 'claude')).toEqual({ trigger: '/', start: 2, query: '' });
    expect(commandQuery('sửa a/b', 7, 'claude')).toBeNull();
    expect(commandQuery('làm /rel', 8, 'claude')).toBeNull();
    expect(commandQuery('/rel xong', 9, 'claude')).toBeNull();
  });

  it('opens on "$" anywhere, for Codex only', () => {
    expect(commandQuery('dùng $doc', 9, 'codex')).toEqual({ trigger: '$', start: 5, query: 'doc' });
    expect(commandQuery('dùng $doc', 9, 'claude')).toBeNull();
  });
});

describe('filterCommands', () => {
  it('groups project skills first, then the machine, plugins and commands', () => {
    const groups = filterCommands(claude, { trigger: '/', start: 0, query: '' });
    expect(groups.map((g) => g.group)).toEqual(['project', 'user', 'plugin', 'command']);
  });

  it('matches the name, the part after a plugin prefix, or the description', () => {
    const names = (q: string) => filterCommands(claude, { trigger: '/', start: 0, query: q }).flatMap((g) => g.items.map((i) => i.name));
    expect(names('writ')).toEqual(['superpowers:writing-plans']);
    expect(names('phát hành')).toEqual(['release-notes']);
    expect(names('zzz')).toEqual([]);
    expect(names('p')).toEqual(['superpowers:writing-plans', 'compact']);
  });

  it('shows Codex skills for "$" and its commands for "/"', () => {
    const codex = [c('$doc', 'skill', 'project', '$doc '), c('plan', 'command', null, '/plan ')];
    expect(filterCommands(codex, { trigger: '$', start: 0, query: '' }).flatMap((g) => g.items.map((i) => i.name))).toEqual(['$doc']);
    expect(filterCommands(codex, { trigger: '/', start: 0, query: '' }).flatMap((g) => g.items.map((i) => i.name))).toEqual(['plan']);
  });
});

describe('insertCommand', () => {
  it('replaces the typed word and keeps the rest', () => {
    const q = commandQuery('/rel', 4, 'claude')!;
    expect(insertCommand('/rel', 4, q, claude[3])).toEqual({ text: '/release-notes ', caret: 15 });
    const q2 = commandQuery('dùng $do cho a.docx', 8, 'codex')!;
    expect(insertCommand('dùng $do cho a.docx', 8, q2, c('$documents', 'skill', 'plugin', '$documents ')).text).toBe('dùng $documents cho a.docx');
  });
});
