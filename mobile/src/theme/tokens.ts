/**
 * DeniTrack design tokens. Warm neutral surfaces, dark ink, and three semantic
 * accents: green (paid / success), amber (due soon), red (overdue / critical).
 * Both palettes are checked for WCAG AA contrast in src/__tests__/theme.test.ts.
 */
export interface Palette {
  canvas: string; // app background
  surface: string; // cards, inputs, list rows
  surfaceSunken: string; // segmented controls, pressed rows
  ink: string; // primary text
  inkMuted: string; // secondary text
  inkFaint: string; // placeholders and disabled text only
  border: string;
  borderStrong: string;
  brand: string; // primary actions
  brandPressed: string;
  onBrand: string; // text and icons on brand
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;
  focus: string;
  thumb: string; // switch thumb
  overlay: string; // modal scrim
}

export const lightColors: Palette = {
  canvas: '#F6F4EF',
  surface: '#FFFFFF',
  surfaceSunken: '#EFECE5',
  ink: '#1B1E1C',
  inkMuted: '#5E625E',
  inkFaint: '#8A8D88',
  border: '#E2DED5',
  borderStrong: '#C9C4B8',
  brand: '#1F5F43',
  brandPressed: '#174A34',
  onBrand: '#FFFFFF',
  success: '#1F7A4D',
  successSoft: '#E5F2EA',
  warning: '#8A5A00',
  warningSoft: '#FBF0D9',
  danger: '#B42318',
  dangerSoft: '#FCE9E7',
  info: '#2F5D8A',
  infoSoft: '#E6EEF6',
  focus: '#2F5D8A',
  thumb: '#FFFFFF',
  overlay: 'rgba(0,0,0,0.35)',
};

/** Warm near-black surfaces; accents lightened so text stays readable on dark backgrounds. */
export const darkColors: Palette = {
  canvas: '#121513',
  surface: '#1B1F1C',
  surfaceSunken: '#252A26',
  ink: '#ECEDE9',
  inkMuted: '#A9AEA8',
  inkFaint: '#7C827C',
  border: '#2D332F',
  borderStrong: '#46504A',
  brand: '#2E7D57',
  brandPressed: '#256848',
  onBrand: '#FFFFFF',
  success: '#5CC08A',
  successSoft: '#16301F',
  warning: '#E3B65A',
  warningSoft: '#33290F',
  danger: '#F2796B',
  dangerSoft: '#3A1B17',
  info: '#86B7E6',
  infoSoft: '#172636',
  focus: '#86B7E6',
  thumb: '#FFFFFF',
  overlay: 'rgba(0,0,0,0.6)',
};

/**
 * The active palette. Every component reads colours from here; ThemeProvider swaps the
 * values in place and re-mounts the screens, so inline styles pick up the new theme.
 */
export const colors: Palette = { ...lightColors };
let paletteVersion = 0;

export function applyPalette(next: Palette): void {
  if (colors.canvas === next.canvas && colors.ink === next.ink) return;
  Object.assign(colors, next);
  paletteVersion += 1;
}

/**
 * For StyleSheets that use colours: built once per palette and reused, so static styles
 * follow the active theme. Call the returned function inside the component.
 */
export function themedStyles<T>(factory: (c: Palette) => T): () => T {
  let cached: { version: number; value: T } | null = null;
  return () => {
    if (!cached || cached.version !== paletteVersion) cached = { version: paletteVersion, value: factory(colors) };
    return cached.value;
  };
}

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

export const type = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: '700' as const, letterSpacing: -0.5 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const, letterSpacing: -0.2 },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' as const },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: '600' as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.4 },
} as const;

export type TypeVariant = keyof typeof type;

/** Minimum touch target, per platform accessibility guidance. */
export const touchTarget = 48;

export const theme = { colors, space, radius, type, touchTarget };
