# synx

**Watch Instagram Reels, TikTok and YouTube Shorts together with friends, in sync.**
Everyone sees the same reel at the same second. When anyone pauses, plays, switches to 2×, skips or
**scrolls to the next reel**, everyone else's phone follows within a fraction of a second.

Works on **iOS and Android** (React Native + Expo).

```
 ┌───────── your phone ─────────┐                      ┌──────── friend's phone ───────┐
 │  Synx app                    │                      │  Synx app                     │
 │  ┌────────────────────────┐  │   room state over    │  ┌────────────────────────┐   │
 │  │ instagram.com/reels    │  │◀──── WebSocket ────▶│  │ instagram.com/reels    │   │
 │  │ (your real account)    │  │    Synx server       │  │ (her real account)     │   │
 │  │  + Synx sync agent     │  │                      │  │  + Synx sync agent     │   │
 │  └────────────────────────┘  │                      │  └────────────────────────┘   │
 │  [⏯] [2×] [🔊] [😂] [💬]       │                      │  [⏯] [2×] [🔊] [😂] [💬]        │
 └──────────────────────────────┘                      └───────────────────────────────┘
```

## Why not literally *inside* the Instagram app?

iOS doesn't let any app inject into or remote-control another app, and Instagram/TikTok have no
plugin API. So Synx does the next best thing: it **opens the real Instagram / TikTok / YouTube
mobile site inside Synx**. You log in with your own account, and your login stays in the app's
browser on your phone; Synx never sees it. You get your real feed, likes and comments, with the
sync controls on top.

## Features

- **Same reel, same moment.** Room state is anchored to a shared server clock (NTP-style clock
  sync), so phones whose clocks are seconds apart still line up.
- **Scroll sync.** Whoever swipes to the next reel takes everyone along. Your feeds are
  personalized and different, so Synx opens that exact reel on your friend's phone.
- **Pause, play, skip and speed (0.5×–2×) sync.** Works with the platform's own controls and with
  Synx's controls.
- **Drift correction.** Small drift is fixed by speeding up or slowing down slightly (you won't
  notice). Large drift is fixed with a jump. Looping reels are handled.
- **Browse without being dragged back.** If you open a profile, the app shows "Back to the party"
  and doesn't yank you away.
- Live reactions (😂 😍 🔥 😮 💀 👏), chat, a "who's watching" bar, and toasts like
  "Lina set speed to 2×".
- Rooms of up to 8 people. Share with a 5-letter code or a link.
- Reconnects automatically when you switch between Wi-Fi and mobile data.

## Quick start (try it today, no app store needed)

You need Node 20+ and the free **Expo Go** app on both phones
([iOS](https://apps.apple.com/app/expo-go/id982107779) /
[Android](https://play.google.com/store/apps/details?id=host.exp.exponent)).

```bash
npm run setup          # installs server + app dependencies
npm run server         # terminal 1: sync server on :8787
npm run app            # terminal 2: Expo dev server, shows a QR code
```

Scan the QR code with both phones: the iPhone Camera app, or Expo Go on Android. Both phones must
be on the same Wi-Fi as your computer. The app automatically uses the sync server on the computer
running Expo.

1. Phone A: enter a name → pick **Instagram** → **Start a watch party** → tap the room code to copy
   it, or **＋** to share it.
2. Phone B: enter a name → type the code → **Join**.
3. Log in to Instagram on both phones (only needed once), then scroll.

## Using it with a friend who isn't next to you

Put the sync server on the internet once. It's tiny and the free tiers are enough.

**Render (one click):** push this repo to GitHub → render.com → *New → Blueprint* → select the
repo. `render.yaml` sets everything up. You'll get a URL like `https://synx-server-xxxx.onrender.com`.

**Any Docker host (Fly.io, Railway, a VPS):**
```bash
docker build -f server/Dockerfile -t synx-server .
docker run -p 8787:8787 synx-server
```

Then, in the app, open **⚙︎ Settings → Sync server** and enter `wss://<your-host>`. Everyone must
use the same server. To make it the default, set `EXPO_PUBLIC_SYNX_SERVER` (see `app/eas.json`).

> Free Render instances go to sleep when idle; the first connection after a while takes about 30 s.

## Installing it as a real app (no Expo Go)

Build with [EAS](https://docs.expo.dev/build/introduction/) (free tier available):

```bash
cd app
npx eas-cli@latest login
# put your server URL into app/eas.json first (EXPO_PUBLIC_SYNX_SERVER)
npx eas-cli@latest build --profile preview --platform android   # → installable .apk
npx eas-cli@latest build --profile preview --platform ios       # → needs an Apple developer account
```

Real builds also enable the `synx://join/CODE` links and `https://<server>/join/CODE` invite
pages.

## How the sync works

| Piece | File | What it does |
|---|---|---|
| Room server | `server/src/rooms.ts` | Rooms, members, server-authoritative playback state, rate limiting, cleanup |
| Protocol | `app/src/shared/protocol.ts` | Message types shared by everything |
| Sync math | `app/src/shared/sync.ts` | Clock-offset estimator, expected position with looping, drift-correction policy |
| Client | `app/src/shared/client.ts` | WebSocket client with reconnect, ping-based clock sync, optimistic updates |
| Page agent | `app/src/agent/agent.ts` | Injected into the Instagram/TikTok/YouTube page (details below) |
| App | `app/src/app/*`, `app/src/components/*` | Screens, the WebView, overlay controls, chat, reactions |

The **page agent** runs inside the website:
1. Finds the reel on screen: the most visible `<video>`.
2. Works out which reel it is. Instagram's mobile site does **not** change the URL while you scroll
   (checked against the live site in Oct 2026), so the agent reads the reel's shortcode from
   Instagram's own React data attached to that video. It falls back to the URL and to links in
   the page.
3. Tells apart what **you** did (a tap, swipe or key press just happened) from what the website did
   by itself (for example, pausing the old reel when you swipe). Only your own actions are sent to
   your friends.
4. Keeps the local player on the room state: same reel, play/pause, speed and position.

## Tests

```bash
npm test
```

- **Unit/integration** (`server/test/shared.test.ts`, `server/test/server.test.ts`): reel URL parsing,
  clock sync, drift policy, rooms, reconnects, rate limiting, room limits, and "no flashback"
  optimistic updates.
- **End-to-end** (`server/test/e2e.test.ts`): runs the real server and the real agent in Chromium
  against fake Instagram/TikTok feeds that copy the real sites' behavior: personalized feed order
  per user, the URL not changing on scroll, IDs only in React data, the logged-out wall. Scenarios:
  - 2–3 friends with play, pause, 2×, scrolling both ways, skipping, a glitching player and loop
    boundaries
  - a TikTok-style feed
  - browsing a profile, then rejoining
  - 150 ms ± 60 ms network latency with phone clocks −4.2 s / +7.3 s off
  - a logged-out wall

  Largest gap measured between phones across test runs: **30–70 ms** on a good network and
  **40–85 ms** on the slow, jittery one. The clock estimate stays within about 7 ms of the true
  offset.
- **Real-site probes** (`npm --prefix server run probe -- instagram|youtube|tiktok`): open the
  real site in headless Chromium with the agent injected.

## Known limitations

- **These sites change often.** If Instagram, TikTok or YouTube redesigns its mobile site, the reel
  detection may need an update. It all lives in `app/src/agent/agent.ts`.
- **Tested on the real sites, logged out only.** Logged-out Instagram and YouTube Shorts were
  checked: reel detection, swipe tracking, opening a specific reel, and the login wall. TikTok's
  site didn't load in the test environment, so TikTok is covered only by the fake feed. Nothing has
  been tested while logged in yet.
- **Sound.** Each phone controls its own volume and mute. Sound isn't synced, on purpose.
- **Expo Go limits.** In Expo Go, `synx://` invite links don't open the app; type the code instead.
  Real builds don't have this limit.
- **Terms of use.** Each person watches through their own account in an ordinary browser view.
  Synx only syncs controls; it never downloads or re-streams anyone's videos. Still, check the
  platforms' terms before publishing Synx in the app stores.
