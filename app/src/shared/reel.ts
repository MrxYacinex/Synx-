import type { PlatformId, Reel } from './protocol';

export interface PlatformInfo {
  id: PlatformId;
  label: string;
  /** Where a room starts when nobody has picked a clip yet. */
  homeUrl: string;
  /** Where to send people who need to sign in. */
  loginUrl: string;
  /** Hosts the in-app browser is allowed to navigate to (suffix match). */
  hosts: string[];
  accent: string;
}

export const PLATFORMS: Record<PlatformId, PlatformInfo> = {
  instagram: {
    id: 'instagram',
    label: 'Instagram Reels',
    homeUrl: 'https://www.instagram.com/reels/',
    loginUrl: 'https://www.instagram.com/accounts/login/?next=%2Freels%2F',
    hosts: ['instagram.com', 'cdninstagram.com', 'facebook.com', 'fbcdn.net'],
    accent: '#E1306C',
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    homeUrl: 'https://www.tiktok.com/foryou',
    loginUrl: 'https://www.tiktok.com/login?redirect_url=https%3A%2F%2Fwww.tiktok.com%2Fforyou',
    hosts: ['tiktok.com', 'tiktokcdn.com', 'tiktokv.com', 'ttwstatic.com', 'byteoversea.com', 'tiktokcdn-us.com'],
    accent: '#25F4EE',
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube Shorts',
    homeUrl: 'https://m.youtube.com/shorts/',
    loginUrl: 'https://m.youtube.com/shorts/',
    hosts: ['youtube.com', 'youtu.be', 'ytimg.com', 'googlevideo.com', 'google.com', 'gstatic.com', 'accounts.google.com'],
    accent: '#FF0033',
  },
};

const PATTERNS: Array<{ platform: PlatformId; host: RegExp; path: RegExp }> = [
  // instagram.com/reel/<code>/, /reels/<code>/, /p/<code>/, /<user>/reel/<code>/
  { platform: 'instagram', host: /(^|\.)instagram\.com$/, path: /\/(?:reels?|p)\/(?!audio\/|explore\/)([A-Za-z0-9_-]{6,})/ },
  // tiktok.com/@user/video/<id>, /@user/photo/<id>, m.tiktok.com/v/<id>.html
  { platform: 'tiktok', host: /(^|\.)tiktok\.com$/, path: /\/(?:video|photo|v)\/(\d{6,})/ },
  // youtube.com/shorts/<id>
  { platform: 'youtube', host: /(^|\.)youtube\.com$/, path: /\/shorts\/([A-Za-z0-9_-]{6,})/ },
];

/** Extract the clip identity from a URL, or null if the URL is not a single clip. */
export function parseReelUrl(rawUrl: string, base?: string): Reel | null {
  let url: URL;
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

export function canonicalReelUrl(platform: PlatformId, id: string, original?: URL): string {
  switch (platform) {
    case 'instagram':
      return `https://www.instagram.com/reels/${id}/`;
    case 'tiktok': {
      // TikTok wants the author in the path; keep it when we know it.
      const user = original?.pathname.match(/\/@([^/]+)/)?.[1];
      return `https://www.tiktok.com/@${user ?? '_'}/video/${id}`;
    }
    case 'youtube':
      return `https://m.youtube.com/shorts/${id}`;
  }
}

export function platformForUrl(rawUrl: string): PlatformId | null {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const info of Object.values(PLATFORMS)) {
    if (info.hosts.some((h) => host === h || host.endsWith('.' + h))) return info.id;
  }
  return null;
}

/** Is this URL something the embedded browser should load (vs. open externally / block)? */
export function isAllowedNavigation(rawUrl: string, platform: PlatformId): boolean {
  if (rawUrl.startsWith('about:') || rawUrl.startsWith('blob:') || rawUrl.startsWith('data:')) return true;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false; // intent://, instagram://, snssdk://…
  const host = url.hostname.toLowerCase();
  // Login flows bounce between a few of the platform's own domains.
  return PLATFORMS[platform].hosts.some((h) => host === h || host.endsWith('.' + h));
}
