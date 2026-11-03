import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { BrandSplash } from './src/components/BrandSplash';
import { OutboxProvider } from './src/hooks/useOutbox';
import { SessionProvider, useSession } from './src/hooks/useSession';
import { RootNavigator } from './src/navigation/RootNavigator';
import { ApiError } from './src/services/apiClient';
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

/** Shows the branded launch screen until the session has been restored. */
function Launch() {
  const { status } = useSession();
  const { scheme } = useTheme();
  const [splashDone, setSplashDone] = useState(false);
  const done = useCallback(() => setSplashDone(true), []);
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <RootNavigator />
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
