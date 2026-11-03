import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { secureTokenStore } from '../storage/secure';
import { createApiClient } from './apiClient';

/**
 * Server address. The build-time default comes from EXPO_PUBLIC_API_URL (see
 * mobile/.env.example); the person signing in can point the app at their own DeniTrack
 * server from the sign-in screen. Release builds whose default is https:// do not allow
 * cleartext traffic (app.config.js), so a plain-http address only works in test builds.
 */
export const DEFAULT_API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8000').replace(/\/$/, '');
const SERVER_KEY = 'denitrack.server';
let currentUrl = DEFAULT_API_URL;

export function getApiUrl(): string {
  return currentUrl;
}

/** Load a previously saved server address (call once at start-up). */
export async function loadSavedApiUrl(): Promise<void> {
  const saved = await SecureStore.getItemAsync(SERVER_KEY);
  if (saved) currentUrl = saved;
}

/** Accepts "192.168.1.20:8000", "https://api.example.co.ke/" etc.; returns null if unusable. */
export function normalizeServerUrl(input: string): string | null {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname || u.pathname.replace(/\/+$/, '') !== '' || u.search || u.hash) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Save a new server address after checking it answers as a DeniTrack server. */
export async function setApiUrl(input: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = normalizeServerUrl(input);
  if (!url) throw new Error('Enter a server address like 192.168.1.20:8000 or https://api.example.co.ke');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetchImpl(`${url}/api/v1/health`, { signal: controller.signal });
    const body = (await res.json()) as { status?: string; database?: boolean };
    if (!res.ok || body.database === undefined) throw new Error('not a DeniTrack server');
  } catch {
    throw new Error(`Could not reach a DeniTrack server at ${url}. Check the address and that the phone is on the same network.`);
  } finally {
    clearTimeout(timer);
  }
  await SecureStore.setItemAsync(SERVER_KEY, url);
  currentUrl = url;
  return url;
}

type Listener = () => void;
const sessionExpiredListeners = new Set<Listener>();

export function onSessionExpired(listener: Listener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

export const api = createApiClient({
  baseUrl: getApiUrl,
  tokens: secureTokenStore,
  onSessionExpired: () => sessionExpiredListeners.forEach((l) => l()),
});

/** RFC 4122 v4 UUID from a CSPRNG; used as Idempotency-Key and client_reference. */
export function newIdempotencyKey(): string {
  return Crypto.randomUUID();
}
