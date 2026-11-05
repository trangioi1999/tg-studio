// Records the 1-minute demo on the download page (site/media/tg-studio-demo.webm) from the
// mock UI, with Vietnamese captions. Run `npm start -- --port 4321`, then execute this function
// with a Playwright page (for example the Playwright MCP tool browser_run_code_unsafe with
// filename scripts/record-demo.js). The .webm lands in .playwright-mcp/video/.
async (page) => {
  const W = 1440, H = 900;
  const dir = '/Users/trangioi/Documents/vibe-code/tg-studio/.playwright-mcp/video';
  const ctx = await page.context().browser().newContext({ viewport: { width: W, height: H }, recordVideo: { dir, size: { width: W, height: H } }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    localStorage.setItem('tg.onboarded', '1');
    localStorage.setItem('tg.repo', '/Users/you/projects/demo');
  });
  await p.goto('http://localhost:4321/');
  await p.waitForTimeout(1200);
  // Captions and title cards drawn over the app; the mock-mode hint is hidden.
  await p.addStyleTag({ content: `
    #cap { position: fixed; left: 50%; bottom: 64px; transform: translateX(-50%); z-index: 99999; max-width: 900px;
      background: rgba(10,10,12,.88); color: #f4f4f5; font: 600 22px/1.35 -apple-system, "Segoe UI", sans-serif;
      padding: 14px 26px; border-radius: 14px; border: 1px solid rgba(255,255,255,.14); box-shadow: 0 12px 40px rgba(0,0,0,.5);
      text-align: center; transition: opacity .35s; pointer-events: none; }
    #cap small { display: block; font-weight: 400; font-size: 16px; color: #a1a1aa; margin-top: 4px; }
    #card { position: fixed; inset: 0; z-index: 100000; display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: radial-gradient(circle at 50% 40%, #1d1d24, #09090b 70%); color: #fafafa; font-family: -apple-system, "Segoe UI", sans-serif;
      transition: opacity .6s; text-align: center; }
    #card .logo { width: 84px; height: 84px; border-radius: 20px; background: #fafafa; color: #09090b; display: grid; place-items: center; font: 800 34px/1 sans-serif; margin-bottom: 26px; }
    #card h1 { font-size: 52px; margin: 0 0 14px; letter-spacing: -.02em; }
    #card p { font-size: 22px; color: #a1a1aa; margin: 0; max-width: 820px; line-height: 1.5; }
    .statusbar code, footer code { }
  ` });
  await p.evaluate(() => {
    for (const el of document.querySelectorAll('footer *, [role=contentinfo] *')) {
      if (el.children.length === 0 && /Mock mode|để chạy agent thật/.test(el.parentElement?.textContent ?? '')) el.parentElement.style.visibility = 'hidden';
    }
  });
  const card = async (title, sub, ms) => {
    await p.evaluate(([t, s]) => {
      document.getElementById('card')?.remove();
      const d = document.createElement('div'); d.id = 'card';
      d.innerHTML = `<div class="logo">TG</div><h1>${t}</h1><p>${s}</p>`;
      document.body.appendChild(d);
    }, [title, sub]);
    await p.waitForTimeout(ms);
  };
  const uncard = async () => { await p.evaluate(() => { const d = document.getElementById('card'); if (d) { d.style.opacity = '0'; setTimeout(() => d.remove(), 600); } }); await p.waitForTimeout(700); };
  const cap = async (text, sub = '') => {
    await p.evaluate(([t, s]) => {
      let c = document.getElementById('cap');
      if (!c) { c = document.createElement('div'); c.id = 'cap'; document.body.appendChild(c); }
      c.innerHTML = t + (s ? `<small>${s}</small>` : '');
      c.style.opacity = '1';
    }, [text, sub]);
  };
  const box = () => p.getByRole('textbox', { name: 'Yêu cầu cho agent' });
  p.setDefaultTimeout(8000);
  const ask = async (text) => { await box().click(); await box().pressSequentially(text, { delay: 38 }); await p.waitForTimeout(350); await box().press('Enter'); };
  const pick = async (button, option) => {
    await p.locator('section[aria-label="Giao việc"]').getByRole('button', { name: button }).first().click();
    await p.waitForTimeout(450);
    await p.getByRole('option', { name: new RegExp('^' + option) }).first().click();
    await p.waitForTimeout(450);
    if (await p.locator('.pop-backdrop').count()) { await p.locator('.pop-backdrop').first().click({ force: true, position: { x: 5, y: 5 } }); await p.waitForTimeout(300); }
  };
  const newChat = async () => { await p.getByRole('button', { name: /^Trò chuyện mới/ }).first().click(); await p.waitForTimeout(600); };

  try {
  await card('TG Studio', 'Điều phối Claude Code, Codex, Gemini CLI và Kiro CLI đã cài trên máy bạn, trong một cửa sổ.', 3200);
  await uncard();

  // 1. Ask, read-only.
  await cap('Hỏi về dự án mà không lo agent sửa gì', 'Chỉ hỏi: agent chỉ đọc code');
  await pick('Hỏi trước', 'Chỉ hỏi');
  await ask('Dự án này dùng framework gì?');
  await p.waitForTimeout(5200);
  await cap('Câu trả lời hiện ra ngay khi agent đang viết', 'Hỏi tiếp trong cùng phiên, không phải khởi động lại');
  await ask('Tóm tắt các module chính');
  await p.waitForTimeout(3800);

  // 2. Code task with an approval card.
  await newChat();
  await cap('Giao việc sửa code', 'Lệnh nhạy cảm hiện thẻ duyệt ngay trên ô chat');
  await pick('Chỉ hỏi', 'Sửa code');
  await ask('Thêm nút đăng xuất vào thanh trên cùng');
  await p.waitForTimeout(2600);
  await p.getByRole('button', { name: /Cho phép lần này/ }).hover();
  await p.waitForTimeout(900);
  await p.getByRole('button', { name: /Cho phép lần này/ }).click();
  await p.waitForTimeout(3400);

  // 3. Review the change hunk by hunk.
  await cap('Xem từng đoạn thay đổi, giữ hoặc hoàn tác', 'Code thật chỉ đổi theo đúng những gì bạn giữ');
  await p.getByRole('button', { name: 'Xem thay đổi' }).click();
  await p.waitForTimeout(1800);
  await p.getByRole('button', { name: /^Giữ/ }).first().hover();
  await p.waitForTimeout(700);
  await p.getByRole('button', { name: /^Giữ/ }).first().click();
  await p.waitForTimeout(1800);

  // 4. Hand the follow-up to another agent.
  await cap('Agent đề xuất chuyển việc cho agent khác', 'Bạn quyết định: Codex nhận việc trong cùng cuộc trò chuyện');
  await p.getByRole('button', { name: 'Giao cho Codex' }).hover();
  await p.waitForTimeout(800);
  await p.getByRole('button', { name: 'Giao cho Codex' }).click();
  await p.waitForTimeout(4200);

  // 5. Several agents at once.
  await newChat();
  await cap('Cùng một việc cho nhiều agent', 'Mỗi agent một bản nháp, rồi so sánh và chọn bản tốt nhất');
  await pick('Hỏi trước', 'Tự động');
  await p.locator('section[aria-label="Giao việc"]').locator('button').first().click();
  await p.waitForTimeout(400);
  await p.getByText('Giao cho nhiều agent…').click();
  await p.waitForTimeout(1600);
  await p.locator('.pop-backdrop').first().click({ force: true, position: { x: 5, y: 5 } });
  await p.waitForTimeout(400);
  await ask('Viết hàm kiểm tra email hợp lệ');
  await p.waitForTimeout(4500);
  const compare = p.getByRole('button', { name: 'So sánh', exact: true });
  if (await compare.count()) { await compare.first().click(); await p.waitForTimeout(3200); }

  // 6. Cost.
  await cap('Biết mỗi việc tốn bao nhiêu', 'Token, chi phí theo ngày, hạn mức gói Claude và Codex, ngân sách');
  await p.getByRole('button', { name: 'Chi phí' }).click();
  await p.waitForTimeout(3800);
  await p.evaluate(() => document.getElementById('cap')?.remove());

  await card('Tải TG Studio', 'Windows 10/11 · macOS (Intel và Apple Silicon) · bản thử nghiệm nội bộ', 3500);
  } catch (e) { await p.screenshot({ path: dir + '/fail.png' }); await ctx.close(); throw e; }
  const video = p.video();
  await ctx.close();
  return await video.path();
}
