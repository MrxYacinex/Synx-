import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { GradientButton } from '../components/GradientButton';
import { PlatformPicker } from '../components/PlatformPicker';
import { useProfile } from '../lib/profile';
import { colors, gradient } from '../lib/theme';
import { ROOM_CODE_LENGTH, isValidRoomCode, normalizeRoomCode } from '../shared/protocol';

export default function Home() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const [profile, updateProfile] = useProfile();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  useEffect(() => {
    if (profile && !name) setName(profile.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.name]);
  useEffect(() => {
    if (params.code) setCode(normalizeRoomCode(params.code));
  }, [params.code]);

  if (!profile) return <View style={styles.screen} />;

  const saveName = () => updateProfile({ name: name.trim().slice(0, 24) });
  const ready = name.trim().length > 0;
  const codeOk = isValidRoomCode(code);

  const start = async () => {
    await saveName();
    router.push({ pathname: '/room/[code]', params: { code: 'new', platform: profile.platform } });
  };
  const join = async () => {
    await saveName();
    router.push({ pathname: '/room/[code]', params: { code } });
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.logo}>synx</Text>
          <Pressable accessibilityLabel="Settings" hitSlop={12} onPress={() => router.push('/settings')}>
            <Text style={styles.gear}>⚙︎</Text>
          </Pressable>
        </View>
        <LinearGradient colors={gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.underline} />
        <Text style={styles.tagline}>Scroll reels together.{'\n'}Same clip, same second, same speed.</Text>

        {params.error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{params.error}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>Your name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          onBlur={saveName}
          placeholder="What should friends see?"
          placeholderTextColor={colors.faint}
          style={styles.input}
          maxLength={24}
          autoCapitalize="words"
          returnKeyType="done"
        />

        <Text style={styles.label}>Watch on</Text>
        <PlatformPicker value={profile.platform} onChange={(p) => updateProfile({ platform: p })} />

        <GradientButton title="Start a watch party" onPress={start} disabled={!ready} style={{ marginTop: 22 }} />

        <View style={styles.dividerRow}>
          <View style={styles.divider} />
          <Text style={styles.or}>or join a friend</Text>
          <View style={styles.divider} />
        </View>

        <View style={styles.joinRow}>
          <TextInput
            value={code}
            onChangeText={(t) => setCode(normalizeRoomCode(t))}
            placeholder="CODE"
            placeholderTextColor={colors.faint}
            style={[styles.input, styles.codeInput]}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={ROOM_CODE_LENGTH}
            returnKeyType="go"
            onSubmitEditing={() => codeOk && ready && join()}
          />
          <Pressable
            accessibilityRole="button"
            onPress={join}
            disabled={!codeOk || !ready}
            style={({ pressed }) => [styles.joinBtn, (!codeOk || !ready) && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.joinText}>Join</Text>
          </Pressable>
        </View>
        {!ready ? <Text style={styles.hint}>Enter your name first.</Text> : null}

        <View style={styles.how}>
          <Text style={styles.howTitle}>How it works</Text>
          <Step n={1} text="Start a party and send the code (or link) to your friend." />
          <Step n={2} text="You both log in to Instagram/TikTok/YouTube inside Synx – it's your real feed." />
          <Step n={3} text="Anyone scrolls, pauses or switches to 2× – everyone follows instantly." />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepDot}>
        <Text style={styles.stepN}>{n}</Text>
      </View>
      <Text style={styles.stepText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 22 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logo: { color: colors.text, fontSize: 52, fontWeight: '900', letterSpacing: -2 },
  gear: { color: colors.muted, fontSize: 26 },
  underline: { height: 5, width: 70, borderRadius: 3, marginTop: 2 },
  tagline: { color: colors.muted, fontSize: 17, lineHeight: 24, marginTop: 14, marginBottom: 22 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 16 },
  input: {
    height: 54,
    borderRadius: 16,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    color: colors.text,
    paddingHorizontal: 16,
    fontSize: 17,
  },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 22, gap: 10 },
  divider: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.cardBorder },
  or: { color: colors.faint, fontSize: 13 },
  joinRow: { flexDirection: 'row', gap: 10 },
  codeInput: { flex: 1, minWidth: 0, fontSize: 24, fontWeight: '800', letterSpacing: 8, textAlign: 'center' },
  joinBtn: {
    height: 54,
    paddingHorizontal: 26,
    borderRadius: 16,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  joinText: { color: colors.bg, fontSize: 17, fontWeight: '800' },
  hint: { color: colors.faint, fontSize: 13, marginTop: 8 },
  errorBox: { backgroundColor: colors.red + '22', borderColor: colors.red, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 6 },
  errorText: { color: colors.text, fontSize: 15 },
  how: { marginTop: 34, padding: 18, borderRadius: 20, backgroundColor: colors.card, gap: 12 },
  howTitle: { color: colors.text, fontWeight: '800', fontSize: 16, marginBottom: 2 },
  step: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  stepDot: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.violet, alignItems: 'center', justifyContent: 'center' },
  stepN: { color: colors.text, fontWeight: '800', fontSize: 13 },
  stepText: { color: colors.muted, flex: 1, fontSize: 15, lineHeight: 21 },
});
