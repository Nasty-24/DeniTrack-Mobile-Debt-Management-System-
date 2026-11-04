import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Image, StyleSheet, View } from 'react-native';

import { colors, space } from '../theme/tokens';
import { AppText } from './ui';

const MIN_VISIBLE_MS = 700;
const SLOW_START_MS = 1500;

/**
 * Launch screen shown while the session is restored. The app icon sits exactly where the
 * native splash draws it (same image, size and centre), so the hand-off is seamless; the
 * name and slogan fade in below it, and the whole screen fades out once the app is ready.
 */
export function BrandSplash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [screenOpacity] = useState(() => new Animated.Value(1));
  const [textOpacity] = useState(() => new Animated.Value(0));
  const [minElapsed, setMinElapsed] = useState(false);
  const [slow, setSlow] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => undefined);
    Animated.timing(textOpacity, { toValue: 1, duration: 300, delay: 100, useNativeDriver: true }).start();
    const min = setTimeout(() => setMinElapsed(true), MIN_VISIBLE_MS);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_START_MS);
    return () => {
      clearTimeout(min);
      clearTimeout(slowTimer);
    };
  }, [textOpacity]);

  useEffect(() => {
    if (!ready || !minElapsed) return;
    if (reduceMotion) {
      onDone();
      return;
    }
    Animated.timing(screenOpacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => onDone());
  }, [ready, minElapsed, reduceMotion, screenOpacity, onDone]);

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: colors.canvas, opacity: screenOpacity }]}
      onLayout={() => void SplashScreen.hideAsync().catch(() => undefined)}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="DeniTrack is starting"
    >
      <Image source={require('../../assets/splash-icon.png')} style={styles.mark} accessibilityIgnoresInvertColors />
      <Animated.View style={[styles.text, { opacity: textOpacity }]}>
        <AppText variant="title">DeniTrack</AppText>
        <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.xs }}>
          Every debt accounted for. Every payment tracked.
        </AppText>
        <View style={{ height: 24, marginTop: space.xl }}>{slow ? <ActivityIndicator color={colors.brand} /> : null}</View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  // Matches app.json's expo-splash-screen imageWidth (200).
  mark: { width: 200, height: 200 },
  // The tile inside the image is ~124 dp tall, so the text starts just below it.
  text: { position: 'absolute', top: '50%', marginTop: 78, left: 0, right: 0, alignItems: 'center' },
});
