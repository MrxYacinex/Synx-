/**
 * Synx wire protocol. Shared by the mobile app, the in-page agent and the server.
 * Everything here must stay free of React Native / Node specific imports.
 */

export const PROTOCOL_VERSION = 1;
export const MAX_MEMBERS = 8;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const ROOM_CODE_LENGTH = 5;
export const ALLOWED_RATES = [0.5, 1, 1.25, 1.5, 2] as const;
export const REACTIONS = ['😂', '😍', '🔥', '😮', '💀', '👏'] as const;

export type PlatformId = 'instagram' | 'tiktok' | 'youtube';

export interface Reel {
  platform: PlatformId;
  /** Stable id of the clip on its platform (shortcode / video id). */
  id: string;
  /** Canonical URL that opens exactly this clip. */
  url: string;
}

/**
 * The shared playback state of a room. Positions are anchored to a moment on
 * the *server* clock so every client can extrapolate where playback is "now".
 */
export interface PlaybackState {
  reel: Reel | null;
  playing: boolean;
  /** Playback rate shared by everyone (1 = normal, 2 = double speed). */
  rate: number;
  /** Position in seconds at `refTime`. */
  position: number;
  /** Server-clock ms timestamp the position refers to. */
  refTime: number;
  /** Clip duration in seconds if known (reels loop, so we need it to wrap). */
  duration: number | null;
  /** Monotonic counter assigned by the server. */
  version: number;
  /** clientId of whoever caused this state. */
  by: string | null;
  /** What happened, for UI toasts. */
  cause: StateCause;
}

export type StateCause = 'init' | 'play' | 'pause' | 'seek' | 'rate' | 'reel' | 'sync';

export interface Member {
  clientId: string;
  name: string;
  color: string;
  online: boolean;
}

export type PlaybackUpdate = Omit<PlaybackState, 'version' | 'by'>;

// ---------- client -> server ----------
export type ClientMessage =
  | { t: 'hello'; v: number; clientId: string; name: string; room?: string; create?: { platform: PlatformId } }
  | { t: 'state'; state: PlaybackUpdate; baseVersion: number }
  | { t: 'ping'; id: number; c0: number }
  | { t: 'chat'; text: string }
  | { t: 'react'; emoji: string }
  | { t: 'leave' };

// ---------- server -> client ----------
export type ServerMessage =
  | { t: 'welcome'; you: string; room: string; platform: PlatformId; members: Member[]; state: PlaybackState; serverTime: number }
  | { t: 'members'; members: Member[] }
  | { t: 'state'; state: PlaybackState }
  | { t: 'pong'; id: number; c0: number; s: number }
  | { t: 'chat'; from: string; name: string; text: string; ts: number }
  | { t: 'react'; from: string; emoji: string }
  | { t: 'error'; code: ErrorCode; message: string };

export type ErrorCode = 'room_not_found' | 'room_full' | 'bad_request' | 'rate_limited' | 'version';

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

export function normalizeRoomCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(4, Math.max(0.25, rate));
}

export function initialState(): PlaybackState {
  return {
    reel: null,
    playing: true,
    rate: 1,
    position: 0,
    refTime: 0,
    duration: null,
    version: 0,
    by: null,
    cause: 'init',
  };
}
