import { describeLine, ConsoleLine } from './describe-line';
import { AgentId } from './protocol';

// Verbatim copies of the versioned JSONL fixtures. Keep all lines in order.
// Inline data avoids Node filesystem dependencies in the Angular test bundle.
const fixtureLines: Record<string, string[]> = {
  'claude/2.1.317': [
    "{\"type\": \"system\", \"subtype\": \"hook_started\"}",
    "{\"type\": \"system\", \"subtype\": \"hook_response\"}",
    "{\"type\": \"system\", \"subtype\": \"init\"}",
    "{\"type\": \"assistant\", \"message\": {\"role\": \"assistant\", \"content\": [{\"type\": \"tool_use\", \"name\": \"Bash\", \"input\": {\"command\": \"cat a.txt\", \"description\": \"Read a.txt contents\"}}]}}",
    "{\"type\": \"rate_limit_event\"}",
    "{\"type\": \"user\", \"message\": {\"role\": \"user\", \"content\": [{\"type\": \"tool_result\", \"content\": \"hello\", \"is_error\": false}]}}",
    "{\"type\": \"assistant\", \"message\": {\"role\": \"assistant\", \"content\": [{\"type\": \"text\", \"text\": \"hello\"}]}}",
    "{\"type\": \"rate_limit_event\"}",
    "{\"type\": \"result\", \"subtype\": \"success\", \"is_error\": false, \"num_turns\": 2, \"total_cost_usd\": 0.1313696, \"usage\": {\"input_tokens\": 4, \"cache_creation_input_tokens\": 15379, \"cache_read_input_tokens\": 33208, \"output_tokens\": 84}}",
  ],
  'codex/0.166.0': [
    "{\"type\": \"thread.started\", \"thread_id\": \"00000000-0000-0000-0000-000000000000\"}",
    "{\"type\": \"turn.started\"}",
    "{\"type\": \"item.completed\", \"item\": {\"id\": \"item_0\", \"type\": \"agent_message\", \"text\": \"Tôi sẽ đọc tệp `a.txt`.\\n\"}}",
    "{\"type\": \"item.started\", \"item\": {\"id\": \"item_1\", \"type\": \"command_execution\", \"command\": \"/bin/zsh -lc 'cat a.txt'\", \"aggregated_output\": \"\", \"exit_code\": null, \"status\": \"in_progress\"}}",
    "{\"type\": \"item.completed\", \"item\": {\"id\": \"item_1\", \"type\": \"command_execution\", \"command\": \"/bin/zsh -lc 'cat a.txt'\", \"aggregated_output\": \"hello\\n\", \"exit_code\": 0, \"status\": \"completed\"}}",
    "{\"type\": \"item.completed\", \"item\": {\"id\": \"item_2\", \"type\": \"agent_message\", \"text\": \"hello\"}}",
    "{\"type\": \"turn.completed\", \"usage\": {\"input_tokens\": 31731, \"cached_input_tokens\": 28800, \"cache_write_input_tokens\": 0, \"output_tokens\": 51, \"reasoning_output_tokens\": 0}}",
  ],
};

describe('describeLine CLI contracts', () => {
  const fixtures: { agent: AgentId; path: string; expected: (ConsoleLine | null)[] }[] = [
    {
      agent: 'claude',
      path: 'claude/2.1.317',
      expected: [
        null, // system/hook_started
        null, // system/hook_response
        { text: '● init', tone: 'muted' },
        { text: '› Bash cat a.txt', tone: 'tool' },
        null, // rate_limit_event
        null, // user/tool_result
        { text: 'hello', tone: 'text' },
        null, // rate_limit_event
        { text: '✓ success', tone: 'ok' },
      ],
    },
    {
      agent: 'codex',
      path: 'codex/0.166.0',
      expected: [
        // Current fallback behavior: these events are displayed, not hidden.
        { text: '[thread.started]', tone: 'muted' },
        { text: '[turn.started]', tone: 'muted' },
        { text: 'Tôi sẽ đọc tệp `a.txt`.\n', tone: 'text' },
        null, // item.started
        { text: "› $ /bin/zsh -lc 'cat a.txt'", tone: 'tool' },
        { text: 'hello', tone: 'text' },
        { text: '✓ turn completed', tone: 'ok' },
      ],
    },
  ];

  for (const { agent, path, expected } of fixtures) {
    const lines = fixtureLines[path];
    it(`${path}: covers every fixture line`, () => {
      expect(lines.length).toBe(expected.length);
    });
    lines.forEach((line, index) => {
      it(`${path}: line ${index + 1} (${JSON.parse(line).type})`, () => {
        expect(describeLine(agent, line)).toEqual(expected[index]);
      });
    });
  }

  for (const agent of ['claude', 'codex', 'gemini', 'kiro'] as const) {
    it(`${agent}: preserves non-JSON output and malformed JSON`, () => {
      expect(describeLine(agent, '  CLI failed: permission denied  '))
        .toEqual({ text: 'CLI failed: permission denied', tone: 'text' });
      expect(describeLine(agent, '{invalid json'))
        .toEqual({ text: '{invalid json', tone: 'text' });
      expect(describeLine(agent, '  ')).toBeNull();
    });

    it(`${agent}: falls back for unknown types`, () => {
      expect(describeLine(agent, '{"type":"future.event"}'))
        .toEqual({ text: '[future.event]', tone: 'muted' });
    });
  }

  // Claude currently has no special error-event branch; retain its fallback.
  it('claude: retains the current error-event fallback', () => {
    expect(describeLine('claude', '{"type":"error","message":"failed"}'))
      .toEqual({ text: '[error]', tone: 'muted' });
  });

  for (const type of ['error', 'turn.failed']) {
    it(`codex: displays ${type}`, () => {
      expect(describeLine('codex', JSON.stringify({ type, message: 'failed' })))
        .toEqual({ text: '✕ failed', tone: 'error' });
    });
  }

  it('gemini: displays text, tool, completion and error events', () => {
    expect(describeLine('gemini', '{"type":"message","content":"hello"}'))
      .toEqual({ text: 'hello', tone: 'text' });
    expect(describeLine('gemini', '{"type":"tool_use","tool_name":"read_file"}'))
      .toEqual({ text: '› read_file', tone: 'tool' });
    expect(describeLine('gemini', '{"type":"tool_result"}')).toBeNull();
    expect(describeLine('gemini', '{"type":"result"}'))
      .toEqual({ text: '✓ done', tone: 'ok' });
    expect(describeLine('gemini', '{"type":"error","message":"failed"}'))
      .toEqual({ text: '✕ failed', tone: 'error' });
  });

  it('kiro: retains JSON fallback for text, tool, completion and error events', () => {
    for (const type of ['message', 'tool_use', 'result', 'error']) {
      expect(describeLine('kiro', JSON.stringify({ type, content: 'hello' })))
        .toEqual({ text: `[${type}]`, tone: 'muted' });
    }
  });
});
