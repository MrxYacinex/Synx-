/**
 * A tiny fake of the Instagram Reels / TikTok web feeds, used to test the
 * Synx agent end-to-end in Chromium. It mimics the behaviours that matter:
 *  - a vertical, scroll-snapped feed where only the visible clip plays
 *  - clips loop forever
 *  - Instagram mode (like the real site, verified Oct 2026): the URL does NOT
 *    change as you scroll; the clip's shortcode only lives in React props on
 *    the clip component (we fake a React fiber on each <video>). Optionally
 *    the URL can update too (igUrlUpdates) to cover both behaviours.
 *  - an optional logged-out wall ("Watch this reel in the app")
 *  - TikTok mode: the URL stays at /foryou; the clip id only lives in the DOM
 *  - tapping a clip toggles pause
 *  - every user gets a different ("personalised") feed order
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Route } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));

export const IG_IDS = ['DSynxClip001', 'DSynxClip002', 'DSynxClip003', 'DSynxClip004'];
export const TT_IDS = ['7400000000000000001', '7400000000000000002', '7400000000000000003', '7400000000000000004'];

export interface MockOptions {
  igUrlUpdates?: boolean;
  loggedOutWall?: boolean;
}

function page(mode: 'instagram' | 'tiktok', ids: string[], opts: MockOptions): string {
  const items = ids
    .map((id) => {
      const n = (mode === 'instagram' ? IG_IDS : TT_IDS).indexOf(id) + 1;
      const wrapper = mode === 'tiktok' ? `id="xgwrapper-0-${id}"` : '';
      return `<section class="item" data-id="${id}"><div ${wrapper} class="player"><video src="/media/clip${n}.webm" playsinline loop preload="auto"></video></div><div class="cap">@user${n} · clip ${n}</div></section>`;
    })
    .join('');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000;color:#fff;font-family:sans-serif}
#feed{height:100vh;overflow-y:scroll;scroll-snap-type:y mandatory}
.item{height:100vh;scroll-snap-align:start;position:relative}
.player,video{width:100%;height:100%;object-fit:cover;display:block}
.cap{position:absolute;bottom:20px;left:12px}</style></head>
<body><div id="feed">${items}</div>
${opts.loggedOutWall ? '<div role="dialog" style="position:fixed;inset:20% 10%;background:#fff;color:#000;padding:20px">Watch this reel in the app<br><button>Open Instagram</button> <a href="/accounts/emailsignup/">Sign up</a></div>' : ''}
<script>
  const MODE = ${JSON.stringify(mode)};
  const URL_UPDATES = ${JSON.stringify(!!opts.igUrlUpdates)};
  if (MODE === 'instagram') {
    // Fake React fiber: <video> -> div -> clip component whose props hold the shortcode.
    document.querySelectorAll('.item').forEach((sec) => {
      const v = sec.querySelector('video');
      const clip = { memoizedProps: { fragmentKey: { __fragments: { PolarisReelsViewer_media_identifier: { code: sec.dataset.id } } } }, return: { memoizedProps: { code: 'en' }, return: null } };
      v.__reactFiber$mock = { memoizedProps: { src: v.src, playsInline: true }, return: { memoizedProps: { className: 'x1' }, return: clip } };
    });
  }
  const feed = document.getElementById('feed');
  let current = null;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.intersectionRatio < 0.6) continue;
      const sec = e.target;
      if (current === sec) continue;
      current = sec;
      document.querySelectorAll('video').forEach(v => { if (v !== sec.querySelector('video')) v.pause(); });
      const v = sec.querySelector('video');
      v.currentTime = 0;
      v.play().catch(() => {});
      if (MODE === 'instagram' && URL_UPDATES) history.replaceState(null, '', '/reels/' + sec.dataset.id + '/');
    }
  }, { root: feed, threshold: [0.6] });
  document.querySelectorAll('.item').forEach(s => io.observe(s));
  document.querySelectorAll('video').forEach(v => v.addEventListener('click', () => v.paused ? v.play() : v.pause()));
</script></body></html>`;
}

function serveMedia(route: Route, n: string) {
  const file = resolve(here, 'fixtures', `clip${n}.webm`);
  const size = statSync(file).size;
  const range = route.request().headers()['range'];
  const data = readFileSync(file);
  const m = range?.match(/bytes=(\d+)-(\d*)/);
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    return route.fulfill({
      status: 206,
      headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
      body: data.subarray(start, end + 1),
    });
  }
  return route.fulfill({ status: 200, headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes' }, body: data });
}

/** Install the fake sites into a browser context. `order` is this user's feed order. */
export async function installMockSites(ctx: BrowserContext, order: number[], opts: MockOptions = {}) {
  await ctx.route(/https:\/\/www\.(instagram|tiktok)\.com\/.*/, (route) => {
    const url = new URL(route.request().url());
    const media = url.pathname.match(/^\/media\/clip(\d)\.webm$/);
    if (media) return serveMedia(route, media[1]);
    const ig = url.hostname.includes('instagram');
    if (ig && !/^\/(reels?\/|$)/.test(url.pathname)) {
      // A profile or other non-clip page: thumbnails only, no players.
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><body style="background:#000;color:#fff"><h1>@someone</h1><div style="height:2000px">grid</div></body>' });
    }
    const all = ig ? IG_IDS : TT_IDS;
    const mine = order.map((i) => all[i - 1]);
    const m = ig ? url.pathname.match(/^\/reels?\/([A-Za-z0-9_-]+)/) : url.pathname.match(/\/video\/(\d+)/);
    const first = m && all.includes(m[1]) ? m[1] : null;
    const ids = first ? [first, ...mine.filter((x) => x !== first)] : mine;
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: page(ig ? 'instagram' : 'tiktok', ids, opts) });
  });
}
