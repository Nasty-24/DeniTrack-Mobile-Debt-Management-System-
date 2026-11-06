/* Native modules replaced with in-memory fakes so logic and UI can be tested in Node.
 * jest.mock factories are hoisted above imports, so they must use require(). */
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('@react-native-community/netinfo', () => require('@react-native-community/netinfo/jest/netinfo-mock.js'));
jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
jest.mock('expo-system-ui', () => ({ setBackgroundColorAsync: jest.fn(async () => undefined) }));

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

jest.mock('expo-crypto', () => ({
  randomUUID: () => require('crypto').randomUUID(),
  getRandomBytes: (n: number) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256)),
}));

jest.mock('expo-print', () => ({ printToFileAsync: jest.fn(async () => ({ uri: 'file:///receipt.pdf' })) }));
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }));
jest.mock('expo-file-system', () => ({ File: jest.fn(), Paths: { cache: 'file:///cache' } }));

jest.mock('./src/database/localDb', () => {
  const cache = new Map<string, unknown>();
  const meta = new Map<string, string>();
  return {
    encryption: 'unavailable',
    getDb: jest.fn(),
    sqliteOutboxStore: {
      all: jest.fn(async () => []),
      put: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
      getMapping: jest.fn(async () => null),
      setMapping: jest.fn(async () => undefined),
    },
    readCache: jest.fn(async (k: string) => (cache.has(k) ? { body: cache.get(k), savedAt: 1_700_000_000_000 } : null)),
    writeCache: jest.fn(async (k: string, _b: string, body: unknown) => void cache.set(k, body)),
    getMeta: jest.fn(async (k: string) => meta.get(k) ?? null),
    setMeta: jest.fn(async (k: string, v: string) => void meta.set(k, v)),
    wipeLocalData: jest.fn(async () => {
      cache.clear();
      meta.clear();
    }),
  };
});

