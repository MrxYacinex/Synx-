import type { PlatformId, PlaybackState, PlaybackUpdate, Reel } from './protocol';

/** Config the app injects into the page before the agent starts. */
export interface AgentConfig {
  platform: PlatformId;
  clientId: string;
  /** Start with sound on (users can still mute). */
  sound: boolean;
  debug?: boolean;
}

/** App -> page */
export type ToAgent =
  | { type: 'room'; state: PlaybackState; offset: number }
  | { type: 'offset'; offset: number }
  | { type: 'sound'; on: boolean }
  | { type: 'command'; action: 'toggle-play' }
  | { type: 'command'; action: 'set-rate'; rate: number }
  | { type: 'command'; action: 'rejoin' };

export interface AgentStatus {
  url: string;
  reel: Reel | null;
  hasVideo: boolean;
  playing: boolean;
  position: number;
  duration: number | null;
  /** Seconds we are off from the room (positive = behind). null if not comparable. */
  drift: number | null;
  soundOn: boolean;
  /** Why we are not following the room, if we aren't. */
  mode: 'synced' | 'syncing' | 'navigating' | 'away' | 'login' | 'no-clip' | 'nav-failed' | 'waiting';
}

/** Page -> app */
export type FromAgent =
  | { type: 'ready'; url: string }
  | { type: 'publish'; update: PlaybackUpdate }
  | { type: 'status'; status: AgentStatus }
  | { type: 'log'; msg: string };
