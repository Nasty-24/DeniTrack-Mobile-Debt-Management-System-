import * as SecureStore from 'expo-secure-store';
import * as SystemUI from 'expo-system-ui';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import { applyPalette, darkColors, lightColors } from './tokens';

export type ThemePreference = 'system' | 'light' | 'dark';
export type Scheme = 'light' | 'dark';

const PREF_KEY = 'denitrack.theme';

export function resolveScheme(pref: ThemePreference, system: string | null | undefined): Scheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return system === 'dark' ? 'dark' : 'light';
}

interface ThemeValue {
  preference: ThemePreference;
  scheme: Scheme;
  setPreference: (p: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeValue>({ preference: 'system', scheme: 'light', setPreference: () => undefined });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setPref] = useState<ThemePreference>('system');

  useEffect(() => {
    SecureStore.getItemAsync(PREF_KEY)
      .then((v) => {
        if (v === 'light' || v === 'dark' || v === 'system') setPref(v);
      })
      .catch(() => undefined);
  }, []);

  const scheme = resolveScheme(preference, system);
  // Swap the shared palette before anything below renders with it.
  applyPalette(scheme === 'dark' ? darkColors : lightColors);

  useEffect(() => {
    // The native window background shows behind the keyboard and during transitions.
    SystemUI.setBackgroundColorAsync(scheme === 'dark' ? darkColors.canvas : lightColors.canvas).catch(() => undefined);
  }, [scheme]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPref(p);
    SecureStore.setItemAsync(PREF_KEY, p).catch(() => undefined);
  }, []);

  const value = useMemo(() => ({ preference, scheme, setPreference }), [preference, scheme, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}
