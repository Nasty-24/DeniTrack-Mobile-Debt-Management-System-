import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

import type { TokenStore, Tokens } from '../services/apiClient';

const TOKENS_KEY = 'denitrack.tokens';
const DB_KEY = 'denitrack.dbkey';
const BUSINESS_KEY = 'denitrack.business';

/** Tokens live only in the platform keystore (Android Keystore / iOS Keychain). */
export const secureTokenStore: TokenStore = {
  async get() {
    const raw = await SecureStore.getItemAsync(TOKENS_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Tokens;
    } catch {
      await SecureStore.deleteItemAsync(TOKENS_KEY);
      return null;
    }
  },
  async set(tokens) {
    await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(tokens), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async clear() {
    await SecureStore.deleteItemAsync(TOKENS_KEY);
  },
};

/** Random 256-bit key for the local SQLCipher database, generated once per install. */
export async function getDatabaseKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DB_KEY);
  if (existing) return existing;
  const bytes = Crypto.getRandomBytes(32);
  const key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await SecureStore.setItemAsync(DB_KEY, key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  return key;
}

export async function getSelectedBusiness(): Promise<string | null> {
  return SecureStore.getItemAsync(BUSINESS_KEY);
}

export async function setSelectedBusiness(id: string | null): Promise<void> {
  if (id) await SecureStore.setItemAsync(BUSINESS_KEY, id);
  else await SecureStore.deleteItemAsync(BUSINESS_KEY);
}
