import { chromium, devices } from 'playwright';
const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY! } });
const ctx = await browser.newContext({ ...devices['iPhone 15'] });
await ctx.addInitScript('window.__name = (f) => f;');
const page = await ctx.newPage();
await page.goto('https://www.instagram.com/reels/', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(7000);
console.log('url', page.url());
const code = page.url().match(/reels\/([^/]+)/)![1];
const out = await page.evaluate((code) => {
  const found: string[] = [];
  const seen = new WeakSet();
  const scan = (o: any, path: string, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 4 || seen.has(o)) return;
    seen.add(o);
    for (const k of Object.keys(o)) {
      if (k === 'children' || k.startsWith('_owner') || k === 'return' || k === 'stateNode') continue;
      let val: any; try { val = o[k]; } catch { continue; }
      if (typeof val === 'string' && val.includes(code)) found.push(`${path}.${k}=${val.slice(0, 80)}`);
      else if (val && typeof val === 'object') scan(val, `${path}.${k}`, depth + 1);
    }
  };
  const vids = Array.from(document.querySelectorAll('video'));
  const v = vids.find((x) => Math.abs(x.getBoundingClientRect().y) < 5)!;
  const fk = Object.keys(v).find((k) => k.startsWith('__reactFiber$'))!;
  let f = (v as any)[fk];
  for (let i = 0; f && i < 200; i++, f = f.return) {
    scan(f.memoizedProps, `L${i}:${typeof f.type === 'string' ? f.type : f.type?.displayName || f.type?.name || '?'}`, 0);
    if (found.length > 12) break;
  }
  // also: DOM attributes anywhere in the doc containing the code
  const attrs: string[] = [];
  document.querySelectorAll('*').forEach((el) => { for (const a of Array.from(el.attributes)) if (a.value.includes(code)) attrs.push(`${el.tagName}[${a.name}]=${a.value.slice(0, 80)}`); });
  return { found: found.slice(0, 14), attrs: attrs.slice(0, 10), nVideos: vids.length };
}, code);
console.log(JSON.stringify(out, null, 1));
await browser.close();
