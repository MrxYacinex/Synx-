import type { PlaybackState } from './protocol';

/** Drift (seconds) above which we hard-seek instead of gently nudging speed. */
export const SEEK_THRESHOLD_PLAYING = 0.9;
export const SEEK_THRESHOLD_PAUSED = 0.08;
/** Drift (seconds) at which we start / stop nudging the playback rate. */
export const NUDGE_START = 0.1;
export const NUDGE_STOP = 0.035;
export const MAX_NUDGE = 0.12;

/**
 * NTP-style clock offset estimator. Each ping gives us (c0, s, c1); the sample
 * with the lowest round-trip time is the most trustworthy.
 */
export class ClockSync {
  private samples: Array<{ offset: number; rtt: number; at: number }> = [];
  constructor(private readonly maxSamples = 10) {}

  add(c0: number, s: number, c1: number): void {
    const rtt = Math.max(0, c1 - c0);
    const offset = s - (c0 + c1) / 2;
    this.samples.push({ offset, rtt, at: c1 });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  get ready(): boolean {
    return this.samples.length > 0;
  }

  /** server time ≈ local time + offset */
  get offset(): number {
    if (!this.samples.length) return 0;
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.min(3, sorted.length));
    return best.reduce((acc, s) => acc + s.offset, 0) / best.length;
  }

  get rtt(): number {
    if (!this.samples.length) return 0;
    return Math.min(...this.samples.map((s) => s.rtt));
  }

  serverNow(localNow: number = Date.now()): number {
    return localNow + this.offset;
  }

  reset(): void {
    this.samples = [];
  }
}

/** Where playback should be right now (seconds), according to the room state. */
export function expectedPosition(state: Pick<PlaybackState, 'playing' | 'position' | 'refTime' | 'rate' | 'duration'>, serverNow: number): number {
  let pos = state.position;
  if (state.playing) pos += (Math.max(0, serverNow - state.refTime) / 1000) * state.rate;
  const d = state.duration;
  if (d && d > 0.5 && Number.isFinite(d)) pos = ((pos % d) + d) % d;
  return pos;
}

/**
 * Signed difference target - current, taking looping into account: on a 10s
 * loop, 9.9 vs 0.1 is 0.2s apart, not 9.8s.
 */
export function loopDiff(target: number, current: number, duration: number | null): number {
  let d = target - current;
  if (duration && duration > 0.5 && Number.isFinite(duration)) {
    const half = duration / 2;
    d = ((((d + half) % duration) + duration) % duration) - half;
  }
  return d;
}

export type Correction =
  | { kind: 'none' }
  | { kind: 'seek'; to: number }
  | { kind: 'nudge'; rate: number };

/**
 * Decide how to bring a local player back in line with the room.
 * `diff` is target - current in seconds; `nudging` says whether we are already
 * running at a corrective rate (hysteresis).
 */
export function planCorrection(diff: number, target: number, playing: boolean, rate: number, nudging: boolean): Correction {
  const abs = Math.abs(diff);
  if (!playing) return abs > SEEK_THRESHOLD_PAUSED ? { kind: 'seek', to: target } : { kind: 'none' };
  if (abs > SEEK_THRESHOLD_PLAYING) return { kind: 'seek', to: target + Math.min(0.15, 0.05 * rate) };
  if (abs > NUDGE_START || (nudging && abs > NUDGE_STOP)) {
    const factor = 1 + Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, diff * 0.5));
    return { kind: 'nudge', rate: rate * factor };
  }
  return { kind: 'none' };
}
