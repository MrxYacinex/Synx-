import { useEffect, useState } from 'react';
import { ImageBackground, Platform, StyleSheet, View } from 'react-native';
import { WatchOverlay } from '../components/WatchOverlay';
import type { ChatMessage, FloatingReaction, Toast } from '../lib/useRoom';

/** Dev-only: the watch overlay over a fake reel, for design work and screenshots. */
export default function Preview() {
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  useEffect(() => {
    const t = setTimeout(() => setReactions([{ id: 1, emoji: '😂', color: '#4DD8FF' }, { id: 2, emoji: '🔥', color: '#FF4D8D' }]), 300);
    return () => clearTimeout(t);
  }, []);
  if (!__DEV__ && Platform.OS !== 'web') return null;
  const members = [
    { clientId: 'me', name: 'Yasmine', color: '#FF4D8D', online: true },
    { clientId: 'b', name: 'Lina', color: '#4DD8FF', online: true },
  ];
  const toasts: Toast[] = [{ id: 1, text: 'Lina set speed to 2×', color: '#4DD8FF' }];
  const chats: ChatMessage[] = [{ id: 1, from: 'b', name: 'Lina', text: 'NO WAY 😭😭', color: '#4DD8FF', mine: false, ts: 0 }];
  return (
    <View style={styles.screen}>
      <ImageBackground source={{ uri: 'https://picsum.photos/seed/synx/600/1100' }} style={StyleSheet.absoluteFill} />
      <WatchOverlay
        room="K7QXP"
        platform="instagram"
        serverUrl="wss://synx.example.com"
        clientId="me"
        status="connected"
        members={members}
        state={{ reel: null, playing: true, rate: 2, position: 0, refTime: 0, duration: 12, version: 3, by: 'b', cause: 'rate' }}
        agent={{ url: '', reel: null, hasVideo: true, playing: true, position: 3, duration: 12, drift: 0.02, soundOn: true, mode: 'synced' }}
        toasts={toasts}
        chats={chats}
        reactions={reactions}
        soundOn
        onLeave={() => {}}
        onTogglePlay={() => {}}
        onRate={() => {}}
        onSound={() => {}}
        onReact={() => {}}
        onChat={() => {}}
        onRejoin={() => {}}
        onLogin={() => {}}
      />
    </View>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: '#222' } });
