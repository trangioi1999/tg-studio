import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AgentBackend } from '../core/backend';
import { AgentsService } from '../agents/agents.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { AgentCommand, AgentId, McpServer } from '../core/protocol';
import { Integrations } from './integrations';

const server: McpServer = {
  id: 'one',
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server'],
  env: [{ name: 'TOKEN', value: 'old=secret' }],
  headers: [],
  url: null,
  agents: ['claude'],
};
const command = (name: string): AgentCommand => ({
  name,
  description: 'Mô tả từ agent',
  kind: 'skill',
  source: 'user',
  plugin: null,
  hint: null,
  insert: name + ' ',
});

async function setup() {
  const backend = {
    getSetting: vi.fn().mockResolvedValue(null),
    listMcpServers: vi.fn().mockResolvedValue([server]),
    listSkills: vi
      .fn()
      .mockResolvedValue([{ name: 'review', description: 'Mô tả thư viện', content: 'skill' }]),
    skillTargets: vi
      .fn()
      .mockResolvedValue([{ scope: 'user', path: '/skills/review', state: 'same' }]),
    saveMcpServer: vi.fn().mockImplementation(async (s: McpServer) => s),
    deleteMcpServer: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: AgentBackend, useValue: backend },
      {
        provide: WorkspaceService,
        useValue: { repo: signal(null), folder: signal('/demo/my project') },
      },
      {
        provide: AgentsService,
        useValue: {
          agents: signal([
            { id: 'claude', path: '/claude' },
            { id: 'codex', path: '/codex' },
          ]),
          commandsFor: (a: AgentId) =>
            a === 'claude'
              ? [command('review'), command('extra')]
              : [command('$review'), command('$extra')],
          loadCommands: vi.fn().mockResolvedValue(undefined),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(Integrations);
  fixture.detectChanges();
  await vi.waitFor(() => expect(backend.skillTargets).toHaveBeenCalled());
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const click = (text: string, within: HTMLElement = root) => {
    const button = [...within.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    );
    expect(button, text).toBeTruthy();
    button!.click();
    fixture.detectChanges();
  };
  return { backend, fixture, root, click };
}

describe('Integrations', () => {
  it('merges skills by bare name across agents and filters agent-only rows', async () => {
    const { fixture, root, click } = await setup();
    root.querySelector<HTMLButtonElement>('#conn-skills-tab')!.click();
    fixture.detectChanges();
    const rows = root.querySelectorAll('.conn-skill-row:not(.conn-skill-head)');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Mô tả thư viện');
    expect(rows[0].querySelectorAll('.tag.ok').length).toBe(3);
    expect(rows[1].textContent).toContain('Mô tả từ agent');
    click('Chỉ agent thấy');
    expect(root.querySelectorAll('.conn-skill-row:not(.conn-skill-head)').length).toBe(1);
    expect(root.querySelector('.conn-seen-only')?.textContent).toContain('extra');
  });

  it('requires an inline confirmation before deleting a server', async () => {
    const { backend, fixture, root, click } = await setup();
    click('Xoá');
    expect(backend.deleteMcpServer).not.toHaveBeenCalled();
    click('Huỷ', root.querySelector<HTMLElement>('.conn-confirm')!);
    expect(backend.deleteMcpServer).not.toHaveBeenCalled();
    click('Xoá');
    click('Xoá', root.querySelector<HTMLElement>('.conn-confirm')!);
    await fixture.whenStable();
    expect(backend.deleteMcpServer).toHaveBeenCalledWith('one');
  });

  it('keeps environment values intact and discards cancelled edits', async () => {
    const { backend, fixture, root, click } = await setup();
    click('Sửa');
    const value = root.querySelector<HTMLInputElement>('input[type=password]')!;
    expect(value.value).toBe('old=secret');
    value.value = 'new=secret with spaces';
    value.dispatchEvent(new Event('input'));
    click('Huỷ');
    expect(server.env[0].value).toBe('old=secret');
    expect(backend.saveMcpServer).not.toHaveBeenCalled();
    click('Filesystem');
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    expect(backend.saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/demo/my project'],
      }),
    );
  });
});
