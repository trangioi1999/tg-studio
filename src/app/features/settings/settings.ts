import { Component, inject, signal } from '@angular/core';
import { AgentsPanel } from '../agents/agents-panel';
import { Integrations } from '../connections/integrations';
import { DiagnosticsService } from '../../services/app/diagnostics.service';
import { SettingsTab, UiService } from '../../services/app/ui.service';
import { VersionService } from '../../services/app/version.service';
import { Page } from '../../shared/ui/page';
import { PriceSettings } from './price-settings';

/** Cài đặt: everything that is set once, apart from the screens used while agents work. */
@Component({
  selector: 'tg-settings',
  imports: [AgentsPanel, Integrations, Page, PriceSettings],
  template: `
    <tg-page title="Cài đặt" lead="Agent trên máy, kết nối đưa vào phiên của agent, ngân sách và giá, gói chẩn đoán.">
      <nav class="pg-tabs" role="tablist" aria-label="Mục cài đặt">
        @for (t of tabs; track t.id) {
          <button role="tab" [id]="'set-' + t.id" [attr.aria-selected]="ui.settingsTab() === t.id" (click)="ui.settingsTab.set(t.id)">{{ t.label }}</button>
        }
      </nav>
      <div role="tabpanel" [attr.aria-labelledby]="'set-' + ui.settingsTab()">
        @switch (ui.settingsTab()) {
          @case ('agents') { <tg-agents-panel /> }
          @case ('connections') { <tg-integrations /> }
          @case ('prices') { <tg-price-settings /> }
          @case ('diagnostics') {
            <div class="set-section">
              <section class="pg-card set-card" aria-labelledby="set-diag-h">
                <div class="pg-card-head"><h2 id="set-diag-h">Gói chẩn đoán</h2></div>
                <div class="set-card-body">
                  <p class="dim">Lưu một tệp JSON vào thư mục Tải về: phiên bản, PATH đọc được, agent tìm thấy và các lỗi gần đây của giao diện. Không có khoá hay mật khẩu, và không gửi đi đâu; báo lỗi thì gửi tệp này.</p>
                  <div class="row-end">
                    <button class="btn primary sm" [disabled]="busy()" (click)="save()">Lưu gói chẩn đoán</button>
                  </div>
                  @if (diag.saved(); as p) { <p class="ok-text ellipsis" role="status" [title]="p">Đã lưu {{ p }}</p> }
                  @if (diag.failed(); as e) { <p class="error-text" role="alert">{{ e }}</p> }
                </div>
              </section>
              @if (version.current(); as v) {
                <p class="dim mono" [title]="version.title()">TG Studio v{{ v.version }} · commit {{ v.commit }}</p>
              }
            </div>
          }
        }
      </div>
    </tg-page>
  `,
})
export class Settings {
  protected readonly ui = inject(UiService);
  protected readonly diag = inject(DiagnosticsService);
  protected readonly version = inject(VersionService);
  protected readonly busy = signal(false);
  protected readonly tabs: { id: SettingsTab; label: string }[] = [
    { id: 'agents', label: 'Agent' },
    { id: 'connections', label: 'Kết nối' },
    { id: 'prices', label: 'Ngân sách và giá' },
    { id: 'diagnostics', label: 'Chẩn đoán' },
  ];

  protected async save(): Promise<void> {
    this.busy.set(true);
    try {
      await this.diag.export();
    } finally {
      this.busy.set(false);
    }
  }
}
