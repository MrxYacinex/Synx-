import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/main';
import { SyncClient } from '../../app/src/shared/client';
import { RoomManager } from '../src/rooms';
import type { PlaybackState, ServerMessage } from '../../app/src/shared/protocol';

let srv: Awaited<ReturnType<typeof startServer>>;
let url = '';
before(async () => {
  srv = await startServer({ port: 0, log: false });
  url = `ws://127.0.0.1:${srv.port}`;
});
after(() => srv.close());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await wait(10);
  }
}

function client(name: string) {
  return new SyncClient({ url, clientId: `id_${name}_${Math.random().toString(36).slice(2, 8)}`, name });
}

test('create, join, share state, chat and react', async () => {
  const a = client('ana');
  const b = client('ben');
  a.join({ create: 'instagram' });
  await until(() => a.status === 'connected');
  assert.match(a.room!, /^[A-Z2-9]{5}$/);
  assert.equal(a.platform, 'instagram');

  b.join({ room: a.room!.toLowerCase() });
  await until(() => b.status === 'connected' && a.members.length === 2);
  assert.equal(b.room, a.room);
  assert.deepEqual(b.members.map((m) => m.name).sort(), ['ana', 'ben']);
  assert.notEqual(a.members[0].color, a.members[1].color);

  const states: PlaybackState[] = [];
  b.on({ state: (s, local) => !local && states.push(s) });
  a.publish({
    reel: { platform: 'instagram', id: 'C9xYz_AbC12', url: 'https://www.instagram.com/reels/C9xYz_AbC12/' },
    playing: true,
    rate: 2,
    position: 1.5,
    refTime: a.serverNow(),
    duration: 12,
    cause: 'reel',
  });
  await until(() => states.length > 0);
  assert.equal(states[0].reel?.id, 'C9xYz_AbC12');
  assert.equal(states[0].rate, 2);
  assert.equal(states[0].by, a.clientId);
  assert.equal(states[0].version, 1);
  await until(() => a.state.version === 1); // echo reaches the sender too

  const chats: string[] = [];
  const reacts: string[] = [];
  a.on({ chat: (m) => chats.push(`${m.name}:${m.text}`), react: (m) => reacts.push(m.emoji) });
  b.chat('  this one is so funny  ');
  b.react('😂');
  b.react('not-an-emoji');
  await until(() => chats.length === 1 && reacts.length === 1);
  assert.deepEqual(chats, ['ben:this one is so funny']);
  assert.deepEqual(reacts, ['😂']);

  a.close();
  b.close();
});

test('late joiner receives current state and clock converges', async () => {
  const a = client('host');
  a.join({ create: 'youtube' });
  await until(() => a.status === 'connected');
  a.publish({ reel: { platform: 'youtube', id: 'abcdefgh', url: 'https://m.youtube.com/shorts/abcdefgh' }, playing: false, rate: 1.5, position: 7, refTime: a.serverNow(), duration: 30, cause: 'pause' });
  await until(() => a.state.version === 1);
  const b = client('late');
  b.join({ room: a.room! });
  await until(() => b.status === 'connected');
  assert.equal(b.state.reel?.id, 'abcdefgh');
  assert.equal(b.state.playing, false);
  assert.equal(b.state.position, 7);
  assert.equal(b.platform, 'youtube');
  await wait(1500);
  // Same machine -> true offset is 0
  assert.ok(Math.abs(b.clock.offset) < 20, `offset ${b.clock.offset}`);
  a.close();
  b.close();
});

test('unknown room reports an error and stops retrying', async () => {
  const c = client('lost');
  const errors: string[] = [];
  c.on({ error: (code) => errors.push(code) });
  c.join({ room: 'ZZZZZ' });
  await until(() => errors.length > 0);
  assert.deepEqual(errors, ['room_not_found']);
  assert.equal(c.status, 'closed');
});

test('client reconnects to the same room after the socket drops', async () => {
  const a = client('re');
  const b = client('stay');
  a.join({ create: 'tiktok' });
  await until(() => a.status === 'connected');
  b.join({ room: a.room! });
  await until(() => b.status === 'connected');
  // Kill a's socket from the server side.
  const room = srv.manager.rooms.get(a.room!)!;
  room.members.get(a.clientId)!.conn!.close(1012, 'test');
  await until(() => a.status === 'reconnecting');
  await until(() => a.status === 'connected', 5000);
  await until(() => b.members.find((m) => m.clientId === a.clientId)?.online === true);
  assert.equal(a.room, b.room);
  a.close();
  b.close();
});

test('room manager: limits, sanitising, sweeping', () => {
  let now = 1_000_000;
  const m = new RoomManager({ now: () => now, memberTimeout: 1000, roomTimeout: 5000 });
  const inbox = new Map<number, ServerMessage[]>();
  const conns = Array.from({ length: 10 }, (_, i) => {
    inbox.set(i, []);
    return { send: (msg: ServerMessage) => inbox.get(i)!.push(msg), close: () => {} };
  });
  conns.forEach((c) => m.connect(c));
  m.handle(conns[0], { t: 'hello', v: 1, clientId: 'client0', name: 'zero', create: { platform: 'instagram' } });
  const welcome = inbox.get(0)!.find((x) => x.t === 'welcome') as Extract<ServerMessage, { t: 'welcome' }>;
  const code = welcome.room;
  for (let i = 1; i < 10; i++) m.handle(conns[i], { t: 'hello', v: 1, clientId: `client${i}`, name: `n${i}`, room: code });
  assert.equal(inbox.get(7)!.at(-1)!.t, 'welcome');
  assert.equal(inbox.get(0)!.at(-1)!.t, 'members');
  assert.deepEqual(inbox.get(8)!.at(-1), { t: 'error', code: 'room_full', message: 'Rooms hold up to 8 people' });

  // Garbage state is rejected, out-of-range values are clamped.
  m.handle(conns[1], { t: 'state', state: { reel: { platform: 'instagram', id: '../../etc', url: 'javascript:alert(1)' } } as never, baseVersion: 0 });
  assert.equal(inbox.get(1)!.at(-1)!.t, 'error');
  m.handle(conns[1], { t: 'state', state: { reel: null, playing: true, rate: 50, position: -3, refTime: 0, duration: -1, cause: 'rate' }, baseVersion: 0 });
  const st = (inbox.get(2)!.at(-1) as Extract<ServerMessage, { t: 'state' }>).state;
  assert.equal(st.rate, 4);
  assert.equal(st.position, 0);
  assert.equal(st.refTime, now); // far-off timestamps are re-anchored
  assert.equal(st.duration, null);

  // Wrong protocol version.
  m.handle(conns[9], { t: 'hello', v: 99, clientId: 'client9', name: 'x', room: code });
  assert.equal((inbox.get(9)!.at(-1) as { code: string }).code, 'version');

  // Everyone leaves -> members time out -> room is deleted.
  conns.forEach((c) => m.disconnect(c));
  now += 2000;
  m.sweep();
  assert.equal(m.rooms.get(code)!.members.size, 0);
  now += 6000;
  m.sweep();
  assert.equal(m.rooms.has(code), false);
});

test('rate limiting kicks in for floods', () => {
  const m = new RoomManager({ rateLimit: 5 });
  const out: ServerMessage[] = [];
  const c = { send: (x: ServerMessage) => out.push(x), close: () => {} };
  m.connect(c);
  m.handle(c, { t: 'hello', v: 1, clientId: 'flooder', name: 'f', create: { platform: 'instagram' } });
  for (let i = 0; i < 50; i++) m.handle(c, { t: 'react', emoji: '🔥' });
  assert.ok(out.some((x) => x.t === 'error' && x.code === 'rate_limited'));
});

test('http endpoints', async () => {
  const base = `http://127.0.0.1:${srv.port}`;
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  const page = await fetch(`${base}/join/abcde`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /synx:\/\/join\/ABCDE/);
  assert.equal((await fetch(`${base}/join/ab`)).status, 404);
});

test('optimistic updates are not undone by late echoes of older updates', async () => {
  const a = client('fast');
  const b = client('watch');
  a.join({ create: 'instagram' });
  await until(() => a.status === 'connected');
  b.join({ room: a.room! });
  await until(() => b.status === 'connected');
  const seen: string[] = [];
  a.on({ state: (s) => seen.push(`${s.cause}:${s.playing}`) });
  const base = { reel: null, rate: 1, position: 0, duration: null } as const;
  a.publish({ ...base, playing: false, refTime: a.serverNow(), cause: 'pause' });
  a.publish({ ...base, playing: true, refTime: a.serverNow(), cause: 'play' });
  a.publish({ ...base, playing: false, refTime: a.serverNow(), cause: 'pause' });
  await until(() => a.state.version === 3 && b.state.version === 3);
  await wait(100);
  // Locally: three optimistic states, then only the final echo. Never a flash back.
  assert.deepEqual(seen, ['pause:false', 'play:true', 'pause:false', 'pause:false']);
  assert.equal(b.state.playing, false);
  a.close();
  b.close();
});
