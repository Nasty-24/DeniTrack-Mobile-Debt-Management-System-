import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ApiError } from '../services/apiClient';
import { colors, space } from '../theme/tokens';
import { AppText, Button } from './ui';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.center} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.brand} />
      <AppText variant="caption" color={colors.inkMuted} style={{ marginTop: space.sm }}>
        {label}
      </AppText>
    </View>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <View style={styles.center}>
      <AppText variant="heading" align="center">
        {title}
      </AppText>
      {body ? (
        <AppText color={colors.inkMuted} align="center" style={styles.body}>
          {body}
        </AppText>
      ) : null}
      {action ? <View style={{ marginTop: space.lg }}>{action}</View> : null}
    </View>
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const offline = error instanceof ApiError && error.isNetwork;
  return (
    <View style={styles.center} accessibilityRole="alert">
      <AppText variant="heading" align="center">
        {offline ? 'You are offline' : 'Could not load this'}
      </AppText>
      <AppText color={colors.inkMuted} align="center" style={styles.body}>
        {errorMessage(error)}
      </AppText>
      {onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} style={{ marginTop: space.lg }} /> : null}
    </View>
  );
}

/** Inline, non-blocking message (form submission errors, stale-cache notices). */
export function Banner({ tone, children }: { tone: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode }) {
  const palette = {
    info: [colors.infoSoft, colors.info],
    warning: [colors.warningSoft, colors.warning],
    danger: [colors.dangerSoft, colors.danger],
    success: [colors.successSoft, colors.success],
  }[tone];
  return (
    <View
      style={[styles.banner, { backgroundColor: palette[0], borderLeftColor: palette[1] }]}
      accessibilityRole={tone === 'danger' ? 'alert' : 'text'}
      accessibilityLiveRegion="polite"
    >
      {typeof children === 'string' ? <AppText color={colors.ink}>{children}</AppText> : children}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, minHeight: 220 },
  body: { marginTop: space.sm, maxWidth: 320 },
  banner: { borderLeftWidth: 3, borderRadius: 6, padding: space.md, marginBottom: space.md },
});
