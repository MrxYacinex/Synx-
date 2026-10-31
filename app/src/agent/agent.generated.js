"use strict";
(() => {
  // src/shared/reel.ts
  var PLATFORMS = {
    instagram: {
      id: "instagram",
      label: "Instagram Reels",
      homeUrl: "https://www.instagram.com/reels/",
      loginUrl: "https://www.instagram.com/accounts/login/?next=%2Freels%2F",
      hosts: ["instagram.com", "cdninstagram.com", "facebook.com", "fbcdn.net"],
      accent: "#E1306C"
    },
    tiktok: {
      id: "tiktok",
      label: "TikTok",
      homeUrl: "https://www.tiktok.com/foryou",
      loginUrl: "https://www.tiktok.com/login?redirect_url=https%3A%2F%2Fwww.tiktok.com%2Fforyou",
      hosts: ["tiktok.com", "tiktokcdn.com", "tiktokv.com", "ttwstatic.com", "byteoversea.com", "tiktokcdn-us.com"],
      accent: "#25F4EE"
    },
    youtube: {
      id: "youtube",
      label: "YouTube Shorts",
      homeUrl: "https://m.youtube.com/shorts/",
      loginUrl: "https://m.youtube.com/shorts/",
      hosts: ["youtube.com", "youtu.be", "ytimg.com", "googlevideo.com", "google.com", "gstatic.com", "accounts.google.com"],
      accent: "#FF0033"
    }
  };
  var PATTERNS = [
    // instagram.com/reel/<code>/, /reels/<code>/, /p/<code>/, /<user>/reel/<code>/
    { platform: "instagram", host: /(^|\.)instagram\.com$/, path: /\/(?:reels?|p)\/(?!audio\/|explore\/)([A-Za-z0-9_-]{6,})/ },
    // tiktok.com/@user/video/<id>, /@user/photo/<id>, m.tiktok.com/v/<id>.html
    { platform: "tiktok", host: /(^|\.)tiktok\.com$/, path: /\/(?:video|photo|v)\/(\d{6,})/ },
    // youtube.com/shorts/<id>
    { platform: "youtube", host: /(^|\.)youtube\.com$/, path: /\/shorts\/([A-Za-z0-9_-]{6,})/ }
  ];
  function parseReelUrl(rawUrl, base) {
    let url;
    try {
      url = base ? new URL(rawUrl, base) : new URL(rawUrl);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    for (const p of PATTERNS) {
      if (!p.host.test(host)) continue;
      const m = url.pathname.match(p.path);
      if (m) return { platform: p.platform, id: m[1], url: canonicalReelUrl(p.platform, m[1], url) };
    }
    return null;
  }
  function canonicalReelUrl(platform, id, original) {
    var _a;
    switch (platform) {
      case "instagram":
        return `https://www.instagram.com/reels/${id}/`;
      case "tiktok": {
        const user = (_a = original == null ? void 0 : original.pathname.match(/\/@([^/]+)/)) == null ? void 0 : _a[1];
        return `https://www.tiktok.com/@${user != null ? user : "_"}/video/${id}`;
      }
      case "youtube":
        return `https://m.youtube.com/shorts/${id}`;
    }
  }

  // src/shared/sync.ts
  var SEEK_THRESHOLD_PLAYING = 0.9;
  var SEEK_THRESHOLD_PAUSED = 0.08;
  var NUDGE_START = 0.1;
  var NUDGE_STOP = 0.035;
  var MAX_NUDGE = 0.12;
  function expectedPosition(state, serverNow) {
    let pos = state.position;
    if (state.playing) pos += Math.max(0, serverNow - state.refTime) / 1e3 * state.rate;
    const d = state.duration;
    if (d && d > 0.5 && Number.isFinite(d)) pos = (pos % d + d) % d;
    return pos;
  }
  function loopDiff(target, current, duration) {
    let d = target - current;
    if (duration && duration > 0.5 && Number.isFinite(duration)) {
      const half = duration / 2;
      d = ((d + half) % duration + duration) % duration - half;
    }
    return d;
  }
  function planCorrection(diff, target, playing, rate, nudging) {
    const abs = Math.abs(diff);
    if (!playing) return abs > SEEK_THRESHOLD_PAUSED ? { kind: "seek", to: target } : { kind: "none" };
    if (abs > SEEK_THRESHOLD_PLAYING) return { kind: "seek", to: target + Math.min(0.15, 0.05 * rate) };
    if (abs > NUDGE_START || nudging && abs > NUDGE_STOP) {
      const factor = 1 + Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, diff * 0.5));
      return { kind: "nudge", rate: rate * factor };
    }
    return { kind: "none" };
  }

  // src/agent/agent.ts
  var AGENT_VERSION = 1;
  var TICK_MS = 200;
  var GESTURE_WINDOW = 2500;
  var REEL_GESTURE_WINDOW = 8e3;
  var NAV_RETRY_MS = 7e3;
  var MAX_NAV_ATTEMPTS = 3;
  var AUTHORITY_MS = 1500;
  var AWAY_WINDOW = 15e3;
  (function main() {
    var _a;
    if (window.__synx && window.__synx.version >= AGENT_VERSION) return;
    const config = (_a = window.__SYNX_CONFIG__) != null ? _a : { platform: "instagram", clientId: "unknown", sound: true };
    let room = null;
    let offset = 0;
    let lastGesture = 0;
    let wantSound = config.sound;
    let navigating = false;
    let lastPublishAt = 0;
    let lastUrl = location.href;
    let active = null;
    let rateWeSet = null;
    let nudging = false;
    const selfActions = { play: 0, pause: 0, seek: 0 };
    let forceRejoin = false;
    let pendingToggle = null;
    const TOGGLE_CONFIRM_MS = 300;
    let lastStatusAt = 0;
    let lastStatusJson = "";
    let playBlocked = false;
    const outbox = [];
    const serverNow = () => Date.now() + offset;
    const now = () => Date.now();
    const userActive = (window2 = GESTURE_WINDOW) => now() - lastGesture < window2;
    function post(msg) {
      const data = JSON.stringify(msg);
      const bridge = window.ReactNativeWebView;
      if (bridge) {
        while (outbox.length) bridge.postMessage(outbox.shift());
        bridge.postMessage(data);
      } else {
        outbox.push(data);
        if (outbox.length > 50) outbox.shift();
      }
    }
    function log(msg) {
      if (!config.debug) return;
      console.log("[synx] " + msg);
      post({ type: "log", msg });
    }
    let lastGestureType = "";
    const GESTURE_KEY = "synx-gesture";
    let lastStored = 0;
    const storeGesture = (t) => {
      try {
        sessionStorage.setItem(GESTURE_KEY, String(t));
      } catch {
      }
    };
    try {
      lastGesture = Number(sessionStorage.getItem(GESTURE_KEY)) || 0;
    } catch {
    }
    const resetGesture = () => {
      lastGesture = 0;
      storeGesture(0);
    };
    const markGesture = (e) => {
      lastGesture = now();
      lastGestureType = e.type + (e.isTrusted ? "" : "(synthetic)");
      if (lastGesture - lastStored > 500) {
        lastStored = lastGesture;
        storeGesture(lastGesture);
      }
    };
    window.addEventListener("pagehide", () => lastGesture && storeGesture(lastGesture));
    for (const ev of ["touchstart", "touchmove", "pointerdown", "mousedown", "wheel", "keydown"]) {
      window.addEventListener(ev, markGesture, { capture: true, passive: true });
    }
    function visibleFraction(el) {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return 0;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return 0;
      return w * h / (vw * vh);
    }
    function findActiveVideo() {
      let best = null;
      let bestScore = 0;
      for (const v of Array.from(document.querySelectorAll("video"))) {
        const frac = visibleFraction(v);
        if (frac < 0.12) continue;
        const score = frac + (v.paused ? 0 : 0.05);
        if (score > bestScore) {
          best = v;
          bestScore = score;
        }
      }
      return best;
    }
    function reelFromDom(video) {
      let el = video;
      for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
        if (depth > 0 && el.querySelectorAll("video").length > 1) break;
        const links = el.querySelectorAll("a[href]");
        for (const a of Array.from(links)) {
          const r = parseReelUrl(a.getAttribute("href") || "", location.href);
          if (r && r.platform === config.platform) return r;
        }
        if (config.platform === "tiktok") {
          const m = (el.id || "").match(/(\d{15,21})/) || (el.getAttribute("data-video-id") || "").match(/(\d{15,21})/);
          if (m) return { platform: "tiktok", id: m[1], url: canonicalReelUrl("tiktok", m[1]) };
        }
        const explicit = el.getAttribute("data-synx-reel");
        if (explicit) return { platform: config.platform, id: explicit, url: canonicalReelUrl(config.platform, explicit) };
      }
      return null;
    }
    const ID_KEYS = {
      instagram: { keys: ["code", "shortcode"], re: /^[A-Za-z0-9_-]{9,40}$/ },
      tiktok: { keys: ["videoId", "itemId", "aweme_id", "id"], re: /^\d{15,21}$/ }
    };
    const fiberCache = /* @__PURE__ */ new WeakMap();
    function reelFromReact(video) {
      var _a2;
      const spec = ID_KEYS[config.platform];
      if (!spec) return null;
      const src = video.currentSrc || video.src || "";
      const cached = fiberCache.get(video);
      if (cached && cached.src === src && now() - cached.at < 1e3) {
        return cached.id ? { platform: config.platform, id: cached.id, url: canonicalReelUrl(config.platform, cached.id) } : null;
      }
      let id = null;
      try {
        const anyVideo = video;
        const fk = Object.keys(anyVideo).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
        let f = fk ? anyVideo[fk] : null;
        const seen = /* @__PURE__ */ new WeakSet();
        let budget = 4e3;
        const scan = (o, depth) => {
          if (!o || typeof o !== "object" || depth > 4 || seen.has(o) || budget-- <= 0) return null;
          seen.add(o);
          for (const k of Object.keys(o)) {
            if (k === "children" || k === "_owner" || k === "ref") continue;
            let val;
            try {
              val = o[k];
            } catch {
              continue;
            }
            if (typeof val === "string" && spec.keys.includes(k) && spec.re.test(val)) return val;
            if (val && typeof val === "object" && !(val instanceof Node)) {
              const r = scan(val, depth + 1);
              if (r) return r;
            }
          }
          return null;
        };
        for (let i = 0; f && i < 60 && !id; i++, f = (_a2 = f.return) != null ? _a2 : null) id = scan(f.memoizedProps, 0);
      } catch {
        id = null;
      }
      fiberCache.set(video, { id, at: now(), src });
      return id ? { platform: config.platform, id, url: canonicalReelUrl(config.platform, id) } : null;
    }
    function currentReel(video) {
      const fromReact = video ? reelFromReact(video) : null;
      if (fromReact) return fromReact;
      const fromUrl = parseReelUrl(location.href);
      if (fromUrl && fromUrl.platform === config.platform) return fromUrl;
      return video ? reelFromDom(video) : null;
    }
    function isLoginPage() {
      if (/\/(accounts\/login|accounts\/emailsignup|login|signup|signin|challenge)/i.test(location.pathname) || location.hostname.startsWith("accounts.")) return true;
      for (const d of Array.from(document.querySelectorAll('[role="dialog"]'))) {
        if (visibleFraction(d) < 0.15) continue;
        const text = (d.textContent || "").slice(0, 400);
        if (/(in the app|log in|sign up|continue with)/i.test(text)) return true;
      }
      return false;
    }
    const isPlatformRoot = () => /^\/(accounts\/onetap\/?)?$/.test(location.pathname) && location.hostname.includes(config.platform === "youtube" ? "youtube" : config.platform);
    const finiteDuration = (v) => v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
    function setRate(v, rate) {
      if (Math.abs(v.playbackRate - rate) < 1e-3) return;
      rateWeSet = rate;
      try {
        v.playbackRate = rate;
      } catch {
      }
    }
    function doPlay(v) {
      selfActions.play = now();
      const p = v.play();
      if (p && typeof p.catch === "function") {
        p.then(() => playBlocked = false).catch((err) => {
          if (err && err.name === "NotAllowedError") {
            playBlocked = true;
            v.muted = true;
            selfActions.play = now();
            v.play().catch(() => {
            });
          }
        });
      }
    }
    function doPause(v) {
      selfActions.pause = now();
      v.pause();
    }
    function doSeek(v, to) {
      const d = finiteDuration(v);
      if (d) to = Math.max(0, Math.min(d - 0.05, to));
      selfActions.seek = now();
      try {
        v.currentTime = to;
      } catch {
      }
    }
    const recentlySelf = (k, ms = 600) => now() - selfActions[k] < ms;
    function snapshot(v, cause, over = {}) {
      var _a2, _b, _c;
      return {
        reel: (_b = (_a2 = currentReel(v)) != null ? _a2 : room == null ? void 0 : room.reel) != null ? _b : null,
        playing: !v.paused,
        rate: (_c = room == null ? void 0 : room.rate) != null ? _c : 1,
        position: v.currentTime || 0,
        refTime: serverNow(),
        duration: finiteDuration(v),
        cause,
        ...over
      };
    }
    function publish(update) {
      var _a2, _b;
      lastPublishAt = now();
      room = { ...update, version: (_a2 = room == null ? void 0 : room.version) != null ? _a2 : 0, by: config.clientId };
      log(`publish ${update.cause} ${(_b = update.reel) == null ? void 0 : _b.id} playing=${update.playing} pos=${update.position.toFixed(2)} rate=${update.rate}`);
      post({ type: "publish", update });
    }
    function onMediaEvent(e) {
      var _a2, _b, _c;
      const v = e.target;
      if (!(v instanceof HTMLVideoElement) || v !== active || !room || navigating) return;
      const reel = currentReel(v);
      if (room.reel && reel && reel.id !== room.reel.id) return;
      switch (e.type) {
        case "play":
        case "pause": {
          const kind = e.type;
          if (recentlySelf(kind)) return;
          const playing = kind === "play";
          if (playing === room.playing || !userActive()) return;
          pendingToggle = { playing, video: v, reelId: (_a2 = reel == null ? void 0 : reel.id) != null ? _a2 : null, at: now(), gesture: lastGestureType };
          break;
        }
        case "seeked": {
          if (recentlySelf("seek", 1200) || !userActive()) return;
          const target = expectedPosition({ ...room, duration: (_b = room.duration) != null ? _b : finiteDuration(v) }, serverNow());
          if (Math.abs(loopDiff(target, v.currentTime, (_c = room.duration) != null ? _c : finiteDuration(v))) < 1) return;
          publish(snapshot(v, "seek", { playing: room.playing }));
          break;
        }
        case "ratechange": {
          if (rateWeSet !== null && Math.abs(v.playbackRate - rateWeSet) < 1e-3) return;
          if (!userActive()) return;
          const rate = v.playbackRate;
          if (Math.abs(rate - room.rate) < 1e-3) return;
          nudging = false;
          rateWeSet = rate;
          publish(snapshot(v, "rate", { rate, playing: room.playing }));
          break;
        }
        case "volumechange": {
          if (!userActive() || recentlySelf("play")) return;
          if (wantSound === !v.muted) return;
          wantSound = !v.muted;
          break;
        }
      }
    }
    for (const ev of ["play", "pause", "seeked", "ratechange", "volumechange"]) {
      document.addEventListener(ev, onMediaEvent, true);
    }
    function navAttempts(id) {
      try {
        const raw = sessionStorage.getItem("synx-nav");
        const rec = raw ? JSON.parse(raw) : null;
        if (rec && rec.id === id && now() - rec.at < 6e4) return rec.n;
      } catch {
      }
      return 0;
    }
    function recordNav(id) {
      try {
        sessionStorage.setItem("synx-nav", JSON.stringify({ id, n: navAttempts(id) + 1, at: now() }));
      } catch {
      }
    }
    let lastNavAt = 0;
    function navigateTo(reel) {
      if (navigating) return "navigating";
      if (now() - lastNavAt < NAV_RETRY_MS) return "navigating";
      if (navAttempts(reel.id) >= MAX_NAV_ATTEMPTS && !forceRejoin) return "nav-failed";
      forceRejoin = false;
      const link = Array.from(document.querySelectorAll("a[href]")).find((a) => {
        const r = parseReelUrl(a.getAttribute("href") || "", location.href);
        return r && r.id === reel.id;
      });
      lastNavAt = now();
      recordNav(reel.id);
      log(`navigate to ${reel.id} via ${link ? "link" : "location"}`);
      if (link) {
        link.click();
      } else {
        navigating = true;
        location.href = reel.url;
      }
      return "navigating";
    }
    function tick() {
      var _a2, _b;
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
        const stillHere = v === p.video && ((_a2 = reel == null ? void 0 : reel.id) != null ? _a2 : null) === p.reelId && !navigating;
        if (stillHere && room && v && v.paused === !p.playing && p.playing !== room.playing) {
          log(`user ${p.playing ? "play" : "pause"} (gesture ${p.gesture})`);
          publish(snapshot(v, p.playing ? "play" : "pause", { playing: p.playing }));
        }
      }
      let mode = "waiting";
      let drift = null;
      if (room && !navigating) {
        mode = step(v, reel);
        if (mode === "synced" || mode === "syncing") {
          const d = (_b = room.duration) != null ? _b : finiteDuration(v);
          drift = v ? loopDiff(expectedPosition({ ...room, duration: d }, serverNow()), v.currentTime, d) : null;
        }
      } else if (navigating) {
        mode = "navigating";
      }
      if (v && wantSound && v.muted && !playBlocked) v.muted = false;
      const status = {
        url: location.href,
        reel,
        hasVideo: !!v,
        playing: !!v && !v.paused,
        position: v ? v.currentTime : 0,
        duration: finiteDuration(v),
        drift,
        soundOn: !!v && !v.muted,
        mode
      };
      const json = JSON.stringify({ ...status, position: Math.round(status.position), drift: drift === null ? null : Math.round(drift * 10) });
      if (json !== lastStatusJson || now() - lastStatusAt > 2e3) {
        lastStatusJson = json;
        lastStatusAt = now();
        post({ type: "status", status });
      }
    }
    function step(v, reel) {
      var _a2;
      const r = room;
      if (!/^https?:$/.test(location.protocol)) return "waiting";
      if (isLoginPage()) return "login";
      if (reel && (!r.reel || reel.id !== r.reel.id)) {
        const noClipYet = !r.reel;
        const userScrolled = userActive(REEL_GESTURE_WINDOW) && !forceRejoin;
        if (noClipYet || userScrolled) {
          if (!v) return "syncing";
          publish(snapshot(v, "reel", { reel, position: v.currentTime || 0, playing: noClipYet ? !v.paused || r.playing : true }));
          return "synced";
        }
        if (!r.reel) return "waiting";
        if (v && !v.paused) doPause(v);
        return navigateTo(r.reel);
      }
      if (!reel) {
        if (!r.reel) {
          if (isPlatformRoot() && !userActive(AWAY_WINDOW) && now() - lastNavAt > NAV_RETRY_MS) {
            lastNavAt = now();
            navigating = true;
            location.href = PLATFORMS[config.platform].homeUrl;
            return "navigating";
          }
          return v ? "no-clip" : "waiting";
        }
        if (userActive(AWAY_WINDOW) && !forceRejoin) return "away";
        return navigateTo(r.reel);
      }
      forceRejoin = false;
      if (!v) return "syncing";
      if (pendingToggle && pendingToggle.video === v) return "syncing";
      if (r.playing && v.paused && !recentlySelf("play", 800)) doPlay(v);
      if (!r.playing && !v.paused && !recentlySelf("pause", 300)) doPause(v);
      if (v.readyState < 1) return "syncing";
      const duration = (_a2 = r.duration) != null ? _a2 : finiteDuration(v);
      const target = expectedPosition({ ...r, duration }, serverNow());
      const diff = loopDiff(target, v.currentTime, duration);
      const authority = r.by === config.clientId && now() - lastPublishAt < AUTHORITY_MS;
      if (authority && Math.abs(diff) > 0.5) {
        publish(snapshot(v, "sync", { playing: r.playing, rate: r.rate }));
        return "synced";
      }
      const c = planCorrection(diff, target, r.playing && !v.paused, r.rate, nudging);
      const canSeek = !v.seeking && !recentlySelf("seek", 700) && (v.readyState >= 2 || !r.playing);
      if (c.kind === "seek" && canSeek) {
        log(`seek ${v.currentTime.toFixed(2)} -> ${c.to.toFixed(2)} (diff ${diff.toFixed(2)})`);
        doSeek(v, c.to);
        nudging = false;
        setRate(v, r.rate);
      } else if (c.kind === "nudge") {
        nudging = true;
        setRate(v, c.rate);
      } else if (c.kind === "none") {
        nudging = false;
        setRate(v, r.rate);
      }
      return Math.abs(diff) < 0.25 ? "synced" : "syncing";
    }
    function command(msg) {
      const v = active != null ? active : findActiveVideo();
      if (msg.action === "rejoin") {
        forceRejoin = true;
        lastNavAt = 0;
        resetGesture();
        try {
          sessionStorage.removeItem("synx-nav");
        } catch {
        }
        tick();
        return;
      }
      if (!v || !room) return;
      if (msg.action === "toggle-play") {
        const playing = !room.playing;
        publish(snapshot(v, playing ? "play" : "pause", { playing, rate: room.rate }));
      } else if (msg.action === "set-rate") {
        publish(snapshot(v, "rate", { rate: msg.rate, playing: room.playing }));
      }
      tick();
    }
    function receive(raw) {
      var _a2, _b;
      const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
      switch (msg.type) {
        case "room": {
          offset = msg.offset;
          const prev = room;
          room = msg.state;
          if (prev && ((_a2 = prev.reel) == null ? void 0 : _a2.id) !== ((_b = room.reel) == null ? void 0 : _b.id) && room.by !== config.clientId) {
            lastNavAt = 0;
            resetGesture();
          }
          tick();
          break;
        }
        case "offset":
          offset = msg.offset;
          break;
        case "sound":
          wantSound = msg.on;
          if (active) {
            active.muted = !msg.on;
            if (msg.on) playBlocked = false;
          }
          break;
        case "command":
          command(msg);
          break;
      }
    }
    window.__synx = {
      receive,
      version: AGENT_VERSION,
      debug: () => ({ room, offset, lastGesture, navigating, active: !!active, nudging, rateWeSet })
    };
    setInterval(tick, TICK_MS);
    post({ type: "ready", url: location.href });
  })();
})();
