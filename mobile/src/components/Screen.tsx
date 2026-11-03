import { useNavigation } from '@react-navigation/native';
import type { ReactNode } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { KeyboardAvoidingView, KeyboardAwareScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useOutbox } from '../hooks/useOutbox';
import { useSession } from '../hooks/useSession';
import { colors, space, themedStyles } from '../theme/tokens';
import { formatDateTime } from '../utils/dates';
import { AppText } from './ui';

interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  footer?: ReactNode;
  padded?: boolean;
  edges?: ('top' | 'bottom')[];
}

export function Screen({ children, scroll = true, refreshing = false, onRefresh, footer, padded = true, edges = [] }: ScreenProps) {
  const styles = getStyles();
  const insets = useSafeAreaInsets();
  // When the safe area does not already pad the bottom, keep content and footers clear of
  // the gesture / navigation bar (Android draws edge-to-edge).
  const bottomInset = edges.includes('bottom') ? 0 : insets.bottom;

  if (!scroll) {
    return (
      <SafeAreaView style={styles.root} edges={edges}>
        <SyncStatusBar />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <View style={[{ flex: 1 }, padded && styles.padded]}>{children}</View>
          {footer ? <View style={[styles.footer, { paddingBottom: space.lg + bottomInset }]}>{footer}</View> : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView style={styles.root} edges={edges}>
      <SyncStatusBar />
      {/* Scrolls the focused field above the keyboard, so long forms stay usable. */}
      <KeyboardAwareScrollView
        style={{ flex: 1 }}
        bottomOffset={footer ? 96 : space.xl}
        contentContainerStyle={[padded && styles.padded, { paddingBottom: space.xxxl + (footer ? 0 : bottomInset) }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        refreshControl={
          onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} /> : undefined
        }
      >
        {children}
      </KeyboardAwareScrollView>
      {footer ? (
        <KeyboardStickyView offset={{ opened: bottomInset }}>
          <View style={[styles.footer, { paddingBottom: space.lg + bottomInset }]}>{footer}</View>
        </KeyboardStickyView>
      ) : null}
    </SafeAreaView>
  );
}

/** Always-visible strip when offline or when records are waiting to sync. */
export function SyncStatusBar() {
  const styles = getStyles();
  const { online, pendingCount, failedCount, syncing } = useOutbox();
  const { status } = useSession();
  const navigation = useNavigation();
  // Before sign-in there is no queue to show (and no sync screen to open).
  if (status !== 'signedIn') return null;
  if (online && pendingCount === 0 && failedCount === 0) return null;
  let text: string;
  let tone: string = colors.warningSoft;
  if (failedCount > 0) {
    text = `${failedCount} record${failedCount > 1 ? 's' : ''} could not be saved. Tap to review.`;
    tone = colors.dangerSoft;
  } else if (!online) {
    text = pendingCount
      ? `Offline · ${pendingCount} record${pendingCount > 1 ? 's' : ''} waiting to sync`
      : 'Offline · showing saved data';
  } else {
    text = syncing ? `Syncing ${pendingCount} record${pendingCount > 1 ? 's' : ''}…` : `${pendingCount} waiting to sync`;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      onPress={() => navigation.navigate('SyncQueue')}
      style={[styles.syncBar, { backgroundColor: tone }]}
    >
      <AppText variant="caption" color={colors.ink} style={{ fontWeight: '600' }}>
        {text}
      </AppText>
    </Pressable>
  );
}

export function CachedNotice({ fromCache, savedAt }: { fromCache?: boolean; savedAt?: number }) {
  const styles = getStyles();
  if (!fromCache || !savedAt) return null;
  return (
    <View style={styles.cached} accessibilityRole="text">
      <AppText variant="caption" color={colors.warning}>
        Saved copy from {formatDateTime(new Date(savedAt).toISOString())}. Figures may have changed.
      </AppText>
    </View>
  );
}

const getStyles = themedStyles((c) =>
  StyleSheet.create({
  root: { flex: 1, backgroundColor: c.canvas },
  padded: { padding: space.lg },
  footer: {
    padding: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    backgroundColor: c.surface,
  },
  syncBar: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  cached: {
    backgroundColor: c.warningSoft,
    borderRadius: 8,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginBottom: space.md,
  },
  }),
);
