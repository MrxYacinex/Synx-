import { chromium, devices } from 'playwright';
const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY! } });
const ctx = await browser.newContext({ ...devices['iPhone 15'] });
const page = await ctx.newPage();
await page.goto('https://www.instagram.com/reels/', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(7000);
console.log('start url', page.url());
const info = await page.evaluate(() => {
  const v = document.querySelector('video')!;
  let el: HTMLElement | null = v.parentElement;
  while (el && !(el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  (window as any).__sc = el ?? document.scrollingElement;
  const sc = (window as any).__sc as HTMLElement;
  // anchors near each video
  const vids = Array.from(document.querySelectorAll('video')).map((vv) => {
    let a: Element | null = vv; let href = null;
    for (let i = 0; i < 12 && a; i++, a = a.parentElement) { const l = a.querySelector('a[href*="/reel"]'); if (l) { href = l.getAttribute('href'); break; } }
    return href;
  });
  const dialog = document.querySelector('[role="dialog"]');
  return { container: sc.tagName + '.' + sc.className.slice(0, 30), h: sc.clientHeight, sh: sc.scrollHeight, vids, dialog: dialog?.textContent?.slice(0, 80), cookies: document.cookie.split(';').map((c) => c.split('=')[0].trim()) };
});
console.log(JSON.stringify(info, null, 1));
for (let i = 0; i < 2; i++) {
  await page.evaluate(() => { const sc = (window as any).__sc as HTMLElement; sc.scrollBy({ top: sc.clientHeight }); });
  await page.waitForTimeout(3000);
  console.log('after scroll', i + 1, page.url(), await page.evaluate(() => Array.from(document.querySelectorAll('video')).map((v) => `${Math.round(v.getBoundingClientRect().y)}:${v.paused ? 'p' : 'P'}`).join(' ')));
}
await browser.close();
