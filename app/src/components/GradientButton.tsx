import { LinearGradient } from 'expo-linear-gradient';
import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { colors, gradient } from '../lib/theme';

export function GradientButton({
  title,
  onPress,
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [style, { opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }]}
    >
      <LinearGradient colors={gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.btn}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.text}>{title}</Text>}
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  text: { color: colors.text, fontSize: 17, fontWeight: '700' },
});
