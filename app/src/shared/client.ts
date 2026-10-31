import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type Member,
  type PlatformId,
  type PlaybackState,
  type PlaybackUpdate,
  type ServerMessage,
  type ErrorCode,
  initialState,
} from './protocol';
import { ClockSync } from './sync';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface SyncClientEvents {
  status?: (status: ConnectionStatus) => void;
  welcome?: (info: { room: string; platform: PlatformId; you: string }) => void;
  state?: (state: PlaybackState, local: boolean) => void;
  members?: (members: Member[]) => void;
  chat?: (msg: { from: string; name: string; text: string; ts: number }) => void;
  react?: (msg: { from: string; emoji: string }) => void;
  error?: (code: ErrorCode, message: string) => void;
}

type JoinTarget = { room: string } | { create: PlatformId };

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
type WebSocketCtor = new (url: string) => WebSocketLike;

export interface SyncClientOptions {
  url: string;
  clientId: string;
  name: string;
  WebSocketImpl?: WebSocketCtor;
  now?: () => number;
}

/**
 * Talks to the Synx server: joins a room, keeps the clock in sync, reconnects,
 * and exposes the shared playback state. Works in React Native and Node 22+.
 */
export class SyncClient {
  readonly clock = new ClockSync();
  state: PlaybackState = initialState();
  members: Member[] = [];
  room: string | null = null;
  platform: PlatformId | null = null;
  status: ConnectionStatus = 'idle';

  private ws: WebSocketLike | null = null;
  private target: JoinTarget | null = null;
  private listeners: SyncClientEvents[] = [];
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private pingId = 0;
  private pingsSent = 0;
  private closedByUser = false;
  /** Our own state updates the server hasn't echoed back yet. */
  private pending = 0;
  private lastPublishAt = 0;
  private readonly now: () => number;
  private readonly WS: WebSocketCtor;

  constructor(private readonly opts: SyncClientOptions) {
    this.now = opts.now ?? (() => Date.now());
    const impl = opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!impl) throw new Error('No WebSocket implementation available');
    this.WS = impl;
  }

  get clientId(): string {
    return this.opts.clientId;
  }

  on(events: SyncClientEvents): () => void {
    this.listeners.push(events);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== events);
    };
  }

  private emit<K extends keyof SyncClientEvents>(key: K, ...args: Parameters<NonNullable<SyncClientEvents[K]>>): void {
    for (const l of this.listeners) {
      const fn = l[key] as ((...a: unknown[]) => void) | undefined;
      try {
        fn?.(...args);
      } catch (e) {
        console.warn('[synx] listener error', e);
      }
    }
  }

  serverNow(): number {
    return this.clock.serverNow(this.now());
  }

  join(target: JoinTarget): void {
    this.target = target;
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    this.send({ t: 'leave' });
    this.teardown();
    this.setStatus('closed');
  }

  /** Publish a new shared state. Applied locally right away (optimistic). */
  publish(update: PlaybackUpdate): void {
    const optimistic: PlaybackState = { ...update, version: this.state.version, by: this.clientId };
    this.state = optimistic;
    this.emit('state', optimistic, true);
    if (this.send({ t: 'state', state: update, baseVersion: this.state.version })) {
      this.pending++;
      this.lastPublishAt = this.now();
    }
  }

  chat(text: string): void {
    const trimmed = text.trim().slice(0, 300);
    if (trimmed) this.send({ t: 'chat', text: trimmed });
  }

  react(emoji: string): void {
    this.send({ t: 'react', emoji });
  }

  // ---------------------------------------------------------------- internals

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  private send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private open(): void {
    this.teardown();
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocketLike;
    try {
      ws = new this.WS(this.opts.url);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws || !this.target) return;
      const hello: ClientMessage = {
        t: 'hello',
        v: PROTOCOL_VERSION,
        clientId: this.opts.clientId,
        name: this.opts.name,
        ...('room' in this.target ? { room: this.target.room } : { create: { platform: this.target.create } }),
      };
      this.send(hello);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPings();
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private teardown(): void {
    this.stopPings();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.setStatus('reconnecting');
    const delay = Math.min(10_000, 500 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': {
        this.attempts = 0;
        this.pending = 0;
        this.room = msg.room;
        this.platform = msg.platform;
        this.target = { room: msg.room }; // reconnects rejoin the same room
        this.members = msg.members;
        // Rough offset until pings refine it (not a real sample: it ignores latency).
        if (!this.clock.ready) this.clock.seed(msg.serverTime, this.now());
        this.state = msg.state;
        this.setStatus('connected');
        this.emit('welcome', { room: msg.room, platform: msg.platform, you: msg.you });
        this.emit('members', msg.members);
        this.emit('state', msg.state, false);
        this.startPings();
        break;
      }
      case 'state': {
        if (msg.state.version < this.state.version) return; // stale
        if (msg.state.by === this.clientId && this.pending > 0) this.pending--;
        if (this.pending > 0 && this.now() - this.lastPublishAt < 3000) {
          // A newer update of ours is still in flight and will win on the server:
          // don't flash back to this older state in the meantime.
          this.state = { ...this.state, version: msg.state.version };
          return;
        }
        this.pending = 0;
        this.state = msg.state;
        this.emit('state', msg.state, false);
        break;
      }
      case 'members':
        this.members = msg.members;
        this.emit('members', msg.members);
        break;
      case 'pong':
        this.clock.add(msg.c0, msg.s, this.now());
        break;
      case 'chat':
        this.emit('chat', msg);
        break;
      case 'react':
        this.emit('react', msg);
        break;
      case 'error':
        if (msg.code === 'room_not_found' || msg.code === 'room_full' || msg.code === 'version') {
          this.closedByUser = true; // retrying won't help
          this.teardown();
          this.setStatus('closed');
        }
        this.emit('error', msg.code, msg.message);
        break;
    }
  }

  private startPings(): void {
    this.stopPings();
    this.pingsSent = 0;
    const tick = () => {
      this.send({ t: 'ping', id: ++this.pingId, c0: this.now() });
      this.pingsSent++;
      // Burst at first for a quick, accurate offset, then relax.
      const next = this.pingsSent < 8 ? 300 : 2500;
      this.pingTimer = setTimeout(tick, next);
    };
    tick();
  }

  private stopPings(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }
}
