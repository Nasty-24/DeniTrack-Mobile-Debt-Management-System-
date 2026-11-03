import type { ApiErrorBody, TokenResponse } from '../types/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** No response at all: offline, DNS failure, timeout. Safe to retry later. */
  get isNetwork(): boolean {
    return this.status === 0;
  }

  /** Worth retrying automatically (server or connectivity trouble, not a rejected request). */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const d of this.details as { field?: string; message?: string }[]) {
      if (d.field && d.message) out[d.field] = d.message;
    }
    return out;
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStore {
  get(): Promise<Tokens | null>;
  set(tokens: Tokens): Promise<void>;
  clear(): Promise<void>;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  idempotencyKey?: string;
  auth?: boolean;
  /** Return the raw text body (CSV exports). */
  text?: boolean;
  /** Return the raw bytes (PDF exports). */
  binary?: boolean;
  signal?: AbortSignal;
}

export interface ApiClientConfig {
  /** A string, or a function so the server address can change at runtime. */
  baseUrl: string | (() => string);
  tokens: TokenStore;
  onSessionExpired?: () => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export function createApiClient(config: ApiClientConfig) {
  const doFetch = config.fetchImpl ?? fetch;
  const base = () => (typeof config.baseUrl === 'function' ? config.baseUrl() : config.baseUrl);
  const timeoutMs = config.timeoutMs ?? 20_000;
  let refreshing: Promise<boolean> | null = null;

  async function rawFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: init.signal ?? controller.signal });
    } catch {
      throw new ApiError('No connection to the server. Check your internet and try again.', 0, 'network_error');
    } finally {
      clearTimeout(timer);
    }
  }

  /** One refresh at a time; concurrent 401s wait for the same refresh. */
  function refresh(): Promise<boolean> {
    if (!refreshing) {
      refreshing = (async () => {
        const tokens = await config.tokens.get();
        if (!tokens) return false;
        const res = await rawFetch(`${base()}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: tokens.refreshToken }),
        });
        if (!res.ok) {
          if (res.status === 401) {
            await config.tokens.clear();
            config.onSessionExpired?.();
          }
          return false;
        }
        const body = (await res.json()) as TokenResponse;
        await config.tokens.set({ accessToken: body.access_token, refreshToken: body.refresh_token });
        return true;
      })().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function request<T>(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (opts.auth !== false) {
      const tokens = await config.tokens.get();
      if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
    }
    const res = await rawFetch(`${base()}${path}${buildQuery(opts.query)}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });

    if (res.status === 401 && opts.auth !== false && !retried) {
      if (await refresh()) return request<T>(method, path, opts, true);
    }
    if (res.status === 204) return undefined as T;
    if (!res.ok) {
      let body: ApiErrorBody | null = null;
      try {
        body = (await res.json()) as ApiErrorBody;
      } catch {
        body = null;
      }
      const err = body?.error;
      throw new ApiError(
        err?.message ?? `Request failed (${res.status})`,
        res.status,
        err?.code ?? `http_${res.status}`,
        err?.details ?? null,
      );
    }
    if (opts.binary) return new Uint8Array(await res.arrayBuffer()) as T;
    return (opts.text ? await res.text() : await res.json()) as T;
  }

  return {
    get baseUrl() {
      return base();
    },
    request,
    get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
    post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body }),
    patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body }),
    put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
