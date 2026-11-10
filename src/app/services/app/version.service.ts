import { Injectable, computed, inject, signal } from '@angular/core';
import { AgentBackend } from '../../core/backend';
import { AppVersion, LatestVersion } from '../../core/protocol';
import { errorText } from '../../shared/utils/errors';

/** How often a running app looks for a newer release. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Which build is running, and whether a newer release is out (git tags on GitHub). */
@Injectable({ providedIn: 'root' })
export class VersionService {
  private readonly backend = inject(AgentBackend);
  readonly current = signal<AppVersion | null>(null);
  readonly latest = signal<LatestVersion | null>(null);
  readonly checking = signal(false);
  readonly error = signal<string | null>(null);

  readonly label = computed(() => {
    const v = this.current();
    return v ? `v${v.version} · ${v.commit}` : '';
  });

  readonly title = computed(() => {
    const v = this.current();
    if (!v) return '';
    const built = v.builtAt ? `\nBuild lúc ${new Date(v.builtAt).toLocaleString('vi-VN')}` : '';
    const latest = this.latest();
    const status = this.checking()
      ? 'Đang kiểm tra bản mới…'
      : this.error()
        ? `Không kiểm tra được bản mới: ${this.error()}`
        : latest?.newer
          ? `Đã có bản v${latest.latest}. Tải bản mới để cập nhật.`
          : latest
            ? `Đang dùng bản mới nhất (v${latest.latest}).`
            : '';
    return `TG Studio v${v.version} (commit ${v.commit})${built}\n${status}\nBấm để kiểm tra lại.`;
  });

  constructor() {
    void this.backend.appVersion().then((v) => this.current.set(v), () => {});
    void this.check();
    setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  async check(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    try {
      this.latest.set(await this.backend.latestVersion());
      this.error.set(null);
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.checking.set(false);
    }
  }
}
