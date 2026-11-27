import { AgentCommand, AgentId, ContextCategory, ContextUsage } from '../../core/protocol';
import { fmtTokens as fmt } from './format';

const fmtTokens = (n: number) => fmt(n).replace('.0', '');

/** Colour of the context chip: calm below half, warning up to 80 %, red above. */
export function contextTone(percent: number | null): 'run' | 'wait' | 'fail' | null {
  if (percent === null) return null;
  return percent > 80 ? 'fail' : percent >= 50 ? 'wait' : 'run';
}

/** "18% · 184k/1M" with both numbers, "7%" with only a percentage, "184k token" with only a count. */
export function contextLabel(c: ContextUsage): string {
  const used = c.used !== null ? fmtTokens(c.used) : null;
  const pct = c.percent !== null ? `${Math.round(c.percent)}%` : null;
  if (used && c.size !== null && pct) return `${pct} · ${used}/${fmtTokens(c.size)}`;
  return pct ?? (used ? `${used} token` : '');
}

/** Whether the agent can summarise its own conversation: Claude always, the others if they list `compact`. */
export function canCompact(agent: AgentId, commands: AgentCommand[]): boolean {
  return agent === 'claude' || commands.some((c) => c.name === 'compact');
}

const NAMES: Record<string, string> = {
  messages: 'Tin nhắn', mcp_tools: 'Tool MCP', system_tools: 'Tool hệ thống', memory_files: 'Tệp ghi nhớ', skills: 'Skills',
  system_prompt: 'System prompt', mcp_instructions: 'Hướng dẫn MCP server', custom_agents: 'Agent tuỳ chỉnh',
  autocompact_buffer: 'Vùng đệm tự thu gọn', free_space: 'Còn trống',
};

export function categoryName(c: ContextCategory): string {
  return (c.id && NAMES[c.id]) || c.name;
}

/** Bar colours for the used categories, in order; the buffer and free space have their own. */
export const CATEGORY_COLORS = ['#6e9bf5', '#ff8a3d', '#3fbfa0', '#e8b672', '#b48cf0', '#9a9aa5', '#7c7c87', '#d98bb4'];
