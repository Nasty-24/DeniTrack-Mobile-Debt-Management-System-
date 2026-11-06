import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { BrandSplash } from './src/components/BrandSplash';
import { OutboxProvider } from './src/hooks/useOutbox';
import { SessionProvider, useSession } from './src/hooks/useSession';
import { RootNavigator } from './src/navigation/RootNavigator';
import { ApiError } from './src/services/apiClient';
import { shouldShowSplashOnResume } from './src/services/appLifecycle';
import { updateBackgroundTask } from './src/services/backgroundSync';
import { runPhoneTasks, smsAvailable } from './src/services/phoneSms';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Do not hammer the server for errors a retry cannot fix.
      retry: (count, error) => error instanceof ApiError && error.isTransient && !error.isNetwork && count < 2,
    },
    mutations: { retry: false },
  },
});

/**
 * On a phone switched on for it (Settings → This phone): records M-Pesa payments from SMS and
 * sends due reminder SMS when the app opens and every minute while it is open.
 */
function PhoneAutomation() {
  const { status, businessId, isManager } = useSession();
  const qc = useQueryClient();
  useEffect(() => {
    if (status !== 'signedIn' || !businessId || !isManager || !smsAvailable) return;
    let cancelled = false;
    const run = async () => {
      const s = await runPhoneTasks({ businessId, isManager });
      if (!cancelled && s && (s.recorded || s.needsReview || s.remindersSent)) {
        await qc.invalidateQueries({ queryKey: [businessId] });
      }
    };
    void updateBackgroundTask().catch(() => undefined);
    void run();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void run();
    }, 60_000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void run();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      sub.remove();
    };
  }, [status, businessId, isManager, qc]);
  return null;
}

/**
 * Shows the branded launch screen until the session has been restored, and again each time
 * the person returns to the app after leaving it (see services/appLifecycle.ts).
 */
function Launch() {
  const { status } = useSession();
  const { scheme } = useTheme();
  const [splashDone, setSplashDone] = useState(false);
  const done = useCallback(() => setSplashDone(true), []);

  useEffect(() => {
    let leftAt: number | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        leftAt = Date.now();
      } else if (state === 'active' && leftAt !== null) {
        const away = Date.now() - leftAt;
        leftAt = null;
        if (shouldShowSplashOnResume(away)) setSplashDone(false);
      }
    });
    return () => sub.remove();
  }, []);

  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <RootNavigator />
      <PhoneAutomation />
      {splashDone ? null : <BrandSplash ready={status !== 'loading'} onDone={done} />}
    </>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <KeyboardProvider>
          <QueryClientProvider client={queryClient}>
            <SessionProvider>
              <OutboxProvider>
                <Launch />
              </OutboxProvider>
            </SessionProvider>
          </QueryClientProvider>
        </KeyboardProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
