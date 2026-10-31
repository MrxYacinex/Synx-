import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { WebViewHandle } from './webview';
import { SyncClient, type ConnectionStatus } from '../shared/client';
import { AgentSession } from '../shared/session';
import type { AgentStatus } from '../shared/bridge';
import type { ErrorCode, Member, PlatformId, PlaybackState } from '../shared/protocol';
import type { Profile } from './profile';

export interface Toast {
  id: number;
  text: string;
  color?: string;
}
export interface ChatMessage {
  id: number;
  from: string;
  name: string;
  text: string;
  color: string;
  mine: boolean;
  ts: number;
}
export interface FloatingReaction {
  id: number;
  emoji: string;
  color: string;
}

export type JoinTarget = { room: string } | { create: PlatformId };

let seq = 0;
const nextId = () => ++seq;

function rateLabel(rate: number): string {
  return `${Number.isInteger(rate) ? rate : rate.toFixed(2).replace(/0$/, '')}×`;
}

function describe(prev: PlaybackState | null, next: PlaybackState, who: string): string | null {
  switch (next.cause) {
    case 'pause':
      return `${who} paused`;
    case 'play':
      return `${who} pressed play`;
    case 'rate':
      return `${who} set speed to ${rateLabel(next.rate)}`;
    case 'reel':
      return prev?.reel ? `${who} scrolled to the next reel` : `${who} picked the first reel`;
    case 'seek':
      return `${who} skipped to ${Math.floor(next.position / 60)}:${String(Math.floor(next.position % 60)).padStart(2, '0')}`;
    default:
      return null;
  }
}

export function useRoom(profile: Profile | null, target: JoinTarget | null, webRef: RefObject<WebViewHandle | null>) {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [room, setRoom] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformId | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [state, setState] = useState<PlaybackState | null>(null);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [chats, setChats] = useState<ChatMessage[]>([]);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [error, setError] = useState<{ code: ErrorCode; message: string } | null>(null);
  const [initialUrl, setInitialUrl] = useState<string | null>(null);

  const clientRef = useRef<SyncClient | null>(null);
  const sessionRef = useRef<AgentSession | null>(null);
  const membersRef = useRef<Member[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  };

  const toast = (text: string, color?: string) => {
    const t = { id: nextId(), text, color };
    setToasts((xs) => [...xs.slice(-2), t]);
    later(() => setToasts((xs) => xs.filter((x) => x.id !== t.id)), 2600);
  };

  const targetKey = target ? ('room' in target ? `room:${target.room}` : `create:${target.create}`) : null;

  useEffect(() => {
    if (!profile || !target) return;
    const client = new SyncClient({ url: profile.serverUrl, clientId: profile.clientId, name: profile.name || 'Friend' });
    const session = new AgentSession(client, (js) => webRef.current?.injectJavaScript(js), {
      status: (s) => setAgent(s),
      log: (m) => __DEV__ && console.log('[synx/page]', m),
    });
    clientRef.current = client;
    sessionRef.current = session;
    const nameOf = (id: string | null) => membersRef.current.find((m) => m.clientId === id);
    let last: PlaybackState | null = null;

    const off = client.on({
      status: setStatus,
      welcome: ({ room, platform }) => {
        setRoom(room);
        setPlatform(platform);
        setError(null);
        setInitialUrl((u) => u ?? client.state.reel?.url ?? '');
      },
      members: (ms) => {
        const before = membersRef.current;
        if (before.length) {
          for (const m of ms) {
            const old = before.find((b) => b.clientId === m.clientId);
            if (m.clientId === client.clientId) continue;
            if ((!old || !old.online) && m.online) toast(`${m.name} joined`, m.color);
            if (old?.online && !m.online) toast(`${m.name} dropped out`, m.color);
          }
          for (const b of before) {
            if (!ms.find((m) => m.clientId === b.clientId) && b.clientId !== client.clientId) toast(`${b.name} left`, b.color);
          }
        }
        membersRef.current = ms;
        setMembers(ms);
      },
      state: (s, local) => {
        setState(s);
        if (!local && s.by && s.by !== client.clientId && (!last || s.version > last.version)) {
          const m = nameOf(s.by);
          const text = describe(last, s, m?.name ?? 'Someone');
          if (text) toast(text, m?.color);
        }
        last = s;
      },
      chat: (msg) => {
        const m = nameOf(msg.from);
        const item: ChatMessage = {
          id: nextId(),
          from: msg.from,
          name: msg.name,
          text: msg.text,
          ts: msg.ts,
          color: m?.color ?? '#fff',
          mine: msg.from === client.clientId,
        };
        setChats((xs) => [...xs.slice(-99), item]);
      },
      react: (msg) => {
        const r = { id: nextId(), emoji: msg.emoji, color: nameOf(msg.from)?.color ?? '#fff' };
        setReactions((xs) => [...xs.slice(-19), r]);
        later(() => setReactions((xs) => xs.filter((x) => x.id !== r.id)), 3200);
      },
      error: (code, message) => setError({ code, message }),
    });
    client.join(target);
    return () => {
      off();
      session.dispose();
      client.close();
      timers.current.forEach(clearTimeout);
      timers.current.clear();
      clientRef.current = null;
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.clientId, profile?.serverUrl, targetKey]);

  const actions = useMemo(
    () => ({
      onWebMessage: (data: string) => sessionRef.current?.handleMessage(data),
      togglePlay: () => sessionRef.current?.togglePlay(),
      setRate: (r: number) => sessionRef.current?.setRate(r),
      rejoin: () => sessionRef.current?.rejoin(),
      setSound: (on: boolean) => sessionRef.current?.setSound(on),
      chat: (text: string) => clientRef.current?.chat(text),
      react: (emoji: string) => clientRef.current?.react(emoji),
    }),
    [],
  );

  return {
    clientId: profile?.clientId ?? '',
    status,
    room,
    platform,
    members,
    state,
    agent,
    toasts,
    chats,
    reactions,
    error,
    /** URL to open first: the room's current clip, '' = platform home, null = not known yet. */
    initialUrl,
    ...actions,
  };
}
