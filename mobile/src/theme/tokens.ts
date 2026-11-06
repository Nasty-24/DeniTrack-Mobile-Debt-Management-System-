/**
 * DeniTrack design tokens, derived from the app icon: its light-blue background (#E6F4FD)
 * and its chevron, which shades from deep blue (#0B6FCE) to light blue (#7BBEFC).
 * Semantic accents keep their meaning: green (paid), amber (due soon), red (overdue).
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
  brand: string; // primary actions (filled)
  brandPressed: string;
  brandText: string; // brand-coloured text: links, ghost buttons, selected items
  onBrand: string; // text and icons on brand and on the hero gradient
  heroStart: string; // icon gradient, deep end
  heroEnd: string; // icon gradient, light end (kept dark enough for white text)
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
  canvas: '#E6F4FD', // the icon's background
  surface: '#FFFFFF',
  surfaceSunken: '#D9EBFA',
  ink: '#0C1B2D',
  inkMuted: '#45586E',
  inkFaint: '#8296AD',
  border: '#CFE2F3',
  borderStrong: '#A9C7E3',
  brand: '#0B6FCE', // the icon's deep blue
  brandPressed: '#095CAB',
  brandText: '#0A63B8',
  onBrand: '#FFFFFF',
  heroStart: '#0A57AE',
  heroEnd: '#1675D6',
  success: '#1F7A4D',
  successSoft: '#E5F2EA',
  warning: '#8A5A00',
  warningSoft: '#FBF0D9',
  danger: '#B42318',
  dangerSoft: '#FCE9E7',
  info: '#0A63B8',
  infoSoft: '#DCEEFD',
  focus: '#0B6FCE',
  thumb: '#FFFFFF',
  overlay: 'rgba(12,27,45,0.4)',
};

/** Deep navy surfaces in the icon's blue family; accents lightened for dark backgrounds. */
export const darkColors: Palette = {
  canvas: '#0A1422',
  surface: '#111E30',
  surfaceSunken: '#18283E',
  ink: '#E6EEF8',
  inkMuted: '#A0B2C8',
  inkFaint: '#71849C',
  border: '#213550',
  borderStrong: '#34507A',
  brand: '#1E6FD0',
  brandPressed: '#195DB0',
  brandText: '#7DB8F6',
  onBrand: '#FFFFFF',
  heroStart: '#0C3F80',
  heroEnd: '#1663C4',
  success: '#5CC08A',
  successSoft: '#13301F',
  warning: '#E3B65A',
  warningSoft: '#33290F',
  danger: '#F2796B',
  dangerSoft: '#3A1B17',
  info: '#7DB8F6',
  infoSoft: '#132B47',
  focus: '#7DB8F6',
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
