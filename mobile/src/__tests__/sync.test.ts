/** Offline queue and API client behaviour: retries, idempotency, conflicts, refresh. */
import { ApiError, createApiClient, type TokenStore } from '../services/apiClient';
import { backoffMs, flushOutbox, LOCAL_PREFIX, MemoryOutboxStore, newOp, retryOp, type OutboxOp } from '../services/outbox';

type Handler = (url: string, init: RequestInit) => { status: number; body?: unknown } | 'offline';

function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> | null }[] = [];
  const fn = jest.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : null });
    const r = handler(url, init);
    if (r === 'offline') throw new TypeError('Network request failed');
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function memoryTokens(initial = { accessToken: 'a1', refreshToken: 'r1' }): TokenStore & { value: typeof initial | null } {
  const t = {
    value: initial as typeof initial | null,
    get: async () => t.value,
    set: async (v: typeof initial) => {
      t.value = v;
    },
    clear: async () => {
      t.value = null;
    },
  };
  return t;
}

const BIZ = 'biz-1';
const T0 = 1_800_000_000_000;

function setup(handler: Handler) {
  const f = fakeFetch(handler);
  const api = createApiClient({ baseUrl: 'https://api.test', tokens: memoryTokens(), fetchImpl: f.fn });
  return { api, calls: f.calls, store: new MemoryOutboxStore() };
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe('offline outbox', () => {
  it('replays a queued payment with the same idempotency key and client_reference', async () => {
    const { api, calls, store } = setup(() => ({ status: 201, body: { id: 'p1' } }));
    await store.put(newOp('op-1', BIZ, 'payment.create', { customer_id: 'c1', amount: '200.00', method: 'cash' }, 'Payment', T0));
    const r = await flushOutbox(store, api, BIZ, T0);
    expect(r).toEqual({ sent: 1, failed: 0, remaining: 0, stoppedOffline: false });
    expect(calls[0].url).toBe('https://api.test/api/v1/businesses/biz-1/payments');
    expect(headersOf(calls[0].init)['Idempotency-Key']).toBe('op-1');
    expect(calls[0].body).toMatchObject({ amount: '200.00', client_reference: 'op-1' });
    expect(await store.all(BIZ)).toEqual([]);
  });

  it('keeps everything queued while offline and stops trying further items', async () => {
    const { api, calls, store } = setup(() => 'offline');
    await store.put(newOp('a', BIZ, 'payment.create', { customer_id: 'c1', amount: '1.00' }, 'A', T0));
    await store.put(newOp('b', BIZ, 'payment.create', { customer_id: 'c1', amount: '2.00' }, 'B', T0 + 1));
    const r = await flushOutbox(store, api, BIZ, T0);
    expect(r).toMatchObject({ sent: 0, failed: 0, remaining: 2, stoppedOffline: true });
    expect(calls).toHaveLength(1);
    const a = (await store.all(BIZ)).find((o) => o.id === 'a') as OutboxOp;
    expect(a.status).toBe('pending');
    expect(a.attempts).toBe(1);
    expect(a.nextAttemptAt).toBe(T0 + backoffMs(1));
  });

  it('does not retry before the backoff has elapsed', async () => {
    const { api, calls, store } = setup(() => ({ status: 201, body: { id: 'x' } }));
    await store.put({ ...newOp('a', BIZ, 'payment.create', {}, 'A', T0), attempts: 2, nextAttemptAt: T0 + 60_000 });
    expect((await flushOutbox(store, api, BIZ, T0)).remaining).toBe(1);
    expect(calls).toHaveLength(0);
    expect((await flushOutbox(store, api, BIZ, T0 + 60_000)).sent).toBe(1);
  });

  it('never silently drops a payment the server rejects', async () => {
    const { api, store } = setup(() => ({
      status: 422,
      body: { error: { code: 'overpayment', message: 'Payment exceeds the outstanding balance by KSh 100.00', details: null } },
    }));
    await store.put(newOp('a', BIZ, 'payment.create', { customer_id: 'c1', amount: '600.00' }, 'Payment KSh 600', T0));
    const r = await flushOutbox(store, api, BIZ, T0);
    expect(r.failed).toBe(1);
    const [op] = await store.all(BIZ);
    expect(op.status).toBe('failed');
    expect(op.lastError).toMatch(/exceeds the outstanding balance/);
    // a failed item is not retried automatically, only after the user chooses to
    expect((await flushOutbox(store, api, BIZ, T0 + 10 ** 9)).failed).toBe(0);
    await retryOp(store, op, T0);
    expect((await store.all(BIZ))[0].status).toBe('pending');
  });

  it('treats a replay the server already processed as success (no duplicate)', async () => {
    let n = 0;
    const { api, store } = setup(() => {
      n += 1;
      return { status: 201, body: { id: 'same-payment' } }; // server replays the stored response
    });
    await store.put(newOp('a', BIZ, 'payment.create', { customer_id: 'c1', amount: '5.00' }, 'P', T0));
    await flushOutbox(store, api, BIZ, T0);
    await store.put(newOp('a', BIZ, 'payment.create', { customer_id: 'c1', amount: '5.00' }, 'P', T0)); // e.g. crash before removal
    await flushOutbox(store, api, BIZ, T0);
    expect(n).toBe(2);
    expect(await store.all(BIZ)).toEqual([]);
  });

  it('resolves customers created offline before sending their debts', async () => {
    const { api, calls, store } = setup((url) =>
      url.endsWith('/customers') ? { status: 201, body: { id: 'server-cust' } } : { status: 201, body: { id: 'server-debt' } },
    );
    await store.put(newOp('cust-op', BIZ, 'customer.create', { name: 'Juma', phone: '+254712345678' }, 'C', T0));
    await store.put(newOp('debt-op', BIZ, 'debt.create', { customer_id: `${LOCAL_PREFIX}cust-op`, principal: '100.00' }, 'D', T0 + 1));
    const r = await flushOutbox(store, api, BIZ, T0 + 10);
    expect(r.sent).toBe(2);
    expect(calls[1].body?.customer_id).toBe('server-cust');
  });

  it('fails dependent records when their offline customer was rejected', async () => {
    const { api, store } = setup((url) =>
      url.endsWith('/customers')
        ? { status: 422, body: { error: { code: 'invalid_phone', message: 'Enter a valid phone number', details: null } } }
        : { status: 201, body: { id: 'x' } },
    );
    await store.put(newOp('cust-op', BIZ, 'customer.create', { name: 'Juma', phone: '123' }, 'C', T0));
    await store.put(newOp('debt-op', BIZ, 'debt.create', { customer_id: `${LOCAL_PREFIX}cust-op` }, 'D', T0 + 1));
    const r = await flushOutbox(store, api, BIZ, T0 + 10);
    expect(r.failed).toBe(2);
    const debt = (await store.all(BIZ)).find((o) => o.id === 'debt-op');
    expect(debt?.lastError).toMatch(/customer for this record could not be saved/);
  });

  it('retries server errors later instead of failing them', async () => {
    const { api, store } = setup(() => ({ status: 503, body: { error: { code: 'unavailable', message: 'Down', details: null } } }));
    await store.put(newOp('a', BIZ, 'payment.create', {}, 'A', T0));
    const r = await flushOutbox(store, api, BIZ, T0);
    expect(r).toMatchObject({ failed: 0, remaining: 1, stoppedOffline: false });
    expect((await store.all(BIZ))[0].status).toBe('pending');
  });

  it('only flushes the selected business', async () => {
    const { api, calls, store } = setup(() => ({ status: 201, body: { id: 'x' } }));
    await store.put(newOp('a', 'other-biz', 'payment.create', {}, 'A', T0));
    await flushOutbox(store, api, BIZ, T0);
    expect(calls).toHaveLength(0);
  });

  it('caps backoff at 15 minutes', () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(3)).toBe(20_000);
    expect(backoffMs(50)).toBe(15 * 60 * 1000);
  });
});

describe('api client', () => {
  it('turns transport failures into a network ApiError', async () => {
    const { api } = setup(() => 'offline');
    const e = (await api.get('/x').catch((err: unknown) => err)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.isNetwork).toBe(true);
    expect(e.isTransient).toBe(true);
  });

  it('parses structured errors and field details', async () => {
    const { api } = setup(() => ({
      status: 422,
      body: { error: { code: 'validation_error', message: 'Some fields are invalid', details: [{ field: 'amount', message: 'Too big' }] } },
    }));
    const e = (await api.post('/x', {}).catch((err: unknown) => err)) as ApiError;
    expect(e.status).toBe(422);
    expect(e.code).toBe('validation_error');
    expect(e.isTransient).toBe(false);
    expect(e.fieldErrors()).toEqual({ amount: 'Too big' });
  });

  it('refreshes an expired access token once, even for concurrent requests', async () => {
    const tokens = memoryTokens();
    let refreshes = 0;
    const f = fakeFetch((url, init) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes += 1;
        return { status: 200, body: { access_token: 'a2', refresh_token: 'r2', user: {}, memberships: [] } };
      }
      return headersOf(init).Authorization === 'Bearer a2' ? { status: 200, body: { ok: true } } : { status: 401, body: { error: { code: 'unauthorized', message: 'expired', details: null } } };
    });
    const api = createApiClient({ baseUrl: 'https://api.test', tokens, fetchImpl: f.fn });
    const results = await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
    expect(tokens.value).toEqual({ accessToken: 'a2', refreshToken: 'r2' });
  });

  it('ends the session when the refresh token is rejected', async () => {
    const tokens = memoryTokens();
    const expired = jest.fn();
    const f = fakeFetch(() => ({ status: 401, body: { error: { code: 'unauthorized', message: 'ended', details: null } } }));
    const api = createApiClient({ baseUrl: 'https://api.test', tokens, fetchImpl: f.fn, onSessionExpired: expired });
    await expect(api.get('/a')).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(tokens.value).toBeNull();
  });

  it('does not send credentials on unauthenticated calls', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const api = createApiClient({ baseUrl: 'https://api.test', tokens: memoryTokens(), fetchImpl: f.fn });
    await api.post('/api/v1/auth/login', { email: 'a', password: 'b' }, { auth: false });
    expect(headersOf(f.calls[0].init).Authorization).toBeUndefined();
  });
});
