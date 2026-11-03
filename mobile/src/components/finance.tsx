import { StyleSheet, View } from 'react-native';

import type { DebtStatus, PaymentMethod, VerificationStatus } from '../types/api';
import { amountLabel, formatKES } from '../utils/money';
import { colors, radius, space, themedStyles, type TypeVariant } from '../theme/tokens';
import { AppText } from './ui';

export function MoneyText({
  amount,
  variant = 'bodyStrong',
  color = colors.ink,
  compact,
}: {
  amount: string;
  variant?: TypeVariant;
  color?: string;
  compact?: boolean;
}) {
  return (
    <AppText variant={variant} color={color} tabular accessibilityLabel={amountLabel(amount)}>
      {formatKES(amount, { compact })}
    </AppText>
  );
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

const toneColors = themedStyles(
  (c): Record<Tone, [string, string]> => ({
    success: [c.successSoft, c.success],
    warning: [c.warningSoft, c.warning],
    danger: [c.dangerSoft, c.danger],
    info: [c.infoSoft, c.info],
    neutral: [c.surfaceSunken, c.inkMuted],
  }),
);

export function Badge({ label, tone }: { label: string; tone: Tone }) {
  const styles = getStyles();
  const [bg, fg] = toneColors()[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <AppText variant="caption" color={fg} style={{ fontWeight: '600' }}>
        {label}
      </AppText>
    </View>
  );
}

export const DEBT_STATUS: Record<DebtStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'neutral' },
  partially_paid: { label: 'Partly paid', tone: 'info' },
  paid: { label: 'Paid', tone: 'success' },
  overdue: { label: 'Overdue', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  disputed: { label: 'Disputed', tone: 'warning' },
};

export function DebtStatusBadge({ status, dueSoon }: { status: DebtStatus; dueSoon?: boolean }) {
  if (dueSoon && (status === 'open' || status === 'partially_paid')) return <Badge label="Due soon" tone="warning" />;
  const s = DEBT_STATUS[status];
  return <Badge label={s.label} tone={s.tone} />;
}

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  mpesa: 'M-Pesa',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  other: 'Other',
};

export function VerificationBadge({ status, reversed }: { status: VerificationStatus; reversed?: boolean }) {
  if (reversed) return <Badge label="Reversed" tone="danger" />;
  if (status === 'pending') return <Badge label="Awaiting verification" tone="warning" />;
  if (status === 'rejected') return <Badge label="Rejected" tone="danger" />;
  if (status === 'verified') return <Badge label="Verified" tone="success" />;
  return <Badge label="Received" tone="success" />;
}

export function StatTile({
  label,
  amount,
  tone = 'neutral',
  footnote,
}: {
  label: string;
  amount: string;
  tone?: Tone;
  footnote?: string;
}) {
  const styles = getStyles();
  const accent = tone === 'neutral' ? colors.ink : toneColors()[tone][1];
  return (
    <View style={styles.tile} accessible accessibilityLabel={`${label}: ${amountLabel(amount)}${footnote ? `. ${footnote}` : ''}`}>
      <AppText variant="caption" color={colors.inkMuted}>
        {label}
      </AppText>
      <AppText variant="heading" color={accent} tabular numberOfLines={1} adjustsFontSizeToFit>
        {formatKES(amount, { compact: true })}
      </AppText>
      {footnote ? (
        <AppText variant="caption" color={colors.inkMuted} numberOfLines={1}>
          {footnote}
        </AppText>
      ) : null}
    </View>
  );
}

/** Thin proportion bar: paid vs outstanding. Purely informational, with a text label alongside. */
export function ProgressBar({ fraction, tone = 'success' }: { fraction: number; tone?: Tone }) {
  const styles = getStyles();
  const clamped = Math.max(0, Math.min(1, fraction));
  return (
    <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.fill, { width: `${clamped * 100}%`, backgroundColor: toneColors()[tone][1] }]} />
    </View>
  );
}

const getStyles = themedStyles((c) =>
  StyleSheet.create({
  badge: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, alignSelf: 'flex-start' },
  tile: {
    flex: 1,
    minWidth: 140,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    padding: space.lg,
    gap: space.xs,
  },
  track: { height: 6, borderRadius: 3, backgroundColor: c.surfaceSunken, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  }),
);
