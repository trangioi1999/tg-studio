import { AccountLimits, LimitWindow } from './protocol';

const NAMES: Record<string, string> = { five_hour: '5 giờ', seven_day: '7 ngày' };

export interface LimitView {
  id: string;
  name: string;
  /** Whole percent used; 0 once the window has reset. */
  percent: number;
  /** The window ended after this number was reported, so the percent is not current. */
  reset: boolean;
  level: 'ok' | 'warn' | 'over';
  resetsAt: number | null;
}

export function limitView(w: LimitWindow, now: number): LimitView {
  const reset = w.resetsAt !== null && w.resetsAt <= now;
  const percent = reset ? 0 : Math.round(w.utilization * 100);
  return {
    id: w.id,
    name: NAMES[w.id] ?? w.id.replace('_minutes', ' phút'),
    percent,
    reset,
    level: percent >= 100 ? 'over' : percent >= 80 ? 'warn' : 'ok',
    resetsAt: w.resetsAt,
  };
}

function clock(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  return `${time} ${d.getDate()}/${d.getMonth() + 1}`;
}

/** Numbers are only as fresh as the agent's last report, so the tooltip says when that was. */
export function limitsTitle(limits: AccountLimits, now: number): string {
  const lines = limits.windows.map((w) => {
    const v = limitView(w, now);
    if (v.reset) return `${v.name}: đã qua kỳ reset, chưa có số mới`;
    return `${v.name}: đã dùng ${v.percent}%${v.resetsAt ? `, reset lúc ${clock(v.resetsAt)}` : ''}`;
  });
  const minutes = Math.max(0, Math.round((now - limits.at) / 60000));
  const age = minutes < 1 ? 'vừa xong' : minutes < 60 ? `${minutes} phút trước` : `lúc ${clock(limits.at)}`;
  return [...lines, `Số do CLI báo, cập nhật ${age}.`].join('\n');
}
