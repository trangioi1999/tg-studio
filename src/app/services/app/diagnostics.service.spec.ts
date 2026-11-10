import { TestBed } from '@angular/core/testing';
import { AgentBackend } from '../../core/backend';
import { DiagnosticsService } from './diagnostics.service';
import { MockBackend } from '../../core/mock/mock-backend';

describe('DiagnosticsService', () => {
  it('saves the core report with recent UI errors as JSON', async () => {
    const backend = new MockBackend();
    let saved: { name: string; content: string } | null = null;
    backend.saveExport = async (name, content) => {
      saved = { name, content };
      return `Downloads/${name}`;
    };
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
    const diag = TestBed.inject(DiagnosticsService);
    for (let i = 0; i < 60; i++) diag.record(`lỗi ${i}`);
    const path = await diag.export();
    expect(path).toMatch(/^Downloads\/tg-studio-chan-doan-\d{12}\.json$/);
    const report = JSON.parse(saved!.content);
    expect(report.app.name).toBe('TG Studio');
    expect(report.ui.errors).toHaveLength(50);
    expect(report.ui.errors.at(-1).message).toBe('lỗi 59');
    expect(diag.saved()).toBe(path);
  });

  it('leaves the harmless ResizeObserver notice out of the report', async () => {
    const backend = new MockBackend();
    let saved = '';
    backend.saveExport = async (name, content) => ((saved = content), name);
    TestBed.configureTestingModule({ providers: [{ provide: AgentBackend, useValue: backend }] });
    const diag = TestBed.inject(DiagnosticsService);
    diag.record('ResizeObserver loop completed with undelivered notifications.');
    diag.record('lỗi thật');
    await diag.export();
    expect(JSON.parse(saved).ui.errors.map((e: { message: string }) => e.message)).toEqual(['lỗi thật']);
  });
});
