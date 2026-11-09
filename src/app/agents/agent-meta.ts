import { AgentId } from '../core/protocol';

/** How the app shows each agent: names, install and login hints, colors. Not part of the wire contract. */
export interface AgentMeta {
  name: string;
  color: string;
  /**
   * The same hue at a lightness validated for charts on the dark surface
   * (dataviz validate_palette.js: band, chroma, CVD ΔE ≥ 8, contrast). Charts only.
   */
  chart: string;
  install: string;
  /** Run in a terminal to log in. */
  login: string;
}

export const AGENT_META: Record<AgentId, AgentMeta> = {
  claude: { name: 'Claude Code', color: '#E07B53', chart: '#C9663E', install: 'npm i -g @anthropic-ai/claude-code', login: 'claude auth login' },
  codex: { name: 'Codex', color: '#3FB68B', chart: '#2FAA7F', install: 'npm i -g @openai/codex', login: 'codex login' },
  gemini: { name: 'Gemini CLI', color: '#6E9BF5', chart: '#3C64B9', install: 'npm i -g @google/gemini-cli', login: 'gemini' },
  kiro: { name: 'Kiro CLI', color: '#A78BFA', chart: '#987CE9', install: 'Xem hướng dẫn cài tại kiro.dev', login: 'kiro-cli login' },
};

export const AGENT_IDS: AgentId[] = ['claude', 'codex', 'gemini', 'kiro'];
