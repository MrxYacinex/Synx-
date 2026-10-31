/**
 * End-to-end: real sync server + real SyncClient/AgentSession glue + the real
 * injected agent, running in Chromium against fake Instagram/TikTok feeds.
 * Each "phone" is its own browser context with its own feed order.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { startServer } from '../src/main';
import { SyncClient } from '../../app/src/shared/client';
import { AgentSession } from '../../app/src/shared/session';
import { PLATFORMS } from '../../app/src/shared/reel';
import type { PlatformId } from '../../app/src/shared/protocol';
import { installMockSites, IG_IDS, TT_IDS, type MockOptions } from './mock-sites';

const here = dirname(fileURLToPath(import.meta.url));
const AGENT = readFileSync(resolve(here, '../../app/src/agent/agent.generated.js'), 'utf8');

let browser: Browser;
let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer({ port: 0, log: false });
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});
const open: Phone[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((p) => p.close().catch(() => {})));
});
after(async () => {
  await browser?.close();
  await srv?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000, label = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  let last: T;
  for (;;) {
    try {
      last = await fn();
      if (ok(last)) return last;
    } catch {
      /* page navigating */
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last!)}`);
    await sleep(100);
  }
}

interface Phone {
  name: string;
  page: Page;
  client: SyncClient;
  session: AgentSession;
  logs: string[];
  close(): Promise<void>;
}

/** Simulates the app: what app/src/... does with a WebView, but with Playwright. */
interface NetOpts {
  /** This phone's clock is off by this many ms (like a real phone with a wrong clock). */
  skewMs?: number;
  /** One-way network latency in ms, plus random jitter. */
  latencyMs?: number;
  jitterMs?: number;
  site?: MockOptions;
}

/** A WebSocket that delivers every message late (in order), like a slow mobile network. */
function laggyWebSocket(latency: number, jitter: number) {
  return class LaggyWS {
    private ws: WebSocket;
    private lastOut = 0;
    private lastIn = 0;
    onopen: ((e: unknown) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(url: string) {
      this.ws = new WebSocket(url);
      this.ws.onopen = (e) => setTimeout(() => this.onopen?.(e), latency);
      this.ws.onclose = (e) => setTimeout(() => this.onclose?.(e), latency);
      this.ws.onerror = (e) => this.onerror?.(e);
      this.ws.onmessage = (e) => {
        const at = Math.max(this.lastIn + 1, Date.now() + latency + Math.random() * jitter);
        this.lastIn = at;
        setTimeout(() => this.onmessage?.({ data: e.data }), at - Date.now());
      };
    }
    get readyState() {
      return this.ws.readyState;
    }
    send(data: string) {
      const at = Math.max(this.lastOut + 1, Date.now() + latency + Math.random() * jitter);
      this.lastOut = at;
      setTimeout(() => this.ws.readyState === 1 && this.ws.send(data), at - Date.now());
    }
    close() {
      this.ws.close();
    }
  };
}

async function openPhone(name: string, platform: PlatformId, order: number[], join: { create: PlatformId } | { room: string }, net: NetOpts = {}): Promise<Phone> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: false });
  await installMockSites(ctx, order, net.site);
  const skew = net.skewMs ?? 0;
  const client = new SyncClient({
    url: `ws://127.0.0.1:${srv.port}`,
    clientId: `phone_${name}`,
    name,
    now: () => Date.now() + skew,
    WebSocketImpl: net.latencyMs ? (laggyWebSocket(net.latencyMs, net.jitterMs ?? 0) as never) : undefined,
  });
  const logs: string[] = [];
  let page: Page;
  const session = new AgentSession(client, (js) => void page?.evaluate(js).catch(() => {}), { log: (m) => (logs.push(m), process.env.DEBUG_SYNX && console.log(`[${name}] ${m}`)) });
  await ctx.exposeBinding('__synxToApp', (_src, data: string) => session.handleMessage(data));
  if (skew) await ctx.addInitScript(`(function(){var n=Date.now.bind(Date);Date.now=function(){return n()+${skew}};})();`);
  await ctx.addInitScript(
    `window.__SYNX_CONFIG__=${JSON.stringify({ platform, clientId: client.clientId, sound: false, debug: true })};` +
      `window.ReactNativeWebView={postMessage:function(d){window.__synxToApp(d)}};` +
      AGENT,
  );
  page = await ctx.newPage();
  if (process.env.DEBUG_SYNX) page.on('console', (m) => m.text().startsWith('[synx]') && console.log(`  (${name} console) ${m.text()}`));
  client.join(join);
  await until(() => client.status, (s) => s === 'connected', 5000, `${name} connected`);
  // Like the app: open the room's clip if there is one, else the platform home.
  const start = client.state.reel?.url ?? PLATFORMS[platform].homeUrl;
  await page.goto(start);
  const phone: Phone = { name, page, client, session, logs, close: async () => (client.close(), session.dispose(), await ctx.close()) };
  open.push(phone);
  return phone;
}

/** What is on screen right now, with a wall-clock stamp to compare phones fairly. */
async function look(p: Phone) {
  return p.page.evaluate(() => {
    const secs = Array.from(document.querySelectorAll<HTMLElement>('.item'));
    const sec = secs.find((s) => Math.abs(s.getBoundingClientRect().top) < 50) ?? null;
    const v = sec?.querySelector('video') ?? null;
    return {
      id: sec?.dataset.id ?? null,
      t: v?.currentTime ?? -1,
      paused: v?.paused ?? true,
      rate: v?.playbackRate ?? 0,
      dur: v?.duration ?? 0,
      wall: Date.now(),
      url: location.href,
    };
  });
}

/** Position gap between two phones at the same instant, accounting for looping. */
async function gap(a: Phone, b: Phone, rate: number) {
  const [x, y] = await Promise.all([look(a), look(b)]);
  const playing = !x.paused && !y.paused;
  let d = x.t + (playing ? ((y.wall - x.wall) / 1000) * rate : 0) - y.t;
  const dur = x.dur || 12;
  d = ((((d + dur / 2) % dur) + dur) % dur) - dur / 2;
  return { d: Math.abs(d), x, y };
}

async function expectInSync(a: Phone, b: Phone, opts: { rate?: number; paused?: boolean; tol?: number; ms?: number } = {}) {
  const tol = opts.tol ?? 0.25;
  const rate = opts.rate ?? 1;
  return until(
    () => gap(a, b, rate),
    ({ d, x, y }) =>
      x.id !== null &&
      x.id === y.id &&
      x.paused === y.paused &&
      (opts.paused === undefined || x.paused === opts.paused) &&
      d < tol &&
      // nominal speed (allow nudges of up to 12%)
      Math.abs(x.rate - rate) <= rate * 0.13 &&
      Math.abs(y.rate - rate) <= rate * 0.13,
    opts.ms ?? 10_000,
    `${a.name}/${b.name} in sync (rate ${rate}, paused ${opts.paused})`,
  );
}

/** A real user scroll: wheel events are what the agent sees as a gesture. */
async function swipeUp(p: Phone) {
  const before = (await look(p)).id;
  await p.page.mouse.move(195, 420);
  await p.page.mouse.wheel(0, 844);
  await until(() => look(p), (l) => l.id !== before && l.id !== null, 5000, `${p.name} scrolled`);
  // and the room has picked it up
  await until(() => p.client.state.reel?.id, (id) => id !== before, 5000, `${p.name}'s scroll published`);
}

test('instagram: two friends stay in sync through play, pause, speed, scroll, seek and drift', async () => {
  const ana = await openPhone('ana', 'instagram', [1, 2, 3, 4], { create: 'instagram' });
  // First clip on screen becomes the room's clip.
  await until(() => ana.client.state.reel?.id, (id) => id === IG_IDS[0], 8000, 'room picks first reel');

  const ben = await openPhone('ben', 'instagram', [3, 1, 4, 2], { room: ana.client.room! });
  let r = await expectInSync(ana, ben, { paused: false });
  assert.equal(r.x.id, IG_IDS[0]);
  assert.match(ben.page.url(), /\/reels\/DSynxClip001\//);

  // Ana taps the video -> pause for both.
  await sleep(1500);
  await ana.page.mouse.click(195, 420);
  r = await expectInSync(ana, ben, { paused: true, tol: 0.15 });
  const pausedAt = r.x.t;
  await sleep(1200);
  r = await expectInSync(ana, ben, { paused: true, tol: 0.15 });
  assert.ok(Math.abs(r.x.t - pausedAt) < 0.05, 'stays paused');

  // Ben taps -> play for both.
  await ben.page.mouse.click(195, 420);
  await expectInSync(ana, ben, { paused: false });

  // Ana switches to double speed from the Synx controls.
  ana.session.setRate(2);
  await expectInSync(ana, ben, { paused: false, rate: 2 });
  assert.equal(ben.client.state.rate, 2);

  // Ana scrolls to her next reel; Ben (whose feed is different) is taken there too.
  await swipeUp(ana);
  r = await expectInSync(ana, ben, { paused: false, rate: 2, ms: 12_000 });
  assert.equal(r.x.id, IG_IDS[1]);
  assert.equal(ana.client.state.reel?.id, IG_IDS[1]);

  // Ben scrolls in *his* feed; Ana follows him.
  await swipeUp(ben);
  r = await expectInSync(ana, ben, { paused: false, rate: 2, ms: 12_000 });
  assert.notEqual(r.x.id, IG_IDS[1]);
  assert.equal(r.x.id, ana.client.state.reel?.id);

  // Speed back to normal.
  ben.session.setRate(1);
  await expectInSync(ana, ben, { paused: false, rate: 1 });

  // Ben scrubs (a user seek) -> Ana jumps too.
  await ben.page.evaluate(() => {
    window.dispatchEvent(new Event('pointerdown'));
    const sec = Array.from(document.querySelectorAll<HTMLElement>('.item')).find((s) => Math.abs(s.getBoundingClientRect().top) < 50)!;
    const v = sec.querySelector('video')!;
    v.currentTime = (v.currentTime + 5) % 11;
  });
  await expectInSync(ana, ben, { paused: false });

  // Ana's player glitches (no user involved): she is pulled back into sync.
  await ana.page.evaluate(() => {
    const sec = Array.from(document.querySelectorAll<HTMLElement>('.item')).find((s) => Math.abs(s.getBoundingClientRect().top) < 50)!;
    const v = sec.querySelector('video')!;
    v.currentTime = (v.currentTime + 4) % 11;
  });
  await sleep(300);
  await expectInSync(ana, ben, { paused: false });

  // Ride through a loop boundary (12s clips) and stay locked.
  ana.session.setRate(2);
  await expectInSync(ana, ben, { paused: false, rate: 2 });
  const samples: number[] = [];
  for (let i = 0; i < 16; i++) {
    samples.push((await gap(ana, ben, 2)).d);
    await sleep(500);
  }
  const worst = Math.max(...samples);
  console.log(`  drift over 8s at 2x incl. loops: max ${(worst * 1000).toFixed(0)}ms, samples ${samples.map((s) => Math.round(s * 1000)).join(',')}`);
  assert.ok(samples.filter((s) => s > 0.35).length <= 1, `drift too high: ${samples.join(', ')}`);

  // A third friend joins late and lands on the same moment.
  const cleo = await openPhone('cleo', 'instagram', [4, 3, 2, 1], { room: ana.client.room! });
  await expectInSync(ana, cleo, { paused: false, rate: 2 });

});

test('tiktok-style feed (URL never changes, id only in the DOM) still syncs scrolling', async () => {
  const a = await openPhone('tia', 'tiktok', [1, 2, 3, 4], { create: 'tiktok' });
  await until(() => a.client.state.reel?.id, (id) => id === TT_IDS[0], 8000, 'room picks first tiktok');
  const b = await openPhone('tom', 'tiktok', [2, 4, 1, 3], { room: a.client.room! });
  let r = await expectInSync(a, b, { paused: false });
  assert.equal(r.y.id, TT_IDS[0]);

  await swipeUp(a);
  r = await expectInSync(a, b, { paused: false, ms: 12_000 });
  assert.equal(r.x.id, TT_IDS[1]);

  await b.page.mouse.click(195, 420);
  await expectInSync(a, b, { paused: true, tol: 0.15 });
});

test('a friend browsing a profile is not yanked back, and can rejoin', async () => {
  const a = await openPhone('una', 'instagram', [1, 2, 3, 4], { create: 'instagram' }, { site: { igUrlUpdates: true } });
  await until(() => a.client.state.reel?.id, (id) => id === IG_IDS[0], 8000, 'first reel');
  const b = await openPhone('vic', 'instagram', [2, 1, 3, 4], { room: a.client.room! }, { site: { igUrlUpdates: true } });
  await expectInSync(a, b, { paused: false });

  // Vic taps into a profile page (not a clip).
  await b.page.mouse.click(10, 10);
  await b.page.goto('https://www.instagram.com/someone/').catch((e) => console.log('goto failed', e.message.slice(0, 200)));
  if (process.env.DEBUG_SYNX) console.log('vic at', b.page.url());
  await b.page.evaluate(() => {
    history.replaceState(null, '', '/someone/');
    window.dispatchEvent(new Event('pointerdown'));
  });
  await until(() => b.session.status?.mode, (m) => m === 'away', 5000, 'away mode');
  await sleep(1500);
  assert.equal(b.session.status?.mode, 'away');

  b.session.rejoin();
  await expectInSync(a, b, { paused: false, ms: 12_000 });
});

test('slow network (150ms ± 60ms each way) and phones whose clocks are seconds apart', async () => {
  const ana = await openPhone('far-ana', 'instagram', [1, 2, 3, 4], { create: 'instagram' }, { skewMs: -4200, latencyMs: 150, jitterMs: 60 });
  await until(() => ana.client.state.reel?.id, (id) => id === IG_IDS[0], 8000, 'first reel');
  const ben = await openPhone('far-ben', 'instagram', [2, 3, 4, 1], { room: ana.client.room! }, { skewMs: 7300, latencyMs: 150, jitterMs: 60 });
  await sleep(2500); // let the clock estimate settle
  // Page clocks are skewed, so compare with the *real* time: undo the skew in the gap computation.
  const realGap = async (rate: number) => {
    const [x, y] = await Promise.all([look(ana), look(ben)]);
    const xr = x.wall + 4200; // real ms
    const yr = y.wall - 7300;
    const playing = !x.paused && !y.paused;
    let d = x.t + (playing ? ((yr - xr) / 1000) * rate : 0) - y.t;
    const dur = x.dur || 12;
    d = ((((d + dur / 2) % dur) + dur) % dur) - dur / 2;
    return { d: Math.abs(d), x, y };
  };
  await until(() => realGap(1), ({ d, x, y }) => x.id === y.id && !x.paused && !y.paused && d < 0.25, 10_000, 'in sync despite skew');
  console.log(`  clock offsets: ana ${Math.round(ana.client.clock.offset)}ms (true 4200), ben ${Math.round(ben.client.clock.offset)}ms (true -7300)`);
  assert.ok(Math.abs(ana.client.clock.offset - 4200) < 120);
  assert.ok(Math.abs(ben.client.clock.offset + 7300) < 120);

  await ana.page.mouse.click(195, 420);
  await until(() => realGap(1), ({ d, x, y }) => x.paused && y.paused && d < 0.1, 6000, 'paused together');
  await ben.page.mouse.click(195, 420);
  ben.session.setRate(2);
  await until(() => realGap(2), ({ d, x, y }) => !x.paused && !y.paused && d < 0.25 && Math.abs(x.rate - 2) < 0.3, 8000, '2x together');
  await swipeUp(ben);
  const r = await until(() => realGap(2), ({ d, x, y }) => x.id === y.id && !x.paused && d < 0.25, 12_000, 'scroll followed');
  assert.equal(r.x.id, IG_IDS[1]); // Ben's feed: [opened reel 1], then 2, 3, 4
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    samples.push((await realGap(2)).d);
    await sleep(400);
  }
  console.log(`  drift on slow network: max ${Math.round(Math.max(...samples) * 1000)}ms`);
  assert.ok(Math.max(...samples) < 0.35);
});

test('logged-out wall is reported as "login" and nobody gets dragged around', async () => {
  const a = await openPhone('wall-a', 'instagram', [1, 2, 3, 4], { create: 'instagram' }, { site: { loggedOutWall: true } });
  await until(() => a.session.status?.mode, (m) => m === 'login', 6000, 'login mode');
  await sleep(1000);
  assert.equal(a.client.state.reel, null); // nothing published from behind the wall
});
