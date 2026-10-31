import {
  MAX_MEMBERS,
  PROTOCOL_VERSION,
  REACTIONS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  clampRate,
  initialState,
  isValidRoomCode,
  normalizeRoomCode,
  type ClientMessage,
  type Member,
  type PlatformId,
  type PlaybackState,
  type PlaybackUpdate,
  type Reel,
  type ServerMessage,
  type StateCause,
} from '../../app/src/shared/protocol';

export interface Conn {
  send(msg: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

interface MemberRecord {
  clientId: string;
  name: string;
  color: string;
  conn: Conn | null;
  offlineSince: number | null;
}

export interface Room {
  code: string;
  platform: PlatformId;
  members: Map<string, MemberRecord>;
  state: PlaybackState;
  createdAt: number;
  emptySince: number | null;
}

interface ConnInfo {
  room: Room | null;
  clientId: string | null;
  tokens: number;
  lastRefill: number;
}

const COLORS = ['#FF4D8D', '#4DD8FF', '#FFC94D', '#8B5CFF', '#4DFF9A', '#FF8A4D', '#FF4DF0', '#B8FF4D'];
const PLATFORMS: PlatformId[] = ['instagram', 'tiktok', 'youtube'];
const CAUSES: StateCause[] = ['play', 'pause', 'seek', 'rate', 'reel', 'sync'];

export interface RoomManagerOptions {
  now?: () => number;
  /** Drop a member that has been offline this long (ms). */
  memberTimeout?: number;
  /** Delete a room with no one online for this long (ms). */
  roomTimeout?: number;
  /** Messages per second allowed per connection (burst = 4x). */
  rateLimit?: number;
  random?: () => number;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private conns = new Map<Conn, ConnInfo>();
  private readonly now: () => number;
  private readonly memberTimeout: number;
  private readonly roomTimeout: number;
  private readonly rateLimit: number;
  private readonly random: () => number;

  constructor(opts: RoomManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.memberTimeout = opts.memberTimeout ?? 90_000;
    this.roomTimeout = opts.roomTimeout ?? 6 * 60 * 60_000;
    this.rateLimit = opts.rateLimit ?? 20;
    this.random = opts.random ?? Math.random;
  }

  connect(conn: Conn): void {
    this.conns.set(conn, { room: null, clientId: null, tokens: this.rateLimit * 4, lastRefill: this.now() });
  }

  disconnect(conn: Conn): void {
    const info = this.conns.get(conn);
    this.conns.delete(conn);
    if (info) this.detach(conn, info);
  }

  private detach(conn: Conn, info: ConnInfo): void {
    const room = info.room;
    const clientId = info.clientId;
    info.room = null;
    info.clientId = null;
    if (!room || !clientId) return;
    const member = room.members.get(clientId);
    if (member && member.conn === conn) {
      member.conn = null;
      member.offlineSince = this.now();
      this.broadcastMembers(room);
      this.updateEmpty(room);
    }
  }

  handleRaw(conn: Conn, raw: string): void {
    if (raw.length > 8192) return this.error(conn, 'bad_request', 'Message too large');
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.error(conn, 'bad_request', 'Invalid JSON');
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') {
      return this.error(conn, 'bad_request', 'Invalid message');
    }
    this.handle(conn, msg);
  }

  handle(conn: Conn, msg: ClientMessage): void {
    const info = this.conns.get(conn);
    if (!info) return;
    if (!this.takeToken(info)) {
      if (msg.t !== 'ping') this.error(conn, 'rate_limited', 'Slow down');
      return;
    }
    if (msg.t === 'ping') {
      conn.send({ t: 'pong', id: Number(msg.id) || 0, c0: Number(msg.c0) || 0, s: this.now() });
      return;
    }
    if (msg.t === 'hello') return this.hello(conn, info, msg);

    const room = info.room;
    const clientId = info.clientId;
    if (!room || !clientId) return this.error(conn, 'bad_request', 'Say hello first');

    switch (msg.t) {
      case 'state': {
        const update = sanitizeUpdate(msg.state, room.platform);
        if (!update) return this.error(conn, 'bad_request', 'Invalid state');
        const now = this.now();
        if (Math.abs(update.refTime - now) > 3000) update.refTime = now;
        room.state = { ...update, version: room.state.version + 1, by: clientId };
        this.broadcast(room, { t: 'state', state: room.state });
        return;
      }
      case 'chat': {
        const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 300) : '';
        if (!text) return;
        const m = room.members.get(clientId);
        this.broadcast(room, { t: 'chat', from: clientId, name: m?.name ?? '?', text, ts: this.now() });
        return;
      }
      case 'react': {
        if (!(REACTIONS as readonly string[]).includes(msg.emoji)) return;
        this.broadcast(room, { t: 'react', from: clientId, emoji: msg.emoji });
        return;
      }
      case 'leave': {
        room.members.delete(clientId);
        info.room = null;
        info.clientId = null;
        this.broadcastMembers(room);
        this.updateEmpty(room);
        return;
      }
      default:
        return this.error(conn, 'bad_request', 'Unknown message');
    }
  }

  /** Periodic housekeeping: drop stale members and abandoned rooms. */
  sweep(): void {
    const now = this.now();
    for (const room of this.rooms.values()) {
      let changed = false;
      for (const [id, m] of room.members) {
        if (!m.conn && m.offlineSince !== null && now - m.offlineSince > this.memberTimeout) {
          room.members.delete(id);
          changed = true;
        }
      }
      if (changed) this.broadcastMembers(room);
      if (room.emptySince !== null && now - room.emptySince > this.roomTimeout) this.rooms.delete(room.code);
    }
  }

  stats(): { rooms: number; connections: number } {
    return { rooms: this.rooms.size, connections: this.conns.size };
  }

  // ------------------------------------------------------------------ private

  private hello(conn: Conn, info: ConnInfo, msg: Extract<ClientMessage, { t: 'hello' }>): void {
    if (msg.v !== PROTOCOL_VERSION) return this.error(conn, 'version', 'Please update the Synx app');
    const clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : '';
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(clientId)) return this.error(conn, 'bad_request', 'Invalid client id');
    const name = (typeof msg.name === 'string' ? msg.name : '').trim().slice(0, 24) || 'Friend';

    // Switching rooms on the same socket: leave the old one first.
    if (info.room && info.clientId) this.detach(conn, info);

    let room: Room | undefined;
    if (msg.create) {
      const platform = PLATFORMS.includes(msg.create.platform) ? msg.create.platform : 'instagram';
      room = this.createRoom(platform);
    } else {
      const code = normalizeRoomCode(String(msg.room ?? ''));
      room = isValidRoomCode(code) ? this.rooms.get(code) : undefined;
      if (!room) return this.error(conn, 'room_not_found', `No room with code ${code || '?'}`);
    }

    let member = room.members.get(clientId);
    if (!member) {
      const online = [...room.members.values()].filter((m) => m.conn).length;
      if (room.members.size >= MAX_MEMBERS && online >= MAX_MEMBERS) {
        return this.error(conn, 'room_full', `Rooms hold up to ${MAX_MEMBERS} people`);
      }
      if (room.members.size >= MAX_MEMBERS) {
        // Make space by evicting the member that has been offline the longest.
        const stale = [...room.members.values()].filter((m) => !m.conn).sort((a, b) => (a.offlineSince ?? 0) - (b.offlineSince ?? 0))[0];
        if (stale) room.members.delete(stale.clientId);
      }
      member = { clientId, name, color: this.pickColor(room), conn: null, offlineSince: null };
      room.members.set(clientId, member);
    }
    if (member.conn && member.conn !== conn) {
      const old = member.conn;
      const oldInfo = this.conns.get(old);
      if (oldInfo) oldInfo.room = null;
      old.close(4000, 'Replaced by a newer connection');
    }
    member.conn = conn;
    member.name = name;
    member.offlineSince = null;
    info.room = room;
    info.clientId = clientId;
    room.emptySince = null;

    conn.send({
      t: 'welcome',
      you: clientId,
      room: room.code,
      platform: room.platform,
      members: this.memberList(room),
      state: room.state,
      serverTime: this.now(),
    });
    this.broadcastMembers(room, conn);
  }

  private createRoom(platform: PlatformId): Room {
    let code = '';
    for (let i = 0; i < 100; i++) {
      code = '';
      for (let j = 0; j < ROOM_CODE_LENGTH; j++) code += ROOM_CODE_ALPHABET[Math.floor(this.random() * ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) break;
    }
    const room: Room = { code, platform, members: new Map(), state: initialState(), createdAt: this.now(), emptySince: null };
    room.state.refTime = this.now();
    this.rooms.set(code, room);
    return room;
  }

  private pickColor(room: Room): string {
    const used = new Set([...room.members.values()].map((m) => m.color));
    return COLORS.find((c) => !used.has(c)) ?? COLORS[room.members.size % COLORS.length];
  }

  private memberList(room: Room): Member[] {
    return [...room.members.values()].map((m) => ({ clientId: m.clientId, name: m.name, color: m.color, online: !!m.conn }));
  }

  private broadcastMembers(room: Room, except?: Conn): void {
    this.broadcast(room, { t: 'members', members: this.memberList(room) }, except);
  }

  private broadcast(room: Room, msg: ServerMessage, except?: Conn): void {
    for (const m of room.members.values()) if (m.conn && m.conn !== except) m.conn.send(msg);
  }

  private updateEmpty(room: Room): void {
    const anyOnline = [...room.members.values()].some((m) => m.conn);
    room.emptySince = anyOnline ? null : (room.emptySince ?? this.now());
  }

  private error(conn: Conn, code: Extract<ServerMessage, { t: 'error' }>['code'], message: string): void {
    conn.send({ t: 'error', code, message });
  }

  private takeToken(info: ConnInfo): boolean {
    const now = this.now();
    const max = this.rateLimit * 4;
    info.tokens = Math.min(max, info.tokens + ((now - info.lastRefill) / 1000) * this.rateLimit);
    info.lastRefill = now;
    if (info.tokens < 1) return false;
    info.tokens -= 1;
    return true;
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function sanitizeUpdate(raw: unknown, platform: PlatformId): PlaybackUpdate | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  let reel: Reel | null = null;
  if (s.reel && typeof s.reel === 'object') {
    const r = s.reel as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(r.id)) return null;
    if (typeof r.url !== 'string' || r.url.length > 512 || !/^https:\/\//.test(r.url)) return null;
    const p = PLATFORMS.includes(r.platform as PlatformId) ? (r.platform as PlatformId) : platform;
    reel = { platform: p, id: r.id, url: r.url };
  }
  const duration = num(s.duration, NaN);
  return {
    reel,
    playing: !!s.playing,
    rate: clampRate(num(s.rate, 1)),
    position: Math.max(0, Math.min(24 * 3600, num(s.position, 0))),
    refTime: num(s.refTime, 0),
    duration: duration > 0 && duration < 24 * 3600 ? duration : null,
    cause: CAUSES.includes(s.cause as StateCause) ? (s.cause as StateCause) : 'sync',
  };
}
