import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { getMeta, setMeta, wipeLocalData } from '../database/localDb';
import { api, loadSavedApiUrl, onSessionExpired } from '../services/api';
import { ApiError } from '../services/apiClient';
import { getSelectedBusiness, secureTokenStore, setSelectedBusiness } from '../storage/secure';
import type { Membership, Role, TokenResponse, User } from '../types/api';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface SessionState {
  status: Status;
  user: User | null;
  memberships: Membership[];
  businessId: string | null;
}

interface SessionValue extends SessionState {
  role: Role | null;
  business: Membership | null;
  isManager: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  register: (body: Record<string, unknown>) => Promise<void>;
  signOut: (opts?: { everywhere?: boolean }) => Promise<void>;
  selectBusiness: (id: string) => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const PROFILE_KEY = 'profile';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading', user: null, memberships: [], businessId: null });

  const applyProfile = useCallback(async (user: User, memberships: Membership[]) => {
    const saved = await getSelectedBusiness();
    const businessId = memberships.find((m) => m.business_id === saved)?.business_id ?? memberships[0]?.business_id ?? null;
    await setSelectedBusiness(businessId);
    await setMeta(PROFILE_KEY, JSON.stringify({ user, memberships }));
    setState({ status: 'signedIn', user, memberships, businessId });
  }, []);

  const refreshProfile = useCallback(async () => {
    const [user, memberships] = await Promise.all([
      api.get<User>('/api/v1/auth/me'),
      api.get<Membership[]>('/api/v1/auth/memberships'),
    ]);
    await applyProfile(user, memberships);
  }, [applyProfile]);

  const clearLocal = useCallback(async () => {
    await secureTokenStore.clear();
    await setSelectedBusiness(null);
    await wipeLocalData();
    setState({ status: 'signedOut', user: null, memberships: [], businessId: null });
  }, []);

  useEffect(() => {
    (async () => {
      await loadSavedApiUrl().catch(() => undefined);
      const tokens = await secureTokenStore.get();
      if (!tokens) {
        setState((s) => ({ ...s, status: 'signedOut' }));
        return;
      }
      try {
        await refreshProfile();
      } catch (e) {
        if (e instanceof ApiError && e.isNetwork) {
          // Offline start: continue with the last known profile; the server re-checks on reconnect.
          const cached = await getMeta(PROFILE_KEY);
          if (cached) {
            const { user, memberships } = JSON.parse(cached) as { user: User; memberships: Membership[] };
            const businessId = (await getSelectedBusiness()) ?? memberships[0]?.business_id ?? null;
            setState({ status: 'signedIn', user, memberships, businessId });
            return;
          }
        }
        await clearLocal();
      }
    })();
  }, [refreshProfile, clearLocal]);

  useEffect(() => onSessionExpired(() => void clearLocal()), [clearLocal]);

  const acceptTokens = useCallback(
    async (t: TokenResponse) => {
      await secureTokenStore.set({ accessToken: t.access_token, refreshToken: t.refresh_token });
      await applyProfile(t.user, t.memberships);
    },
    [applyProfile],
  );

  const value = useMemo<SessionValue>(() => {
    const business = state.memberships.find((m) => m.business_id === state.businessId) ?? null;
    return {
      ...state,
      business,
      role: business?.role ?? null,
      isManager: business?.role === 'owner' || business?.role === 'admin',
      signIn: async (email, password) =>
        acceptTokens(await api.post<TokenResponse>('/api/v1/auth/login', { email, password }, { auth: false })),
      register: async (body) => acceptTokens(await api.post<TokenResponse>('/api/v1/auth/register', body, { auth: false })),
      signOut: async (opts) => {
        try {
          await api.post(opts?.everywhere ? '/api/v1/auth/logout-all' : '/api/v1/auth/logout');
        } catch {
          // Signing out locally must work offline too; the refresh token simply expires.
        }
        await clearLocal();
      },
      selectBusiness: async (id) => {
        await setSelectedBusiness(id);
        setState((s) => ({ ...s, businessId: id }));
      },
      refreshProfile,
    };
  }, [state, acceptTokens, clearLocal, refreshProfile]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

/** For screens that only render when signed in with a business selected. */
export function useBusinessId(): string {
  const { businessId } = useSession();
  if (!businessId) throw new Error('No business selected');
  return businessId;
}
