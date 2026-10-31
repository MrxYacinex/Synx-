import { useEffect, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ConnectionStatus } from '../shared/client';
import type { AgentStatus } from '../shared/bridge';
import { ALLOWED_RATES, REACTIONS, type Member, type PlatformId, type PlaybackState } from '../shared/protocol';
import { PLATFORMS } from '../shared/reel';
import type { ChatMessage, FloatingReaction, Toast } from '../lib/useRoom';
import { shareLink } from '../lib/config';
import { colors } from '../lib/theme';
import { FloatingReactions } from './FloatingReactions';
import { ChatSheet } from './ChatSheet';

export interface WatchOverlayProps {
  room: string;
  platform: PlatformId;
  serverUrl: string;
  clientId: string;
  status: ConnectionStatus;
  members: Member[];
  state: PlaybackState | null;
  agent: AgentStatus | null;
  toasts: Toast[];
  chats: ChatMessage[];
  reactions: FloatingReaction[];
  soundOn: boolean;
  onLeave: () => void;
  onTogglePlay: () => void;
  onRate: (r: number) => void;
  onSound: (on: boolean) => void;
  onReact: (e: string) => void;
  onChat: (t: string) => void;
  onRejoin: () => void;
  onLogin: () => void;
}

type Popover = null | 'speed' | 'react';

function rateText(r: number) {
  return `${r}×`;
}

function syncInfo(status: ConnectionStatus, agent: AgentStatus | null, platform: PlatformId): { color: string; text: string } {
  if (status !== 'connected') return { color: colors.amber, text: 'Reconnecting…' };
  switch (agent?.mode) {
    case 'synced':
      return { color: colors.green, text: 'In sync' };
    case 'syncing':
      return { color: colors.amber, text: 'Syncing…' };
    case 'navigating':
      return { color: colors.amber, text: 'Opening reel…' };
    case 'login':
      return { color: colors.faint, text: `Log in to ${PLATFORMS[platform].label.split(' ')[0]}` };
    case 'away':
      return { color: colors.faint, text: 'Browsing solo' };
    case 'no-clip':
      return { color: colors.faint, text: 'Open a reel to start' };
    case 'nav-failed':
      return { color: colors.red, text: "Couldn't open reel" };
    default:
      return { color: colors.faint, text: 'Waiting…' };
  }
}

export function WatchOverlay(p: WatchOverlayProps) {
  const insets = useSafeAreaInsets();
  const [pop, setPop] = useState<Popover>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [seenChats, setSeenChats] = useState(0);
  const [recent, setRecent] = useState<ChatMessage[]>([]);

  // Show the latest incoming messages as bubbles for a few seconds.
  useEffect(() => {
    if (chatOpen) {
      setSeenChats(p.chats.length);
      setRecent([]);
      return;
    }
    const fresh = p.chats.slice(seenChats).filter((c) => !c.mine);
    if (!fresh.length) return;
    setRecent((r) => [...r, ...fresh].slice(-3));
    setSeenChats(p.chats.length);
    const ids = new Set(fresh.map((f) => f.id));
    const t = setTimeout(() => setRecent((r) => r.filter((x) => !ids.has(x.id))), 6000);
    return () => clearTimeout(t);
  }, [p.chats, chatOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const online = p.members.filter((m) => m.online);
  const info = syncInfo(p.status, p.agent, p.platform);
  const playing = p.state?.playing ?? true;
  const rate = p.state?.rate ?? 1;
  const unread = p.chats.length - seenChats;

  const share = async () => {
    const link = shareLink(p.serverUrl, p.room);
    await Share.share({ message: `Watch reels with me on Synx 🎬 Code: ${p.room}\n${link}` });
  };
  const copy = async () => {
    await Clipboard.setStringAsync(p.room);
    void Haptics.selectionAsync();
  };
  const tap = (fn: () => void) => () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fn();
  };

  const banner = (() => {
    const mode = p.agent?.mode;
    if (mode === 'away') return { text: "You're browsing on your own.", action: 'Back to the party', onPress: p.onRejoin };
    if (mode === 'nav-failed') return { text: "Couldn't open your friend's reel.", action: 'Try again', onPress: p.onRejoin };
    if (mode === 'login' && !/\/(accounts\/login|login)/.test(p.agent?.url ?? ''))
      return { text: `Log in to ${PLATFORMS[p.platform].label.split(' ')[0]} to scroll together. Your login stays on this phone – Synx never sees it.`, action: 'Log in', onPress: p.onLogin };
    if (mode === 'no-clip' && online.length > 0) return { text: 'Open the Reels tab and start scrolling – your friends will follow.', action: null, onPress: null };
    return null;
  })();

  return (
    <>
      {/* Top bar */}
      <View style={[styles.top, { top: insets.top + 6 }]} pointerEvents="box-none">
        <Pressable accessibilityLabel="Leave room" onPress={p.onLeave} style={styles.circle} hitSlop={8}>
          <Text style={styles.circleText}>✕</Text>
        </Pressable>
        <Pressable onPress={copy} onLongPress={share} style={styles.pill} accessibilityLabel={`Room ${p.room}, ${info.text}. Tap to copy code`}>
          <View style={[styles.dot, { backgroundColor: info.color }]} />
          <Text style={styles.code}>{p.room}</Text>
          <View style={styles.avatars}>
            {online.slice(0, 4).map((m, i) => (
              <View key={m.clientId} style={[styles.avatar, { backgroundColor: m.color, marginLeft: i ? -7 : 0 }]}>
                <Text style={styles.avatarText}>{(m.name[0] ?? '?').toUpperCase()}</Text>
              </View>
            ))}
          </View>
        </Pressable>
        <Pressable accessibilityLabel="Invite friends" onPress={share} style={styles.circle} hitSlop={8}>
          <Text style={styles.circleText}>＋</Text>
        </Pressable>
      </View>
      <View style={[styles.statusRow, { top: insets.top + 54 }]} pointerEvents="none">
        <Text style={styles.statusText}>
          {info.text}
          {online.length <= 1 ? ' · waiting for friends' : ` · ${online.length} watching`}
        </Text>
      </View>

      {/* Toasts */}
      <View style={[styles.toasts, { top: insets.top + 80 }]} pointerEvents="none">
        {p.toasts.map((t) => (
          <View key={t.id} style={styles.toast}>
            {t.color ? <View style={[styles.dot, { backgroundColor: t.color }]} /> : null}
            <Text style={styles.toastText}>{t.text}</Text>
          </View>
        ))}
      </View>

      {/* Chat bubbles */}
      <View style={[styles.bubbles, { top: insets.top + 150 }]} pointerEvents="none">
        {recent.map((m) => (
          <View key={m.id} style={styles.bubble}>
            <Text style={[styles.bubbleName, { color: m.color }]}>{m.name}</Text>
            <Text style={styles.bubbleText}>{m.text}</Text>
          </View>
        ))}
      </View>

      {/* Banner */}
      {banner ? (
        <View style={[styles.banner, { bottom: insets.bottom + 110 }]}>
          <Text style={styles.bannerText}>{banner.text}</Text>
          {banner.action ? (
            <Pressable onPress={banner.onPress!} style={styles.bannerBtn}>
              <Text style={styles.bannerBtnText}>{banner.action}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Side controls */}
      <View style={[styles.side, { top: insets.top + 180 }]} pointerEvents="box-none">
        <Pressable onPress={() => (setCollapsed((c) => !c), setPop(null))} style={styles.handle} accessibilityLabel={collapsed ? 'Show controls' : 'Hide controls'}>
          <Text style={styles.handleText}>{collapsed ? '›' : '‹'}</Text>
        </Pressable>
        {!collapsed ? (
          <>
            <Ctrl label={playing ? '❚❚' : '▶'} a11y={playing ? 'Pause for everyone' : 'Play for everyone'} onPress={tap(p.onTogglePlay)} />
            <Ctrl label={rateText(rate)} a11y="Playback speed" onPress={() => setPop(pop === 'speed' ? null : 'speed')} active={rate !== 1} small />
            <Ctrl label={p.soundOn ? '🔊' : '🔇'} a11y={p.soundOn ? 'Mute' : 'Unmute'} onPress={tap(() => p.onSound(!p.soundOn))} />
            <Ctrl label="😂" a11y="Send a reaction" onPress={() => setPop(pop === 'react' ? null : 'react')} />
            <Ctrl label="💬" a11y="Chat" badge={unread > 0 ? unread : 0} onPress={() => (setChatOpen(true), setPop(null))} />
          </>
        ) : null}
        {pop === 'speed' ? (
          <View style={[styles.popover, { top: 44 + 52 }]}>
            {ALLOWED_RATES.map((r) => (
              <Pressable
                key={r}
                onPress={tap(() => (p.onRate(r), setPop(null)))}
                style={[styles.popItem, r === rate && styles.popItemActive]}
                accessibilityLabel={`Speed ${r}`}
              >
                <Text style={styles.popText}>{rateText(r)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {pop === 'react' ? (
          <View style={[styles.popover, { top: 44 + 52 * 3 }]}>
            {REACTIONS.map((e) => (
              <Pressable key={e} onPress={tap(() => p.onReact(e))} style={styles.popItem} accessibilityLabel={`React ${e}`}>
                <Text style={styles.popEmoji}>{e}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      <FloatingReactions items={p.reactions} bottom={insets.bottom + 160} />
      <ChatSheet visible={chatOpen} onClose={() => setChatOpen(false)} messages={p.chats} onSend={p.onChat} />
    </>
  );
}

function Ctrl({ label, a11y, onPress, active, small, badge }: { label: string; a11y: string; onPress: () => void; active?: boolean; small?: boolean; badge?: number }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onPress} style={({ pressed }) => [styles.ctrl, active && styles.ctrlActive, pressed && { transform: [{ scale: 0.92 }] }]}>
      <Text style={[styles.ctrlText, small && { fontSize: 14, fontWeight: '800' }]}>{label}</Text>
      {badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const glass = { backgroundColor: colors.glass, borderColor: colors.glassBorder, borderWidth: StyleSheet.hairlineWidth };

const styles = StyleSheet.create({
  top: { position: 'absolute', left: 10, right: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  circle: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', ...glass },
  circleText: { color: colors.text, fontSize: 17, fontWeight: '700' },
  pill: { flexDirection: 'row', alignItems: 'center', height: 40, borderRadius: 20, paddingHorizontal: 14, gap: 8, ...glass },
  dot: { width: 9, height: 9, borderRadius: 5 },
  code: { color: colors.text, fontWeight: '800', fontSize: 16, letterSpacing: 3 },
  avatars: { flexDirection: 'row', marginLeft: 2 },
  avatar: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#0B0B12' },
  avatarText: { color: '#0B0B12', fontWeight: '900', fontSize: 11 },
  statusRow: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  statusText: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.8)', textShadowRadius: 4 },
  toasts: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: 6 },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, ...glass },
  toastText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  bubbles: { position: 'absolute', left: 64, right: 80, gap: 6 },
  bubble: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, maxWidth: '100%', ...glass },
  bubbleName: { fontSize: 11, fontWeight: '800' },
  bubbleText: { color: colors.text, fontSize: 14 },
  banner: { position: 'absolute', left: 20, right: 20, padding: 16, borderRadius: 20, alignItems: 'center', gap: 10, ...glass, backgroundColor: 'rgba(12,12,20,0.85)' },
  bannerText: { color: colors.text, fontSize: 15, textAlign: 'center', lineHeight: 21 },
  bannerBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 20, backgroundColor: colors.pink },
  bannerBtnText: { color: colors.text, fontWeight: '800' },
  side: { position: 'absolute', left: 8, gap: 8, alignItems: 'flex-start' },
  handle: { width: 44, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', ...glass },
  handleText: { color: colors.text, fontSize: 22, fontWeight: '700', marginTop: -2 },
  ctrl: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', ...glass },
  ctrlActive: { backgroundColor: colors.pink, borderColor: colors.pink },
  ctrlText: { color: colors.text, fontSize: 18 },
  badge: { position: 'absolute', top: -3, right: -3, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.pink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: colors.text, fontSize: 11, fontWeight: '800' },
  popover: { position: 'absolute', left: 54, flexDirection: 'row', gap: 4, padding: 4, borderRadius: 24, ...glass, backgroundColor: 'rgba(12,12,20,0.88)' },
  popItem: { minWidth: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  popItemActive: { backgroundColor: colors.pink },
  popText: { color: colors.text, fontWeight: '800', fontSize: 14 },
  popEmoji: { fontSize: 24 },
});
