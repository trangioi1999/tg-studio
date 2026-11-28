import { TestBed } from '@angular/core/testing';
import { PermissionRequest } from '../../../core/protocol';
import { RunsService } from '../../../services/runs/runs.service';
import { PermissionCard } from './permission-card';

describe('PermissionCard', () => {
  function render(toolCall: PermissionRequest['toolCall']): HTMLElement {
    TestBed.configureTestingModule({ providers: [{ provide: RunsService, useValue: { respondPermission: vi.fn() } }] });
    const fixture = TestBed.createComponent(PermissionCard);
    fixture.componentRef.setInput('runId', 'r');
    fixture.componentRef.setInput('agent', 'claude');
    fixture.componentRef.setInput('request', { requestId: 'p', toolCall, options: [], rule: null });
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('chỉ hiện dạng code khi tiêu đề trùng lệnh', () => {
    const el = render({ title: ' npm test ', rawInput: { command: 'npm test' } });
    expect(el.querySelector('code')?.textContent).toBe('npm test');
    expect(el.querySelector('.permission-title')).toBeNull();
  });

  it('hiện cả tiêu đề và lệnh khi khác nhau', () => {
    const el = render({ title: 'Chạy test', rawInput: { command: ['npm', 'test'] } });
    expect(el.querySelector('.permission-title')?.textContent).toBe('Chạy test');
    expect(el.querySelector('code')?.textContent).toBe('npm test');
  });
});
