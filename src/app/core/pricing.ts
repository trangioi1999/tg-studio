import { AgentId, Usage } from './protocol';

export interface Price {
  /** USD per 1M tokens */
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * Bảng giá để ƯỚC TÍNH chi phí cho agent không tự báo cost (Codex, Gemini).
 * Điền theo trang pricing chính thức của từng hãng và model bạn dùng.
 * Để null → UI chỉ hiện token, không đoán tiền.
 * Claude Code tự báo `total_cost_usd`, nên không cần dòng này.
 * Nếu bạn dùng gói subscription (Max, ChatGPT plan…), số tiền ước tính chỉ để tham khảo.
 */
export const PRICES: Record<AgentId, Price | null> = {
  claude: null,
  codex: null,
  gemini: null,
  kiro: null,
};

export function estimateCost(agent: AgentId, u: Usage): number | null {
  const p = PRICES[agent];
  if (!p) return null;
  return (u.inputTokens * p.input + u.cachedInputTokens * p.cachedInput + u.outputTokens * p.output) / 1_000_000;
}
