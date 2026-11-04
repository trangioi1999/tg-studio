// Minimal MCP stdio server for checking that TG Studio's --mcp-config reaches Claude.
const rl = require('readline').createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'tg-ping', version: '1.0.0' } });
  else if (m.method === 'tools/list') send(m.id, { tools: [{ name: 'ping', description: 'Returns pong', inputSchema: { type: 'object', properties: {} } }] });
  else if (m.method === 'tools/call') send(m.id, { content: [{ type: 'text', text: 'pong from tg-ping' }] });
  else if (m.id !== undefined) send(m.id, {});
});
