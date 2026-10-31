/**
 * Smoke-test the agent against a REAL platform page (no login).
 *   npx tsx scripts/probe-real-site.ts youtube|instagram|tiktok
 * Prints what the agent detects: the active video, the clip id, and whether a
 * swipe is noticed as a clip change.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { PLATFORMS } from '../../app/src/shared/reel';
import type { PlatformId } from '../../app/src/shared/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const AGENT = readFileSync(resolve(here, '../../app/src/agent/agent.generated.js'), 'utf8');
const platform = (process.argv[2] ?? 'youtube') as PlatformId;
const startUrl = process.argv[3] ?? PLATFORMS[platform].homeUrl;
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;

const browser = await chromium.launch({ proxy, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ ...devices['iPhone 15'], hasTouch: true, locale: 'en-US' });
const statuses: any[] = [];
const publishes: any[] = [];
await ctx.exposeBinding('__synxToApp', (_s, data: string) => {
  const m = JSON.parse(data);
  if (m.type === 'status') statuses.push(m.status);
  if (m.type === 'publish') publishes.push(m.update);
  if (m.type === 'log') console.log('  [agent]', m.msg);
});
await ctx.addInitScript(
  `window.__SYNX_CONFIG__=${JSON.stringify({ platform, clientId: 'probe_1', sound: false, debug: true })};` +
    `window.ReactNativeWebView={postMessage:function(d){window.__synxToApp(d)}};` +
    AGENT,
);
const page = await ctx.newPage();
console.log(`opening ${startUrl}`);
await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e) => console.log('goto:', e.message));
// Give the agent an (empty) room so it starts following/publishing.
const room = { reel: null, playing: true, rate: 1, position: 0, refTime: Date.now(), duration: null, version: 0, by: null, cause: 'init' };
await page.waitForTimeout(8000);
await page.evaluate((r) => window.__synx?.receive({ type: 'room', state: r as any, offset: 0 }), room).catch(() => {});
await page.waitForTimeout(4000);
const last = () => statuses.at(-1);
console.log('url        :', page.url());
console.log('videos     :', await page.evaluate(() => document.querySelectorAll('video').length));
console.log('status     :', JSON.stringify(last()));
console.log('published  :', publishes.map((p) => `${p.cause}:${p.reel?.id}`).join(', ') || '(none)');

// Swipe up like a user.
const vp = page.viewportSize()!;
const cdp = await ctx.newCDPSession(page);
const x = vp.width / 2;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: vp.height * 0.75 }] });
for (let i = 1; i <= 8; i++) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: vp.height * (0.75 - i * 0.07) }] });
  await page.waitForTimeout(16);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.mouse.wheel(0, vp.height); // in case touch scrolling is not wired
await page.waitForTimeout(5000);
console.log('after swipe:', page.url());
console.log('status     :', JSON.stringify(last()));
console.log('published  :', publishes.map((p) => `${p.cause}:${p.reel?.id}`).join(', ') || '(none)');
console.log('video rects:', JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('video')).map((v) => {
  const r = v.getBoundingClientRect();
  const p = v.parentElement?.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), parent: p && [Math.round(p.x), Math.round(p.y), Math.round(p.width), Math.round(p.height)], rs: v.readyState, paused: v.paused, src: (v.currentSrc || '').slice(0, 40), cls: v.className };
}))));
await page.screenshot({ path: resolve(here, `../../.probe-${platform}.png`) });
await browser.close();
