import { costOf } from './pricing';
import { AgentId, UsageRow } from '../core/protocol';
import { AGENT_IDS } from '../agents/agent-meta';

export type Measure = 'cost' | 'tokens';
export type SortKey = 'time' | 'cost' | 'tokens';


export interface DayBucket {
  /** Local midnight of the day. */
  start: number;
  label: string;
  total: number;
  runs: number;
  segments: { agent: AgentId; value: number; pct: number }[];
}

export interface AgentShare {
  agent: AgentId;
  cost: number;
  tokens: number;
  runs: number;
  /** Percent of the range's cost, or of its tokens when nothing has a price. */
  share: number;
}

export interface Totals {
  cost: number;
  tokens: number;
  cached: number;
  runs: number;
  /** Runs with usage but no price. */
  unpriced: number;
}

export interface RowFilter {
  agent: AgentId | null;
  /** Local midnight of one day, or null for the whole range. */
  day: number | null;
  query: string;
}

export function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function tokensOf(r: UsageRow): number {
  return r.usage ? r.usage.inputTokens + r.usage.cachedInputTokens + r.usage.outputTokens : 0;
}

export function costUsd(r: UsageRow): number | null {
  return costOf(r.agent, r.usage, r.startedAt).usd;
}

export function valueOf(r: UsageRow, measure: Measure): number {
  return measure === 'cost' ? (costUsd(r) ?? 0) : tokensOf(r);
}

export function totalsOf(rows: UsageRow[]): Totals {
  const t: Totals = { cost: 0, tokens: 0, cached: 0, runs: rows.length, unpriced: 0 };
  for (const r of rows) {
    const c = costUsd(r);
    if (c !== null) t.cost += c;
    else if (r.usage) t.unpriced++;
    t.tokens += tokensOf(r);
    t.cached += r.usage?.cachedInputTokens ?? 0;
  }
  return t;
}

/** Percent change from `prev` to `cur`; null when there is nothing to compare with. */
export function changePct(cur: number, prev: number): number | null {
  return prev > 0 ? ((cur - prev) / prev) * 100 : null;
}

/**
 * One bucket per calendar day, oldest first, ending today. Segments keep a fixed
 * agent order so a colour always sits in the same place; shares sum to 100.
 */
export function dailyBuckets(rows: UsageRow[], days: number, measure: Measure, now = Date.now()): DayBucket[] {
  const today = startOfDay(now);
  const out: DayBucket[] = [];
  const index = new Map<number, DayBucket>();
  for (let i = days - 1; i >= 0; i--) {
    // Step by date, not by 24 h, so daylight-saving days still land on midnight.
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const b: DayBucket = { start: d.getTime(), label: `${d.getDate()}/${d.getMonth() + 1}`, total: 0, runs: 0, segments: [] };
    out.push(b);
    index.set(b.start, b);
  }
  for (const r of rows) {
    const b = index.get(startOfDay(r.startedAt));
    if (!b) continue;
    b.runs++;
    const v = valueOf(r, measure);
    if (!v) continue;
    const seg = b.segments.find((s) => s.agent === r.agent);
    if (seg) seg.value += v;
    else b.segments.push({ agent: r.agent, value: v, pct: 0 });
    b.total += v;
  }
  for (const b of out) {
    b.segments.sort((x, y) => AGENT_IDS.indexOf(x.agent) - AGENT_IDS.indexOf(y.agent));
    for (const s of b.segments) s.pct = (s.value / b.total) * 100;
  }
  return out;
}

/** Spend per agent, largest first. */
export function agentShares(rows: UsageRow[]): AgentShare[] {
  const map = new Map<AgentId, AgentShare>();
  for (const r of rows) {
    const a = map.get(r.agent) ?? { agent: r.agent, cost: 0, tokens: 0, runs: 0, share: 0 };
    a.cost += costUsd(r) ?? 0;
    a.tokens += tokensOf(r);
    a.runs++;
    map.set(r.agent, a);
  }
  const list = [...map.values()];
  const byCost = list.some((a) => a.cost > 0);
  const total = list.reduce((s, a) => s + (byCost ? a.cost : a.tokens), 0);
  for (const a of list) a.share = total ? ((byCost ? a.cost : a.tokens) / total) * 100 : 0;
  return list.sort((x, y) => y.share - x.share || y.runs - x.runs);
}

export function filterRows(rows: UsageRow[], f: RowFilter): UsageRow[] {
  const q = f.query.trim().toLocaleLowerCase('vi');
  return rows.filter((r) =>
    (!f.agent || r.agent === f.agent) &&
    (f.day === null || startOfDay(r.startedAt) === f.day) &&
    (!q || r.prompt.toLocaleLowerCase('vi').includes(q)));
}

/** Newest first for time; largest first for cost and tokens. Unpriced runs sort last by cost. */
export function sortRows(rows: UsageRow[], key: SortKey): UsageRow[] {
  const by = {
    time: (r: UsageRow) => r.startedAt,
    cost: (r: UsageRow) => costUsd(r) ?? -1,
    tokens: tokensOf,
  }[key];
  return [...rows].sort((a, b) => by(b) - by(a) || b.startedAt - a.startedAt);
}

/** SVG path for a sparkline in a `w`×`h` box; flat at the bottom when all zero. */
export function sparkPath(values: number[], w: number, h: number): string {
  if (values.length < 2) return '';
  const max = Math.max(...values);
  const step = w / (values.length - 1);
  return values
    .map((v, i) => `${i ? 'L' : 'M'}${round(i * step)} ${round(max ? h - (v / max) * (h - 2) - 1 : h - 1)}`)
    .join(' ');
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Rounds the axis top up to 1, 2 or 5 × 10ⁿ so the gridlines read cleanly. */
export function niceMax(v: number): number {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

/** One line per run; cost columns say where the number came from. */
export function toCsv(rows: UsageRow[]): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['started_at', 'agent', 'status', 'prompt', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'cost_usd', 'cost_source'];
  const lines = rows.map((r) => {
    const c = costOf(r.agent, r.usage, r.startedAt);
    return [new Date(r.startedAt).toISOString(), r.agent, r.status, r.prompt, r.usage?.inputTokens ?? 0, r.usage?.cachedInputTokens ?? 0, r.usage?.outputTokens ?? 0,
      c.usd === null ? null : c.usd.toFixed(6), c.source].map(cell).join(',');
  });
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}
