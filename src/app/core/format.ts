export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + 'k';
  return String(n);
}

export function fmtUsd(n: number | null): string {
  if (n === null) return '—';
  if (n > 0 && n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** 104 MB, 1.2 GB: resident memory, in the units Activity Monitor and Task Manager use. */
export function fmtBytes(n: number): string {
  const mb = n / (1024 * 1024);
  if (mb < 1) return '<1 MB';
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(mb < 10 * 1024 ? 1 : 0)} GB`;
}

/** Percent of one core, as Activity Monitor shows it: 0.4%, 12%, 180%. */
export function fmtCpu(pct: number): string {
  if (pct < 0.05) return '0%';
  return pct < 10 ? `${pct.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(pct)}%`;
}
