import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import type { FloatingReaction } from '../lib/useRoom';

function Bubble({ r }: { r: FloatingReaction }) {
  const t = useRef(new Animated.Value(0)).current;
  const drift = useRef((Math.random() - 0.5) * 70).current;
  useEffect(() => {
    Animated.timing(t, { toValue: 1, duration: 3000, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [t]);
  return (
    <Animated.Text
      style={[
        styles.emoji,
        {
          opacity: t.interpolate({ inputRange: [0, 0.1, 0.75, 1], outputRange: [0, 1, 1, 0] }),
          transform: [
            { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -320] }) },
            { translateX: t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, drift, drift * 0.4] }) },
            { scale: t.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0.4, 1.25, 1] }) },
          ],
          textShadowColor: r.color,
        },
      ]}
    >
      {r.emoji}
    </Animated.Text>
  );
}

export function FloatingReactions({ items, bottom }: { items: FloatingReaction[]; bottom: number }) {
  return (
    <View pointerEvents="none" style={[styles.layer, { bottom }]}>
      {items.map((r) => (
        <Bubble key={r.id} r={r} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 70, width: 80, height: 40 },
  emoji: { position: 'absolute', fontSize: 40, textShadowRadius: 12, textShadowOffset: { width: 0, height: 0 } },
});
