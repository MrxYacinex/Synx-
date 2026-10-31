import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChatMessage } from '../lib/useRoom';
import { colors } from '../lib/theme';

export function ChatSheet({ visible, onClose, messages, onSend }: { visible: boolean; onClose: () => void; messages: ChatMessage[]; onSend: (t: string) => void }) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const list = useRef<FlatList<ChatMessage>>(null);
  useEffect(() => {
    if (visible) setTimeout(() => list.current?.scrollToEnd({ animated: false }), 50);
  }, [visible, messages.length]);

  const send = () => {
    if (!text.trim()) return;
    onSend(text);
    setText('');
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close chat" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetWrap}>
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.grabber} />
          <FlatList
            ref={list}
            data={messages}
            keyExtractor={(m) => String(m.id)}
            style={{ maxHeight: 320 }}
            contentContainerStyle={{ paddingVertical: 8, gap: 8 }}
            ListEmptyComponent={<Text style={styles.empty}>Say something about this reel 👀</Text>}
            renderItem={({ item }) => (
              <View style={[styles.msg, item.mine && styles.mine]}>
                {!item.mine ? <Text style={[styles.author, { color: item.color }]}>{item.name}</Text> : null}
                <Text style={styles.msgText}>{item.text}</Text>
              </View>
            )}
          />
          <View style={styles.inputRow}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Message"
              placeholderTextColor={colors.faint}
              style={styles.input}
              maxLength={300}
              returnKeyType="send"
              onSubmitEditing={send}
              blurOnSubmit={false}
              autoFocus
            />
            <Pressable onPress={send} style={styles.send} accessibilityLabel="Send">
              <Text style={styles.sendText}>↑</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#14141C', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 14, paddingTop: 8 },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.cardBorder, marginBottom: 6 },
  empty: { color: colors.faint, textAlign: 'center', paddingVertical: 24 },
  msg: { alignSelf: 'flex-start', maxWidth: '82%', backgroundColor: colors.card, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.violet },
  author: { fontSize: 12, fontWeight: '700', marginBottom: 2 },
  msgText: { color: colors.text, fontSize: 15 },
  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingTop: 8 },
  input: { flex: 1, height: 44, borderRadius: 22, backgroundColor: colors.card, color: colors.text, paddingHorizontal: 16, fontSize: 16 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.pink, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: colors.text, fontSize: 22, fontWeight: '800' },
});
