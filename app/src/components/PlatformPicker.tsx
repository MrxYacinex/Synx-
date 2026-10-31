import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PLATFORMS } from '../shared/reel';
import type { PlatformId } from '../shared/protocol';
import { colors } from '../lib/theme';

const ICONS: Record<PlatformId, string> = { instagram: '📸', tiktok: '🎵', youtube: '▶️' };
const SHORT: Record<PlatformId, string> = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'Shorts' };

export function PlatformPicker({ value, onChange }: { value: PlatformId; onChange: (p: PlatformId) => void }) {
  return (
    <View style={styles.row}>
      {(Object.keys(PLATFORMS) as PlatformId[]).map((id) => {
        const active = id === value;
        const accent = PLATFORMS[id].accent;
        return (
          <Pressable
            key={id}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={PLATFORMS[id].label}
            onPress={() => onChange(id)}
            style={({ pressed }) => [
              styles.card,
              active && { borderColor: accent, backgroundColor: accent + '22' },
              pressed && { opacity: 0.8 },
            ]}
          >
            <Text style={styles.icon}>{ICONS[id]}</Text>
            <Text style={[styles.label, active && { color: colors.text }]}>{SHORT[id]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  card: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.cardBorder,
    backgroundColor: colors.card,
  },
  icon: { fontSize: 24, marginBottom: 6 },
  label: { color: colors.muted, fontWeight: '600', fontSize: 13 },
});
