/** Real Instagram: scroll the reels feed and check the agent tracks which reel is on screen. */
import { readFileSync } from 'node:fs';
import { chromium, devices } from 'playwright';
const AGENT = readFileSync(new URL('../../app/src/agent/agent.generated.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY! } });
const ctx = await browser.newContext({ ...devices['iPhone 15'] });
const statuses: any[] = [];
await ctx.exposeBinding('__synxToApp', (_s, d: string) => { const m = JSON.parse(d); if (m.type === 'status') statuses.push(m.status); });
await ctx.addInitScript(`window.__SYNX_CONFIG__=${JSON.stringify({ platform: 'instagram', clientId: 'probe_1', sound: false })};window.ReactNativeWebView={postMessage:function(d){window.__synxToApp(d)}};` + AGENT);
const page = await ctx.newPage();
await page.goto(process.argv[2] ?? 'https://www.instagram.com/reels/', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(6000);
await page.evaluate(() => (window as any).__synx.receive({ type: 'room', offset: 0, state: { reel: null, playing: true, rate: 1, position: 0, refTime: Date.now(), duration: null, version: 0, by: null, cause: 'init' } }));
await page.waitForTimeout(1500);
const show = (label: string) => { const s = statuses.at(-1); console.log(label.padEnd(14), 'url', page.url().replace('https://www.instagram.com', ''), '| agent reel', s?.reel?.id, '| mode', s?.mode, '| playing', s?.playing, '| t', s?.position?.toFixed(1)); };
show('start');
for (let i = 1; i <= 3; i++) {
  await page.evaluate(() => {
    const v = document.querySelector('video')!;
    let el: HTMLElement | null = v.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    el!.scrollBy({ top: el!.clientHeight });
  });
  await page.waitForTimeout(2500);
  show(`after scroll ${i}`);
}
await browser.close();
