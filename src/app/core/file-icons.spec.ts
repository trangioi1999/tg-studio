import { describe, expect, it } from 'vitest';
import { IconManifest, iconId, iconUrl } from './file-icons';

const m: IconManifest = {
  iconDefinitions: { 'angular-component': { iconPath: './../icons/angular-component.svg' }, typescript: { iconPath: './../icons/typescript.svg' } },
  folderNames: { services: 'folder-controller', components: 'folder-components' },
  folderNamesExpanded: { services: 'folder-controller-open' },
  fileExtensions: { 'component.ts': 'angular-component', 'spec.ts': 'test-ts', ts: 'typescript' },
  fileNames: { 'package.json': 'nodejs', '.gitignore': 'git' },
  file: 'file',
  folder: 'folder',
  folderExpanded: 'folder-open',
};

describe('iconId', () => {
  it('picks a folder icon by name, open or closed', () => {
    expect(iconId(m, 'Services', true)).toBe('folder-controller');
    expect(iconId(m, 'services', true, true)).toBe('folder-controller-open');
    expect(iconId(m, 'components', true, true)).toBe('folder-open');
    expect(iconId(m, 'whatever', true)).toBe('folder');
  });

  it('prefers the exact file name, then the longest extension', () => {
    expect(iconId(m, 'package.json')).toBe('nodejs');
    expect(iconId(m, '.gitignore')).toBe('git');
    expect(iconId(m, 'app.component.ts')).toBe('angular-component');
    expect(iconId(m, 'runs.service.spec.ts')).toBe('test-ts');
    expect(iconId(m, 'main.ts')).toBe('typescript');
    expect(iconId(m, 'Makefile')).toBe('file');
  });

  it('turns an icon id into a URL under file-icons/', () => {
    expect(iconUrl(m, 'typescript')).toBe('file-icons/typescript.svg');
    expect(iconUrl(m, 'missing')).toBeNull();
  });
});
