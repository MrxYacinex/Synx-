import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useProfile } from '../lib/profile';
import { defaultServerUrl, httpBase } from '../lib/config';
import { colors } from '../lib/theme';

export default function Settings() {
  const insets = useSafeAreaInsets();
  const [profile, update] = useProfile();
  const [server, setServer] = useState('');
  const [check, setCheck] = useState<string | null>(null);

  useEffect(() => {
    if (profile) setServer(profile.serverUrl);
  }, [profile?.serverUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!profile) return <View style={styles.screen} />;

  const test = async () => {
    setCheck('Checking…');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${httpBase(server.trim())}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      const body = await res.json();
      setCheck(body.ok ? `✅ Connected · ${body.rooms} active room(s)` : '⚠️ Unexpected answer');
    } catch {
      setCheck('❌ Could not reach the server');
    }
  };

  const save = async () => {
    await update({ serverUrl: server.trim() || defaultServerUrl() });
    router.back();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 22, paddingTop: insets.top + 18, paddingBottom: insets.bottom + 30 }}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        <Pressable onPress={save} hitSlop={12}>
          <Text style={styles.done}>Done</Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>Sound on by default</Text>
          <Text style={styles.rowSub}>Unmute clips automatically when you join.</Text>
        </View>
        <Switch value={profile.sound} onValueChange={(v) => void update({ sound: v })} />
      </View>

      <Text style={styles.label}>Sync server</Text>
      <TextInput
        value={server}
        onChangeText={(t) => {
          setServer(t);
          setCheck(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
        placeholder="wss://your-synx-server.example.com"
        placeholderTextColor={colors.faint}
      />
      <Text style={styles.help}>
        Everyone in a party must use the same server. During development this defaults to the computer running Expo (port 8787).
      </Text>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
        <Pressable style={styles.smallBtn} onPress={test}>
          <Text style={styles.smallBtnText}>Test connection</Text>
        </Pressable>
        <Pressable style={styles.smallBtn} onPress={() => setServer(defaultServerUrl())}>
          <Text style={styles.smallBtnText}>Reset</Text>
        </Pressable>
      </View>
      {check ? <Text style={styles.check}>{check}</Text> : null}

      <Text style={[styles.help, { marginTop: 28 }]}>Your device id: {profile.clientId}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 },
  title: { color: colors.text, fontSize: 30, fontWeight: '800' },
  done: { color: colors.pink, fontSize: 17, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: 16, padding: 16, gap: 12 },
  rowTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  rowSub: { color: colors.muted, fontSize: 13, marginTop: 2 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 26 },
  input: {
    height: 52,
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    color: colors.text,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  help: { color: colors.faint, fontSize: 13, lineHeight: 18, marginTop: 8 },
  smallBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder },
  smallBtnText: { color: colors.text, fontWeight: '600' },
  check: { color: colors.text, marginTop: 12, fontSize: 15 },
});
