import { chromium, devices } from 'playwright';
const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY! } });
const ctx = await browser.newContext({ ...devices['iPhone 15'] });
await ctx.addInitScript('window.__name = (f) => f;');
const page = await ctx.newPage();
await page.goto('https://www.instagram.com/reels/', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(7000);
console.log('url', page.url());
console.log(await page.evaluate(() => {
  const nearest = (v: any) => {
    const fk = Object.keys(v).find((k) => k.startsWith('__reactFiber$'));
    if (!fk) return null;
    let f = v[fk];
    const seen = new WeakSet();
    const scan = (o: any, depth: number): string | null => {
      if (!o || typeof o !== 'object' || depth > 4 || seen.has(o)) return null;
      seen.add(o);
      for (const k of Object.keys(o)) {
        if (k === 'children' || k === '_owner') continue;
        const val = o[k];
        if ((k === 'code' || k === 'shortcode') && typeof val === 'string' && /^[A-Za-z0-9_-]{9,40}$/.test(val)) return val;
        if (val && typeof val === 'object') { const r = scan(val, depth + 1); if (r) return r; }
      }
      return null;
    };
    for (let i = 0; f && i < 60; i++, f = f.return) { const r = scan(f.memoizedProps, 0); if (r) return `${r}@L${i}`; }
    return null;
  };
  return Array.from(document.querySelectorAll('video')).map((v) => `${Math.round(v.getBoundingClientRect().y)} -> ${nearest(v)}`).join('\n');
}));
await browser.close();
