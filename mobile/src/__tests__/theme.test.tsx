import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { resolveScheme } from '../theme/ThemeProvider';
import { applyPalette, colors, darkColors, lightColors, themedStyles, type Palette } from '../theme/tokens';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [text, background, minimum ratio]: 4.5 for body text (WCAG AA), 3 for large/UI text.
const PAIRS: [keyof Palette, keyof Palette, number][] = [
  ['ink', 'canvas', 4.5],
  ['ink', 'surface', 4.5],
  ['inkMuted', 'canvas', 4.5],
  ['inkMuted', 'surface', 4.5],
  ['onBrand', 'brand', 4.5],
  ['onBrand', 'heroStart', 4.5], // white text on the dashboard gradient, deep end
  ['onBrand', 'heroEnd', 4.5], // ... and light end
  ['brandText', 'canvas', 4.5],
  ['brandText', 'surface', 4.5],
  ['success', 'successSoft', 4.5],
  ['warning', 'warningSoft', 4.5],
  ['danger', 'dangerSoft', 4.5],
  ['info', 'infoSoft', 4.5],
  ['danger', 'surface', 4.5],
  ['success', 'surface', 3],
  ['warning', 'canvas', 3],
  ['brand', 'surface', 3],
];

describe.each([
  ['light', lightColors],
  ['dark', darkColors],
])('%s palette', (_name, palette) => {
  it.each(PAIRS)('%s on %s is readable', (fg, bg, min) => {
    expect(contrast(palette[fg], palette[bg])).toBeGreaterThanOrEqual(min);
  });

  it('defines every token', () => {
    expect(Object.keys(palette).sort()).toEqual(Object.keys(lightColors).sort());
  });
});

describe('theme selection', () => {
  it('follows the phone unless the person chose a theme', () => {
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', null)).toBe('light');
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
  });

  it('swaps the live palette and rebuilds themed styles', async () => {
    const getStyles = themedStyles((c) => ({ box: { backgroundColor: c.canvas } }));
    applyPalette(lightColors);
    expect(getStyles().box.backgroundColor).toBe(lightColors.canvas);
    applyPalette(darkColors);
    expect(colors.canvas).toBe(darkColors.canvas);
    expect(getStyles().box.backgroundColor).toBe(darkColors.canvas);
    await render(<Text style={{ color: colors.ink }}>hello</Text>);
    expect(screen.getByText('hello').props.style).toEqual({ color: darkColors.ink });
    applyPalette(lightColors);
  });
});
