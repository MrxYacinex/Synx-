/// <reference lib="dom" />
/**
 * The Synx page agent. It is bundled into a plain string and injected into the
 * Instagram / TikTok / YouTube page that runs inside the app's WebView.
 *
 * Responsibilities:
 *  - find the clip that is currently on screen (the most visible <video>)
 *  - figure out which clip it is (URL, or DOM hints)
 *  - notice when *this* user scrolls, pauses, seeks or changes speed and
 *    publish that as the new room state
 *  - make the local player follow the room state: same clip, same play/pause,
 *    same speed and the same position (gentle speed nudges for small drift,
 *    hard seeks for big drift)
 */
import type { AgentConfig, AgentStatus, FromAgent, ToAgent } from '../shared/bridge';
import type { PlaybackState, PlaybackUpdate, Reel, StateCause } from '../shared/protocol';
import { parseReelUrl, canonicalReelUrl, PLATFORMS } from '../shared/reel';
import { expectedPosition, loopDiff, planCorrection } from '../shared/sync';

declare global {
  interface Window {
    __SYNX_CONFIG__?: AgentConfig;
    __synx?: { receive(msg: ToAgent | string): void; version: number; debug(): unknown };
    ReactNativeWebView?: { postMessage(data: string): void };
  }
}

const AGENT_VERSION = 1;
const TICK_MS = 200;
/** A page event counts as "the user did it" if they touched the page this recently. */
const GESTURE_WINDOW = 2500;
/** Swiping to the next clip can take a while to show up on slow networks. */
const REEL_GESTURE_WINDOW = 8000;
/** After a remote-triggered navigation, how long to wait before trying again. */
const NAV_RETRY_MS = 7000;
const MAX_NAV_ATTEMPTS = 3;
/** After publishing, the publisher is the authority for this long (fix-ups instead of seeking). */
const AUTHORITY_MS = 1500;
/** Being on a non-clip page with recent touches means the user is browsing on purpose. */
const AWAY_WINDOW = 15_000;

(function main() {
  if (window.__synx && window.__synx.version >= AGENT_VERSION) return;
  const config: AgentConfig = window.__SYNX_CONFIG__ ?? { platform: 'instagram', clientId: 'unknown', sound: true };

  // ------------------------------------------------------------------ state
  let room: PlaybackState | null = null;
  let offset = 0; // serverNow = Date.now() + offset
  let lastGesture = 0;
  let wantSound = config.sound;
  let navigating = false;
  let lastPublishAt = 0;
  let lastUrl = location.href;
  let active: HTMLVideoElement | null = null;
  /** Rate we last assigned (nominal or nudged) so we can recognise our own ratechange events. */
  let rateWeSet: number | null = null;
  let nudging = false;
  /** Our own play/pause/seek calls, so their events are not mistaken for user actions. */
  const selfActions: Record<'play' | 'pause' | 'seek', number> = { play: 0, pause: 0, seek: 0 };
  let forceRejoin = false;
  /** A user play/pause waiting to be confirmed (see onMediaEvent). */
  let pendingToggle: { playing: boolean; video: HTMLVideoElement; reelId: string | null; at: number; gesture: string } | null = null;
  const TOGGLE_CONFIRM_MS = 300;
  let lastStatusAt = 0;
  let lastStatusJson = '';
  let playBlocked = false;
  const outbox: string[] = [];

  const serverNow = () => Date.now() + offset;
  const now = () => Date.now();
  const userActive = (window = GESTURE_WINDOW) => now() - lastGesture < window;

  function post(msg: FromAgent) {
    const data = JSON.stringify(msg);
    const bridge = window.ReactNativeWebView;
    if (bridge) {
      while (outbox.length) bridge.postMessage(outbox.shift()!);
      bridge.postMessage(data);
    } else {
      outbox.push(data);
      if (outbox.length > 50) outbox.shift();
    }
  }
  function log(msg: string) {
    if (!config.debug) return;
    console.log('[synx] ' + msg);
    post({ type: 'log', msg });
  }

  // --------------------------------------------------------- gesture tracking
  let lastGestureType = '';
  // Remember touches across full page loads in this tab, so tapping a link that
  // reloads the page still counts as "the user went there on purpose".
  const GESTURE_KEY = 'synx-gesture';
  let lastStored = 0;
  const storeGesture = (t: number) => {
    try {
      sessionStorage.setItem(GESTURE_KEY, String(t));
    } catch {
      /* storage blocked */
    }
  };
  try {
    lastGesture = Number(sessionStorage.getItem(GESTURE_KEY)) || 0;
  } catch {
    /* storage blocked */
  }
  const resetGesture = () => {
    lastGesture = 0;
    storeGesture(0);
  };
  const markGesture = (e: Event) => {
    lastGesture = now();
    lastGestureType = e.type + (e.isTrusted ? '' : '(synthetic)');
    if (lastGesture - lastStored > 500) {
      lastStored = lastGesture;
      storeGesture(lastGesture);
    }
  };
  window.addEventListener('pagehide', () => lastGesture && storeGesture(lastGesture));
  for (const ev of ['touchstart', 'touchmove', 'pointerdown', 'mousedown', 'wheel', 'keydown'] as const) {
    window.addEventListener(ev, markGesture, { capture: true, passive: true });
  }

  // ------------------------------------------------------- finding the video
  function visibleFraction(el: Element): number {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return 0;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return 0;
    return (w * h) / (vw * vh);
  }

  function findActiveVideo(): HTMLVideoElement | null {
    let best: HTMLVideoElement | null = null;
    let bestScore = 0;
    for (const v of Array.from(document.querySelectorAll('video'))) {
      const frac = visibleFraction(v);
      if (frac < 0.12) continue;
      // Prefer what is on screen; break ties toward the one that is playing.
      const score = frac + (v.paused ? 0 : 0.05);
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  }

  // ------------------------------------------------------ identifying the clip
  function reelFromDom(video: HTMLVideoElement): Reel | null {
    let el: Element | null = video;
    for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
      // Do not climb into a container that holds other videos too.
      if (depth > 0 && el.querySelectorAll('video').length > 1) break;
      const links = el.querySelectorAll<HTMLAnchorElement>('a[href]');
      for (const a of Array.from(links)) {
        const r = parseReelUrl(a.getAttribute('href') || '', location.href);
        if (r && r.platform === config.platform) return r;
      }
      if (config.platform === 'tiktok') {
        const m = (el.id || '').match(/(\d{15,21})/) || (el.getAttribute('data-video-id') || '').match(/(\d{15,21})/);
        if (m) return { platform: 'tiktok', id: m[1], url: canonicalReelUrl('tiktok', m[1]) };
      }
      const explicit = el.getAttribute('data-synx-reel');
      if (explicit) return { platform: config.platform, id: explicit, url: canonicalReelUrl(config.platform, explicit) };
    }
    return null;
  }

  /**
   * Instagram (and TikTok) render with React. The clip component that owns a
   * <video> carries the clip's id in its props, e.g. Instagram's
   * `…media_identifier.code = "DfFNtKPNr6F"`. Walking up from the video to the
   * nearest such prop tells us exactly which clip is on screen, even when the
   * site doesn't update the URL while you scroll (Instagram doesn't).
   */
  const ID_KEYS: Partial<Record<AgentConfig['platform'], { keys: string[]; re: RegExp }>> = {
    instagram: { keys: ['code', 'shortcode'], re: /^[A-Za-z0-9_-]{9,40}$/ },
    tiktok: { keys: ['videoId', 'itemId', 'aweme_id', 'id'], re: /^\d{15,21}$/ },
  };
  const fiberCache = new WeakMap<HTMLVideoElement, { id: string | null; at: number; src: string }>();

  function reelFromReact(video: HTMLVideoElement): Reel | null {
    const spec = ID_KEYS[config.platform];
    if (!spec) return null;
    const src = video.currentSrc || video.src || '';
    const cached = fiberCache.get(video);
    if (cached && cached.src === src && now() - cached.at < 1000) {
      return cached.id ? { platform: config.platform, id: cached.id, url: canonicalReelUrl(config.platform, cached.id) } : null;
    }
    let id: string | null = null;
    try {
      const anyVideo = video as unknown as Record<string, unknown>;
      const fk = Object.keys(anyVideo).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      type Fiber = { memoizedProps?: unknown; return?: Fiber | null };
      let f = fk ? (anyVideo[fk] as Fiber | null) : null;
      const seen = new WeakSet<object>();
      let budget = 4000; // keep this cheap even on huge prop trees
      const scan = (o: unknown, depth: number): string | null => {
        if (!o || typeof o !== 'object' || depth > 4 || seen.has(o) || budget-- <= 0) return null;
        seen.add(o);
        for (const k of Object.keys(o)) {
          if (k === 'children' || k === '_owner' || k === 'ref') continue;
          let val: unknown;
          try {
            val = (o as Record<string, unknown>)[k];
          } catch {
            continue;
          }
          if (typeof val === 'string' && spec.keys.includes(k) && spec.re.test(val)) return val;
          if (val && typeof val === 'object' && !(val instanceof Node)) {
            const r = scan(val, depth + 1);
            if (r) return r;
          }
        }
        return null;
      };
      for (let i = 0; f && i < 60 && !id; i++, f = f.return ?? null) id = scan(f.memoizedProps, 0);
    } catch {
      id = null;
    }
    fiberCache.set(video, { id, at: now(), src });
    return id ? { platform: config.platform, id, url: canonicalReelUrl(config.platform, id) } : null;
  }

  function currentReel(video: HTMLVideoElement | null): Reel | null {
    const fromReact = video ? reelFromReact(video) : null;
    if (fromReact) return fromReact;
    const fromUrl = parseReelUrl(location.href);
    if (fromUrl && fromUrl.platform === config.platform) return fromUrl;
    return video ? reelFromDom(video) : null;
  }

  function isLoginPage(): boolean {
    if (/\/(accounts\/login|accounts\/emailsignup|login|signup|signin|challenge)/i.test(location.pathname) || location.hostname.startsWith('accounts.')) return true;
    // Logged-out walls ("Watch this reel in the app" / "Log in to continue") that block the feed.
    for (const d of Array.from(document.querySelectorAll('[role="dialog"]'))) {
      if (visibleFraction(d) < 0.15) continue;
      const text = (d.textContent || '').slice(0, 400);
      if (/(in the app|log in|sign up|continue with)/i.test(text)) return true;
    }
    return false;
  }

  const isPlatformRoot = () => /^\/(accounts\/onetap\/?)?$/.test(location.pathname) && location.hostname.includes(config.platform === 'youtube' ? 'youtube' : config.platform);

  // ----------------------------------------------------------- media helpers
  const finiteDuration = (v: HTMLVideoElement | null) => (v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);

  function setRate(v: HTMLVideoElement, rate: number) {
    if (Math.abs(v.playbackRate - rate) < 0.001) return;
    rateWeSet = rate;
    try {
      v.playbackRate = rate;
    } catch {
      /* some players lock the rate */
    }
  }

  function doPlay(v: HTMLVideoElement) {
    selfActions.play = now();
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.then(() => (playBlocked = false)).catch((err: Error) => {
        if (err && err.name === 'NotAllowedError') {
          // Autoplay with sound is blocked: fall back to muted playback.
          playBlocked = true;
          v.muted = true;
          selfActions.play = now();
          v.play().catch(() => {});
        }
      });
    }
  }

  function doPause(v: HTMLVideoElement) {
    selfActions.pause = now();
    v.pause();
  }

  function doSeek(v: HTMLVideoElement, to: number) {
    const d = finiteDuration(v);
    if (d) to = Math.max(0, Math.min(d - 0.05, to));
    selfActions.seek = now();
    try {
      v.currentTime = to;
    } catch {
      /* not seekable yet */
    }
  }

  const recentlySelf = (k: keyof typeof selfActions, ms = 600) => now() - selfActions[k] < ms;

  // -------------------------------------------------------------- publishing
  function snapshot(v: HTMLVideoElement, cause: StateCause, over: Partial<PlaybackUpdate> = {}): PlaybackUpdate {
    return {
      reel: currentReel(v) ?? room?.reel ?? null,
      playing: !v.paused,
      rate: room?.rate ?? 1,
      position: v.currentTime || 0,
      refTime: serverNow(),
      duration: finiteDuration(v),
      cause,
      ...over,
    };
  }

  function publish(update: PlaybackUpdate) {
    lastPublishAt = now();
    // Apply optimistically so the next tick doesn't see a "difference" again.
    room = { ...update, version: room?.version ?? 0, by: config.clientId };
    log(`publish ${update.cause} ${update.reel?.id} playing=${update.playing} pos=${update.position.toFixed(2)} rate=${update.rate}`);
    post({ type: 'publish', update });
  }

  // ---------------------------------------------------- local change detection
  function onMediaEvent(e: Event) {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || v !== active || !room || navigating) return;
    const reel = currentReel(v);
    if (room.reel && reel && reel.id !== room.reel.id) return; // handled by the tick
    switch (e.type) {
      case 'play':
      case 'pause': {
        const kind = e.type;
        if (recentlySelf(kind)) return;
        const playing = kind === 'play';
        if (playing === room.playing || !userActive()) return;
        // Don't publish yet: feeds pause the outgoing clip when you swipe, which
        // must not pause everyone. Confirm in a moment that it was a real tap.
        pendingToggle = { playing, video: v, reelId: reel?.id ?? null, at: now(), gesture: lastGestureType };
        break;
      }
      case 'seeked': {
        if (recentlySelf('seek', 1200) || !userActive()) return;
        const target = expectedPosition({ ...room, duration: room.duration ?? finiteDuration(v) }, serverNow());
        if (Math.abs(loopDiff(target, v.currentTime, room.duration ?? finiteDuration(v))) < 1) return; // a loop, or tiny
        publish(snapshot(v, 'seek', { playing: room.playing }));
        break;
      }
      case 'ratechange': {
        if (rateWeSet !== null && Math.abs(v.playbackRate - rateWeSet) < 0.001) return;
        if (!userActive()) return;
        const rate = v.playbackRate;
        if (Math.abs(rate - room.rate) < 0.001) return;
        nudging = false;
        rateWeSet = rate;
        publish(snapshot(v, 'rate', { rate, playing: room.playing }));
        break;
      }
      case 'volumechange': {
        if (!userActive() || recentlySelf('play')) return;
        if (wantSound === !v.muted) return;
        wantSound = !v.muted;
        break;
      }
    }
  }
  for (const ev of ['play', 'pause', 'seeked', 'ratechange', 'volumechange']) {
    document.addEventListener(ev, onMediaEvent, true); // media events don't bubble, but they do capture
  }

  // ----------------------------------------------------------- navigation
  function navAttempts(id: string): number {
    try {
      const raw = sessionStorage.getItem('synx-nav');
      const rec = raw ? (JSON.parse(raw) as { id: string; n: number; at: number }) : null;
      if (rec && rec.id === id && now() - rec.at < 60_000) return rec.n;
    } catch {
      /* storage blocked */
    }
    return 0;
  }
  function recordNav(id: string) {
    try {
      sessionStorage.setItem('synx-nav', JSON.stringify({ id, n: navAttempts(id) + 1, at: now() }));
    } catch {
      /* storage blocked */
    }
  }
  let lastNavAt = 0;
  function navigateTo(reel: Reel): AgentStatus['mode'] {
    if (navigating) return 'navigating';
    if (now() - lastNavAt < NAV_RETRY_MS) return 'navigating';
    if (navAttempts(reel.id) >= MAX_NAV_ATTEMPTS && !forceRejoin) return 'nav-failed';
    forceRejoin = false;
    // Prefer an in-page link to the clip (SPA navigation, no reload).
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find((a) => {
      const r = parseReelUrl(a.getAttribute('href') || '', location.href);
      return r && r.id === reel.id;
    });
    lastNavAt = now();
    recordNav(reel.id);
    log(`navigate to ${reel.id} via ${link ? 'link' : 'location'}`);
    if (link) {
      link.click();
    } else {
      navigating = true;
      location.href = reel.url;
    }
    return 'navigating';
  }

  // ------------------------------------------------------------------ tick
  function tick() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      navigating = false;
    }
    const v = findActiveVideo();
    if (v !== active) {
      active = v;
      nudging = false;
      rateWeSet = null;
    }
    const reel = currentReel(v);
    if (pendingToggle && now() - pendingToggle.at >= TOGGLE_CONFIRM_MS) {
      const p = pendingToggle;
      pendingToggle = null;
      const stillHere = v === p.video && (reel?.id ?? null) === p.reelId && !navigating;
      if (stillHere && room && v && v.paused === !p.playing && p.playing !== room.playing) {
        log(`user ${p.playing ? 'play' : 'pause'} (gesture ${p.gesture})`);
        publish(snapshot(v, p.playing ? 'play' : 'pause', { playing: p.playing }));
      }
    }
    let mode: AgentStatus['mode'] = 'waiting';
    let drift: number | null = null;

    if (room && !navigating) {
      mode = step(v, reel);
      if (mode === 'synced' || mode === 'syncing') {
        const d = room.duration ?? finiteDuration(v);
        drift = v ? loopDiff(expectedPosition({ ...room, duration: d }, serverNow()), v.currentTime, d) : null;
      }
    } else if (navigating) {
      mode = 'navigating';
    }

    if (v && wantSound && v.muted && !playBlocked) v.muted = false;

    const status: AgentStatus = {
      url: location.href,
      reel,
      hasVideo: !!v,
      playing: !!v && !v.paused,
      position: v ? v.currentTime : 0,
      duration: finiteDuration(v),
      drift,
      soundOn: !!v && !v.muted,
      mode,
    };
    const json = JSON.stringify({ ...status, position: Math.round(status.position), drift: drift === null ? null : Math.round(drift * 10) });
    if (json !== lastStatusJson || now() - lastStatusAt > 2000) {
      lastStatusJson = json;
      lastStatusAt = now();
      post({ type: 'status', status });
    }
  }

  /** One sync step. Returns what we're doing. */
  function step(v: HTMLVideoElement | null, reel: Reel | null): AgentStatus['mode'] {
    const r = room!;
    if (!/^https?:$/.test(location.protocol)) return 'waiting';
    if (isLoginPage()) return 'login';

    // 1) Which clip?
    if (reel && (!r.reel || reel.id !== r.reel.id)) {
      // We are on a different clip than the room.
      const noClipYet = !r.reel;
      const userScrolled = userActive(REEL_GESTURE_WINDOW) && !forceRejoin;
      if (noClipYet || userScrolled) {
        // This user moved on (or is the first one here): everyone follows.
        // Wait until the new clip's player is on screen so we publish its real position.
        if (!v) return 'syncing';
        publish(snapshot(v, 'reel', { reel, position: v.currentTime || 0, playing: noClipYet ? !v.paused || r.playing : true }));
        return 'synced';
      }
      if (!r.reel) return 'waiting';
      if (v && !v.paused) doPause(v); // don't play the wrong clip while we catch up
      return navigateTo(r.reel);
    }
    if (!reel) {
      if (!r.reel) {
        // Landed on the home feed (e.g. right after logging in): go to the clips feed.
        if (isPlatformRoot() && !userActive(AWAY_WINDOW) && now() - lastNavAt > NAV_RETRY_MS) {
          lastNavAt = now();
          navigating = true;
          location.href = PLATFORMS[config.platform].homeUrl;
          return 'navigating';
        }
        return v ? 'no-clip' : 'waiting';
      }
      if (userActive(AWAY_WINDOW) && !forceRejoin) return 'away';
      return navigateTo(r.reel);
    }
    forceRejoin = false;
    if (!v) return 'syncing';

    // 2) Speed. (Nudged speeds are handled below.)
    // 3) Play / pause.
    if (pendingToggle && pendingToggle.video === v) return 'syncing'; // user just tapped; hold on
    if (r.playing && v.paused && !recentlySelf('play', 800)) doPlay(v);
    if (!r.playing && !v.paused && !recentlySelf('pause', 300)) doPause(v);

    // 4) Position.
    if (v.readyState < 1) return 'syncing';
    const duration = r.duration ?? finiteDuration(v);
    const target = expectedPosition({ ...r, duration }, serverNow());
    const diff = loopDiff(target, v.currentTime, duration);
    const authority = r.by === config.clientId && now() - lastPublishAt < AUTHORITY_MS;
    if (authority && Math.abs(diff) > 0.5) {
      // We just published but our own player disagrees (e.g. the clip swapped
      // under us). We are the source of truth: correct the room, not the player.
      publish(snapshot(v, 'sync', { playing: r.playing, rate: r.rate }));
      return 'synced';
    }
    const c = planCorrection(diff, target, r.playing && !v.paused, r.rate, nudging);
    // Don't hammer a buffering player with seeks; it will be corrected once it plays.
    const canSeek = !v.seeking && !recentlySelf('seek', 700) && (v.readyState >= 2 || !r.playing);
    if (c.kind === 'seek' && canSeek) {
      log(`seek ${v.currentTime.toFixed(2)} -> ${c.to.toFixed(2)} (diff ${diff.toFixed(2)})`);
      doSeek(v, c.to);
      nudging = false;
      setRate(v, r.rate);
    } else if (c.kind === 'nudge') {
      nudging = true;
      setRate(v, c.rate);
    } else if (c.kind === 'none') {
      nudging = false;
      setRate(v, r.rate);
    }
    return Math.abs(diff) < 0.25 ? 'synced' : 'syncing';
  }

  // -------------------------------------------------------- commands from app
  function command(msg: Extract<ToAgent, { type: 'command' }>) {
    const v = active ?? findActiveVideo();
    if (msg.action === 'rejoin') {
      forceRejoin = true;
      lastNavAt = 0;
      resetGesture();
      try {
        sessionStorage.removeItem('synx-nav');
      } catch {
        /* ignore */
      }
      tick();
      return;
    }
    if (!v || !room) return;
    if (msg.action === 'toggle-play') {
      const playing = !room.playing;
      publish(snapshot(v, playing ? 'play' : 'pause', { playing, rate: room.rate }));
    } else if (msg.action === 'set-rate') {
      publish(snapshot(v, 'rate', { rate: msg.rate, playing: room.playing }));
    }
    tick();
  }

  function receive(raw: ToAgent | string) {
    const msg: ToAgent = typeof raw === 'string' ? JSON.parse(raw) : raw;
    switch (msg.type) {
      case 'room': {
        offset = msg.offset;
        const prev = room;
        room = msg.state;
        // A clip change from someone else: drop navigation back-off for it.
        if (prev && prev.reel?.id !== room.reel?.id && room.by !== config.clientId) {
          lastNavAt = 0;
          resetGesture(); // a remote change wins over our last touch
        }
        tick();
        break;
      }
      case 'offset':
        offset = msg.offset;
        break;
      case 'sound':
        wantSound = msg.on;
        if (active) {
          active.muted = !msg.on;
          if (msg.on) playBlocked = false;
        }
        break;
      case 'command':
        command(msg);
        break;
    }
  }

  window.__synx = {
    receive,
    version: AGENT_VERSION,
    debug: () => ({ room, offset, lastGesture, navigating, active: !!active, nudging, rateWeSet }),
  };
  setInterval(tick, TICK_MS);
  post({ type: 'ready', url: location.href });
})();
