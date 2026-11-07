// Screenshots for README.md and docs/user-guide.md (docs/images/*.png), taken from the mock UI.
// Run `npm start -- --port 4321`, then execute this function with a Playwright page (for example
// the Playwright MCP tool browser_run_code_unsafe with filename scripts/capture-screens.js).
async (page) => {
  const W = 1440, H = 900;
  const out = '/Users/trangioi/Documents/vibe-code/tg-studio/docs/images';
  const ctx = await page.context().browser().newContext({ viewport: { width: W, height: H }, colorScheme: 'dark', deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    localStorage.setItem('tg.onboarded', '1');
    localStorage.setItem('tg.repo', '/Users/you/projects/demo');
  });
  const fresh = async () => {
    await p.goto('http://localhost:4321/');
    await p.waitForSelector('textarea#prompt');
    await p.waitForTimeout(800);
    // The mock-mode hint is for developers, not for screenshots.
    await p.evaluate(() => {
      for (const el of document.querySelectorAll('.statusbar .mock')) el.style.visibility = 'hidden';
    });
  };
  const shot = async (name) => {
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}/${name}.png` });
  };
  const ask = async (text) => {
    await p.fill('textarea#prompt', text);
    await p.press('textarea#prompt', 'Enter');
  };

  // Chọn agent, model và mức suy nghĩ.
  await fresh();
  await p.click('.chip-btn[aria-haspopup="true"] >> nth=0');
  await p.waitForSelector('.agent-pop');
  await p.waitForTimeout(600);
  await shot('agent-menu');
  await p.keyboard.press('Escape');

  // Gõ "/" để gọi skill của agent.
  await fresh();
  await p.click('textarea#prompt');
  await p.keyboard.type('/');
  await p.waitForSelector('.cmd-opt');
  await shot('skills');

  // Thẻ duyệt lệnh, rồi kết quả và thay đổi chờ duyệt.
  await fresh();
  await ask('Sửa tiêu đề trang chủ và chạy test');
  await p.waitForSelector('tg-permission-card');
  await shot('approval');
  await p.click('button:has-text("Cho phép lần này")');
  await p.waitForSelector('.pill[data-status="waiting"]', { timeout: 15000 });
  await p.waitForTimeout(3500); // the reply finishes typing out
  await shot('chat-review');

  // Xoá một cuộc trò chuyện, xác nhận ngay tại dòng.
  await p.hover('.tl-item');
  await p.click('.tl-del');
  await p.waitForSelector('.tl-confirm');
  await shot('delete');

  // Nhiều agent cùng làm, so sánh và chọn một bản.
  await fresh();
  await p.click('.chip-btn[aria-haspopup="true"] >> nth=0');
  await p.click('button:has-text("Giao cho nhiều agent…")');
  // Two agents read better than four; Tự động so neither stops for an approval.
  for (const name of ['Gemini CLI', 'Kiro CLI']) await p.click(`.agent-pop label.opt:has-text("${name}") input`);
  await p.keyboard.press('Escape');
  await p.click('.chip-btn[aria-haspopup="true"] >> nth=1');
  await p.click('button.opt:has-text("Tự động")');
  await ask('Thêm nút đăng xuất');
  await p.waitForFunction(() => document.querySelectorAll('.pill[data-status="running"]').length === 0, null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(4000);
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => /So sánh/.test(b.textContent ?? ''))?.click());
  await p.waitForTimeout(1200);
  await shot('compare');

  // Giám sát và Chi phí.
  await p.click('button[aria-label="Giám sát"]');
  await shot('mission-control');
  await p.click('button[aria-label="Chi phí"]');
  await p.waitForTimeout(800);
  await shot('usage');

  await ctx.close();
  return 'ok';
}
