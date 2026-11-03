/**
 * Offline outbox. Supported offline operations are queued locally and replayed when
 * connectivity returns. Guarantees:
 *
 *  - Each operation carries a client-generated id that is sent both as the
 *    Idempotency-Key header and as `client_reference`, so a replay can never create a
 *    second customer, debt or payment on the server.
 *  - Operations are replayed in the order they were created. A connectivity or server
 *    error stops the run and keeps everything queued for a later retry.
 *  - A rejection by the server (validation, overpayment, conflict, permission) is never
 *    silently discarded: the operation is marked `failed` with the server's reason and
 *    stays visible until the user retries or dismisses it.
 *  - Customers created offline get a temporary `local:<id>` reference. Later queued
 *    operations that point at it are rewritten to the real server id once it exists.
 *  - Nothing in the outbox is ever shown as a server-confirmed payment.
 */
import { ApiError, type ApiClient } from './apiClient';

export type OutboxKind = 'customer.create' | 'debt.create' | 'payment.create';
export type OutboxStatus = 'pending' | 'failed';

export interface OutboxOp {
  id: string;
  businessId: string;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  summary: string; // shown in the UI, e.g. "Payment KSh 500.00 – Achieng"
  createdAt: number;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number;
}

export interface OutboxStore {
  all(businessId: string): Promise<OutboxOp[]>;
  put(op: OutboxOp): Promise<void>;
  remove(id: string): Promise<void>;
  getMapping(localId: string): Promise<string | null>;
  setMapping(localId: string, serverId: string): Promise<void>;
}

export const LOCAL_PREFIX = 'local:';
const PATHS: Record<OutboxKind, string> = {
  'customer.create': '/customers',
  'debt.create': '/debts',
  'payment.create': '/payments',
};
const MAX_BACKOFF_MS = 15 * 60 * 1000;

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.max(0, attempts - 1));
}

export function newOp(
  id: string,
  businessId: string,
  kind: OutboxKind,
  payload: Record<string, unknown>,
  summary: string,
  now: number = Date.now(),
): OutboxOp {
  return {
    id,
    businessId,
    kind,
    payload: { ...payload, client_reference: id },
    summary,
    createdAt: now,
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextAttemptAt: now,
  };
}

async function resolveRefs(store: OutboxStore, payload: Record<string, unknown>): Promise<Record<string, unknown> | string> {
  const out = { ...payload };
  const cid = out.customer_id;
  if (typeof cid === 'string' && cid.startsWith(LOCAL_PREFIX)) {
    const serverId = await store.getMapping(cid);
    if (!serverId) return cid;
    out.customer_id = serverId;
  }
  return out;
}

export interface FlushResult {
  sent: number;
  failed: number;
  remaining: number;
  stoppedOffline: boolean;
}

export async function flushOutbox(
  store: OutboxStore,
  api: ApiClient,
  businessId: string,
  now: number = Date.now(),
): Promise<FlushResult> {
  const ops = (await store.all(businessId)).sort((a, b) => a.createdAt - b.createdAt);
  const result: FlushResult = { sent: 0, failed: 0, remaining: 0, stoppedOffline: false };
  const failedLocalRefs = new Set(ops.filter((o) => o.status === 'failed').map((o) => `${LOCAL_PREFIX}${o.id}`));

  for (const op of ops) {
    if (op.status === 'failed') continue;
    if (result.stoppedOffline || op.nextAttemptAt > now) {
      result.remaining += 1;
      continue;
    }
    const resolved = await resolveRefs(store, op.payload);
    if (typeof resolved === 'string') {
      if (failedLocalRefs.has(resolved)) {
        await store.put({ ...op, status: 'failed', lastError: 'The customer for this record could not be saved.' });
        result.failed += 1;
      } else {
        result.remaining += 1; // its customer is still queued ahead of it
      }
      continue;
    }
    try {
      const body = await api.post<{ id: string }>(
        `/api/v1/businesses/${businessId}${PATHS[op.kind]}`,
        resolved,
        { idempotencyKey: op.id },
      );
      if (op.kind === 'customer.create') await store.setMapping(`${LOCAL_PREFIX}${op.id}`, body.id);
      await store.remove(op.id);
      result.sent += 1;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(String(e), 0, 'unknown');
      if (err.isTransient) {
        const attempts = op.attempts + 1;
        await store.put({ ...op, attempts, lastError: err.message, nextAttemptAt: now + backoffMs(attempts) });
        result.remaining += 1;
        if (err.isNetwork) result.stoppedOffline = true;
      } else {
        await store.put({ ...op, status: 'failed', attempts: op.attempts + 1, lastError: err.message });
        failedLocalRefs.add(`${LOCAL_PREFIX}${op.id}`);
        result.failed += 1;
      }
    }
  }
  return result;
}

/** Put a failed operation back in the queue after the user has reviewed it. */
export async function retryOp(store: OutboxStore, op: OutboxOp, now: number = Date.now()): Promise<void> {
  await store.put({ ...op, status: 'pending', lastError: null, nextAttemptAt: now });
}

export class MemoryOutboxStore implements OutboxStore {
  ops = new Map<string, OutboxOp>();
  mappings = new Map<string, string>();
  async all(businessId: string) {
    return [...this.ops.values()].filter((o) => o.businessId === businessId);
  }
  async put(op: OutboxOp) {
    this.ops.set(op.id, op);
  }
  async remove(id: string) {
    this.ops.delete(id);
  }
  async getMapping(localId: string) {
    return this.mappings.get(localId) ?? null;
  }
  async setMapping(localId: string, serverId: string) {
    this.mappings.set(localId, serverId);
  }
}
