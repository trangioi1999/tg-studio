// Làm đúng những gì TG Studio làm khi đọc danh sách model của một agent, để chạy thử bằng tay.
// Không gửi prompt nào nên không tốn token.
//
//   node scripts/probe-acp.mjs claude     (hoặc codex, kiro, gemini)
//
// Các bước: chạy adapter ACP → gửi `initialize` → gửi `session/new` → in `configOptions`
// (trong đó có select `model` và `effort`). Mọi lỗi của adapter in ra với tiền tố [stderr].
import { spawn } from 'node:child_process';

const COMMANDS = {
  claude: ['npx', ['-y', '@agentclientprotocol/claude-agent-acp@0.100.0']],
  codex: ['npx', ['-y', '@agentclientprotocol/codex-acp@2.5.0']],
  kiro: ['kiro-cli', ['acp']],
  gemini: ['gemini', ['--experimental-acp']],
};

const agent = process.argv[2] ?? 'claude';
if (!COMMANDS[agent]) {
  console.error(`Agent không biết: ${agent}. Dùng: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(2);
}
const [cmd, args] = COMMANDS[agent];
console.log(`> ${cmd} ${args.join(' ')}   (thư mục: ${process.cwd()})`);
// Windows cần shell để chạy npx.cmd / kiro-cli.exe như PowerShell làm.
const child = spawn(cmd, args, { shell: process.platform === 'win32', cwd: process.cwd() });
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
const finish = (code) => {
  child.kill();
  process.exit(code);
};

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('[stdout không phải JSON]', line);
      continue;
    }
    if (msg.id === 1) {
      if (msg.error) {
        console.log(`[${elapsed()}] initialize LỖI:`, JSON.stringify(msg.error));
        return finish(1);
      }
      console.log(`[${elapsed()}] initialize OK · protocolVersion = ${msg.result?.protocolVersion}`);
      send(2, 'session/new', { cwd: process.cwd(), mcpServers: [] });
    } else if (msg.id === 2) {
      if (msg.error) {
        console.log(`[${elapsed()}] session/new LỖI:`, JSON.stringify(msg.error));
        return finish(1);
      }
      const options = msg.result?.configOptions;
      console.log(`[${elapsed()}] session/new OK · sessionId = ${msg.result?.sessionId}`);
      if (!Array.isArray(options)) {
        console.log('Agent không gửi configOptions → app sẽ báo "không cho chọn model".');
        return finish(0);
      }
      for (const o of options) {
        const values = (o.options ?? []).flatMap((x) => x.options ?? [x]).map((x) => x.value);
        console.log(`- ${o.id} (${o.category ?? 'không có category'}): hiện tại = ${o.currentValue}; lựa chọn = ${values.join(', ')}`);
      }
      return finish(0);
    }
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(`[stderr] ${chunk}`));
child.on('error', (e) => {
  console.log('Không chạy được adapter:', e.message);
  process.exit(1);
});
child.on('exit', (code) => console.log(`[${elapsed()}] adapter thoát, mã ${code}`));

send(1, 'initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  clientInfo: { name: 'tg-studio-probe', title: 'TG Studio probe', version: '0' },
});
setTimeout(() => {
  console.log(`[${elapsed()}] Quá 180 giây không có trả lời (lần đầu npx có thể đang tải adapter).`);
  finish(1);
}, 180_000);
