import { AccountLimits, LimitWindow } from '../../core/protocol';

const NAMES: Record<string, string> = { five_hour: '5 giờ', seven_day: '7 ngày', monthly: 'Tháng', bonus: 'Thưởng' };

export interface LimitView {
  id: string;
  name: string;
  /** Whole percent used; 0 once the window has reset. */
  percent: number;
  /** The window ended after this number was reported, so the percent is not current. */
  reset: boolean;
  level: 'ok' | 'warn' | 'over';
  resetsAt: number | null;
  /** What the status bar shows: "5 giờ 8%", or credits "Kiro Pro+ 334,17 / 2.000". */
  label: string;
  /** Credits used and allowed, when the agent counts credits. */
  credits: { used: number; limit: number } | null;
}

const num = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

export function limitView(w: LimitWindow, now: number): LimitView {
  const reset = w.resetsAt !== null && w.resetsAt <= now;
  const percent = reset ? 0 : Math.round(w.utilization * 100);
  const name = NAMES[w.id] ?? w.id.replace('_minutes', ' phút');
  const credits = typeof w.used === 'number' && typeof w.limit === 'number' ? { used: w.used, limit: w.limit } : null;
  const label = reset ? `${name} đã reset`
    : credits ? `${w.plan || name} ${num(credits.used)} / ${num(credits.limit)}`
    : `${name} ${percent}%`;
  return {
    id: w.id,
    name,
    percent,
    reset,
    level: percent >= 100 ? 'over' : percent >= 80 ? 'warn' : 'ok',
    resetsAt: w.resetsAt,
    label,
    credits,
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
    const used = v.credits ? `${num(v.credits.used)} / ${num(v.credits.limit)} credit (${v.percent}%)` : `${v.percent}%`;
    return `${w.plan ? `${w.plan} · ` : ''}${v.name}: đã dùng ${used}${v.resetsAt ? `, reset lúc ${clock(v.resetsAt)}` : ''}`;
  });
  const minutes = Math.max(0, Math.round((now - limits.at) / 60000));
  const age = minutes < 1 ? 'vừa xong' : minutes < 60 ? `${minutes} phút trước` : `lúc ${clock(limits.at)}`;
  return [...lines, `Số do CLI báo, cập nhật ${age}.`].join('\n');
}
