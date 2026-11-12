import { signal } from '@angular/core';
import { AgentId, PriceRow, Usage } from '../../core/protocol';

/**
 * Price history to ESTIMATE cost for agents that do not report it (Codex, Gemini, Kiro).
 * Edited in the Usage screen and stored in SQLite. Each price applies from `fromMs`
 * on, and a run is priced at what applied when it started, so changing a price never
 * rewrites earlier estimates. No price → the UI shows tokens only.
 * Claude Code reports its own cost, which always wins.
 */
export const PRICE_HISTORY = signal<PriceRow[]>([]);

/** The price in force for `agent` at `at` (epoch ms), if any. */
export function priceAt(agent: AgentId, at: number): PriceRow | null {
  let found: PriceRow | null = null;
  for (const p of PRICE_HISTORY()) {
    if (p.agent === agent && p.fromMs <= at && (!found || p.fromMs >= found.fromMs)) found = p;
  }
  return found;
}

/** Estimated USD for a run that started at `at`; null when there is no complete price. */
export function estimateCost(agent: AgentId, u: Usage, at: number): number | null {
  const p = priceAt(agent, at);
  if (!p || p.input === null || p.cachedInput === null || p.output === null) return null;
  return (u.inputTokens * p.input + u.cachedInputTokens * p.cachedInput + u.outputTokens * p.output) / 1_000_000;
}

/** Reported cost if the CLI gave one, else the estimate; with where it came from. */
export function costOf(agent: AgentId, u: Usage | null, at: number): { usd: number | null; source: 'reported' | 'estimated' | 'unpriced' | 'none' } {
  if (!u) return { usd: null, source: 'none' };
  if (u.costUsd !== null) return { usd: u.costUsd, source: 'reported' };
  const est = estimateCost(agent, u, at);
  return est === null ? { usd: null, source: 'unpriced' } : { usd: est, source: 'estimated' };
}
