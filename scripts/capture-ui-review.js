// Screens for docs/ui-review/ (img/<id>.webp, 1440×900 at 2×), taken from the mock UI.
// The download site's gallery uses some of them too.
//   npm start -- --port 4321
//   node scripts/capture-ui-review.js [out-dir]        (default docs/ui-review/img)
// Needs Playwright (require('playwright')) and ffmpeg for the WebP files; without ffmpeg
// the PNG files are kept next to where the WebP would go.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const URL = 'http://localhost:4321/';
const out = path.resolve(process.argv[2] ?? 'docs/ui-review/img');

function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const webp = hasFfmpeg();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const p = await ctx.newPage();

  const open = async (repo) => {
    await p.evaluate(() => localStorage.clear()).catch(() => {});
    await p.goto(URL);
    await p.evaluate((repo) => {
      localStorage.clear();
      localStorage.setItem('tg.onboarded', '1');
      if (repo) localStorage.setItem('tg.repo', '/Users/you/projects/demo');
    }, repo);
    await p.goto(URL);
    await p.waitForSelector(repo ? 'textarea#prompt' : 'button:has-text("Mở thư mục dự án")');
    await p.waitForTimeout(800);
    // The mock-mode hint is for developers, not for screenshots.
    await p.evaluate(() => { for (const el of document.querySelectorAll('.statusbar .mock')) el.style.visibility = 'hidden'; });
  };
  const fresh = () => open(true);
  const shot = async (id, settle = 400) => {
    await p.waitForTimeout(settle);
    const png = path.join(out, `${id}.png`);
    await p.screenshot({ path: png });
    if (webp) {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-c:v', 'libwebp', '-quality', '82', path.join(out, `${id}.webp`)]);
      fs.rmSync(png);
    }
    console.log(id);
  };
  const ask = async (text) => {
    await p.fill('textarea#prompt', text);
    await p.press('textarea#prompt', 'Enter');
  };
  const chip = (n) => p.click(`.chip-btn[aria-haspopup="true"] >> nth=${n}`);
  const done = async () => {
    await p.waitForSelector('.pill[data-status="waiting"]', { timeout: 15000 });
    await p.waitForTimeout(3500); // the reply finishes typing out
  };

  // Bắt đầu
  await open(false);
  await shot('01-welcome');
  await fresh();
  await shot('02-new-chat');

  // Ô chat
  await chip(0);
  await p.waitForSelector('.agent-pop');
  await shot('03-agent-model');
  await p.click('button:has-text("Giao cho nhiều agent…")');
  await shot('04-parallel');

  await fresh();
  await chip(1);
  await p.waitForSelector('.perm-pop');
  await shot('05-permissions');

  await fresh();
  await chip(2);
  await shot('06-place');

  await fresh();
  await chip(1);
  await p.click('button.opt:has-text("Tự động")');
  await shot('12-auto-warning');

  // Agent làm việc
  await fresh();
  await ask('Sửa tiêu đề trang chủ và chạy test');
  await p.waitForSelector('tg-permission-card');
  await shot('07-approval-status');
  await p.click('button:has-text("Cho phép lần này")');
  await p.waitForSelector('.worklog.live');
  await shot('08-running-status', 0); // the mock finishes in about half a second
  await done();
  await p.click('.tab:has-text("app.ts")').catch(() => {});
  await shot('09-done-changes');
  await p.click('button:has-text("Xem thay đổi")');
  await p.waitForSelector('.chg-row');
  await shot('17-changes');

  await fresh();
  await ask('Sửa tiêu đề trang chủ, chia việc viết test cho agent khác');
  await p.waitForSelector('tg-permission-card');
  await p.click('button:has-text("Cho phép lần này")');
  await p.waitForSelector('.dlg-item');
  await done();
  await p.click('.dlg-toggle >> nth=0');
  await shot('18-delegate');

  // Hỏi đáp
  await fresh();
  await chip(1);
  await p.click('button.opt:has-text("Chỉ hỏi")');
  await ask('Dự án dùng Angular bản nào?');
  await p.waitForSelector('.msg-agent.typing', { timeout: 10000 });
  await shot('10-question-typing', 150);
  await p.waitForTimeout(3500);
  await p.hover('.msg-agent pre').catch(() => {});
  await shot('11-question-copy');

  // Các màn khác
  for (const [id, label] of [['13-mission', 'Giám sát'], ['14-usage', 'Chi phí'], ['15-agents', 'Agent'], ['16-integrations', 'Kết nối']]) {
    await p.click(`button.tl-screen[aria-label="${label}"]`);
    await p.waitForTimeout(800);
    await shot(id);
    await p.click(`button.tl-screen[aria-label="${label}"]`);
  }

  await browser.close();
  if (!webp) console.log('Không có ffmpeg: giữ ảnh PNG, hãy đổi sang WebP trước khi commit.');
})().catch((e) => { console.error(e); process.exit(1); });
