import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { colors, radius, space, themedStyles, touchTarget, type as typeScale, type TypeVariant } from '../theme/tokens';

// --------------------------------------------------------------------------- text

interface AppTextProps extends TextProps {
  variant?: TypeVariant;
  color?: string;
  tabular?: boolean;
  align?: TextStyle['textAlign'];
}

export function AppText({ variant = 'body', color = colors.ink, tabular, align, style, ...rest }: AppTextProps) {
  return (
    <Text
      maxFontSizeMultiplier={1.6}
      style={[
        typeScale[variant],
        { color, textAlign: align },
        tabular && { fontVariant: ['tabular-nums'] },
        variant === 'label' && { textTransform: 'uppercase' },
        style,
      ]}
      {...rest}
    />
  );
}

// --------------------------------------------------------------------------- layout

export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const styles = getStyles();
  return <View style={[styles.card, padded && { padding: space.lg }, style]}>{children}</View>;
}

export function Divider({ inset = 0 }: { inset?: number }) {
  const styles = getStyles();
  return <View style={[styles.divider, { marginLeft: inset }]} />;
}

export function Row({ children, style, gap = space.sm }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  const styles = getStyles();
  return (
    <View style={styles.sectionHeader} accessibilityRole="header">
      <AppText variant="label" color={colors.inkMuted}>
        {title}
      </AppText>
      {action}
    </View>
  );
}

// --------------------------------------------------------------------------- buttons

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  title: string;
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}

const buttonColors = themedStyles(
  (c): Record<ButtonVariant, { bg: string; pressed: string; fg: string; border: string }> => ({
    primary: { bg: c.brand, pressed: c.brandPressed, fg: c.onBrand, border: c.brand },
    secondary: { bg: c.surface, pressed: c.surfaceSunken, fg: c.ink, border: c.borderStrong },
    danger: { bg: c.surface, pressed: c.dangerSoft, fg: c.danger, border: c.danger },
    ghost: { bg: 'transparent', pressed: c.surfaceSunken, fg: c.brand, border: 'transparent' },
  }),
);

export function Button({ title, variant = 'primary', loading, disabled, icon, style, compact, ...rest }: ButtonProps) {
  const styles = getStyles();
  const c = buttonColors()[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: pressed ? c.pressed : c.bg, borderColor: c.border, opacity: inactive ? 0.55 : 1 },
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={c.fg} />
      ) : (
        <Row gap={space.sm}>
          {icon}
          <AppText variant="bodyStrong" color={c.fg}>
            {title}
          </AppText>
        </Row>
      )}
    </Pressable>
  );
}

// --------------------------------------------------------------------------- inputs

interface FieldProps extends TextInputProps {
  label: string;
  error?: string;
  hint?: string;
  prefix?: string;
}

export function TextField({ label, error, hint, prefix, style, editable = true, ...rest }: FieldProps) {
  const styles = getStyles();
  return (
    <View style={styles.field}>
      <AppText variant="caption" color={colors.inkMuted} style={styles.fieldLabel}>
        {label}
      </AppText>
      <View
        style={[
          styles.inputWrap,
          error ? { borderColor: colors.danger } : null,
          !editable && { backgroundColor: colors.surfaceSunken },
        ]}
      >
        {prefix ? (
          <AppText color={colors.inkMuted} style={styles.prefix}>
            {prefix}
          </AppText>
        ) : null}
        <TextInput
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          placeholderTextColor={colors.inkFaint}
          editable={editable}
          style={[styles.input, style]}
          maxFontSizeMultiplier={1.6}
          {...rest}
        />
      </View>
      {error ? (
        <AppText variant="caption" color={colors.danger} accessibilityLiveRegion="polite" style={styles.fieldNote}>
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="caption" color={colors.inkMuted} style={styles.fieldNote}>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

export interface Option<T extends string> {
  value: T;
  label: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const styles = getStyles();
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            style={[styles.segment, selected && styles.segmentSelected]}
          >
            <AppText variant="caption" color={selected ? colors.ink : colors.inkMuted} style={{ fontWeight: '600' }}>
              {o.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ChoiceChips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Option<T>[];
  value: T | undefined;
  onChange: (v: T) => void;
  label: string;
}) {
  const styles = getStyles();
  return (
    <View style={styles.field}>
      <AppText variant="caption" color={colors.inkMuted} style={styles.fieldLabel}>
        {label}
      </AppText>
      <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(o.value)}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              <AppText variant="caption" color={selected ? colors.onBrand : colors.ink} style={{ fontWeight: '600' }}>
                {o.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function ToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const styles = getStyles();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => onChange(!value)}
      style={styles.toggleRow}
    >
      <View style={{ flex: 1 }}>
        <AppText variant="bodyStrong">{label}</AppText>
        {description ? (
          <AppText variant="caption" color={colors.inkMuted}>
            {description}
          </AppText>
        ) : null}
      </View>
      <View style={[styles.track, value && { backgroundColor: colors.brand }]}>
        <View style={[styles.thumb, value && { alignSelf: 'flex-end' }]} />
      </View>
    </Pressable>
  );
}

// --------------------------------------------------------------------------- list rows

export function ListRow({
  title,
  subtitle,
  right,
  onPress,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const styles = getStyles();
  const content = (
    <>
      <View style={{ flex: 1, gap: space.xxs }}>
        <AppText variant="bodyStrong" numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" color={colors.inkMuted} numberOfLines={1}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {right ? <View style={{ alignItems: 'flex-end' }}>{right}</View> : null}
    </>
  );
  if (!onPress) return <View style={styles.listRow}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      style={({ pressed }) => [styles.listRow, pressed && { backgroundColor: colors.surfaceSunken }]}
    >
      {content}
    </Pressable>
  );
}

const getStyles = themedStyles((c) =>
  StyleSheet.create({
  card: {
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.xl,
    marginBottom: space.sm,
  },
  button: {
    minHeight: touchTarget,
    paddingHorizontal: space.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonCompact: { minHeight: 40, paddingHorizontal: space.lg },
  field: { marginBottom: space.lg },
  fieldLabel: { marginBottom: space.xs, fontWeight: '600' },
  fieldNote: { marginTop: space.xs },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: radius.md,
    backgroundColor: c.surface,
    paddingHorizontal: space.md,
  },
  prefix: { marginRight: space.xs },
  input: { flex: 1, fontSize: 16, color: c.ink, paddingVertical: space.sm },
  segmented: {
    flexDirection: 'row',
    backgroundColor: c.surfaceSunken,
    borderRadius: radius.md,
    padding: 3,
  },
  segment: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  segmentSelected: {
    backgroundColor: c.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: c.borderStrong,
    justifyContent: 'center',
    backgroundColor: c.surface,
  },
  chipSelected: { backgroundColor: c.brand, borderColor: c.brand },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touchTarget, paddingVertical: space.sm },
  track: { width: 46, height: 28, borderRadius: 14, backgroundColor: c.borderStrong, padding: 3, justifyContent: 'center' },
  thumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: c.thumb },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 64,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: c.surface,
  },
  }),
);
