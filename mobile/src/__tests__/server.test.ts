import * as SecureStore from 'expo-secure-store';

import { DEFAULT_API_URL, getApiUrl, loadSavedApiUrl, normalizeServerUrl, setApiUrl } from '../services/api';

const ok = (body: unknown, status = 200) =>
  jest.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

describe('server address', () => {
  it.each([
    ['192.168.100.3:8000', 'http://192.168.100.3:8000'],
    [' https://api.example.co.ke/ ', 'https://api.example.co.ke'],
    ['HTTP://10.0.2.2:8000', 'http://10.0.2.2:8000'],
  ])('normalises %p', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each(['', '   ', 'https://api.example.co.ke/some/path', 'http://x.test/?q=1', 'not a url at all'])('rejects %p', (bad) => {
    expect(normalizeServerUrl(bad)).toBeNull();
  });

  it('defaults to the build-time address', () => {
    expect(getApiUrl()).toBe(DEFAULT_API_URL);
  });

  it('saves an address only after it answers as a DeniTrack server', async () => {
    await expect(setApiUrl('192.168.100.3:8000', ok({ hello: 'world' }))).rejects.toThrow(/Could not reach a DeniTrack server/);
    expect(getApiUrl()).toBe(DEFAULT_API_URL);

    const fetchImpl = ok({ status: 'ok', database: true });
    await expect(setApiUrl('192.168.100.3:8000', fetchImpl)).resolves.toBe('http://192.168.100.3:8000');
    expect((fetchImpl as unknown as jest.Mock).mock.calls[0][0]).toBe('http://192.168.100.3:8000/api/v1/health');
    expect(getApiUrl()).toBe('http://192.168.100.3:8000');
    expect(await SecureStore.getItemAsync('denitrack.server')).toBe('http://192.168.100.3:8000');
  });

  it('restores the saved address on start-up', async () => {
    await SecureStore.setItemAsync('denitrack.server', 'https://api.example.co.ke');
    await loadSavedApiUrl();
    expect(getApiUrl()).toBe('https://api.example.co.ke');
  });

  it('rejects unreachable servers', async () => {
    const down = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(setApiUrl('10.9.9.9:8000', down)).rejects.toThrow(/Could not reach/);
  });
});
