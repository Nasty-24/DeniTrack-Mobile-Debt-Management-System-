import NetInfo from '@react-native-community/netinfo';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { sqliteOutboxStore } from '../database/localDb';
import { api, newIdempotencyKey } from '../services/api';
import { ApiError } from '../services/apiClient';
import { flushOutbox, LOCAL_PREFIX, newOp, retryOp, type OutboxKind, type OutboxOp } from '../services/outbox';
import { bizPath } from './queries';
import { useSession } from './useSession';

interface OutboxValue {
  online: boolean;
  ops: OutboxOp[];
  pendingCount: number;
  failedCount: number;
  syncing: boolean;
  lastSyncAt: number | null;
  syncNow: () => Promise<void>;
  retry: (op: OutboxOp) => Promise<void>;
  discard: (op: OutboxOp) => Promise<void>;
  /**
   * Create a record online, or queue it if the device is offline. The same key is used for
   * both, so if the online attempt actually reached the server the replay is de-duplicated.
   */
  submit: <T extends { id: string }>(
    kind: OutboxKind,
    payload: Record<string, unknown>,
    summary: string,
    key?: string,
  ) => Promise<{ queued: false; result: T } | { queued: true; localId: string }>;
}

const OutboxContext = createContext<OutboxValue | null>(null);
const PATHS: Record<OutboxKind, string> = {
  'customer.create': '/customers',
  'debt.create': '/debts',
  'payment.create': '/payments',
};

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { businessId, status } = useSession();
  const qc = useQueryClient();
  const [ops, setOps] = useState<OutboxOp[]>([]);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const running = useRef(false);

  const reload = useCallback(async () => {
    const next = businessId ? await sqliteOutboxStore.all(businessId) : [];
    setOps(next);
  }, [businessId]);

  const syncNow = useCallback(async () => {
    if (!businessId || status !== 'signedIn' || running.current) return;
    running.current = true;
    setSyncing(true);
    try {
      const r = await flushOutbox(sqliteOutboxStore, api, businessId);
      if (r.sent > 0) await qc.invalidateQueries({ queryKey: [businessId] });
      if (!r.stoppedOffline) setLastSyncAt(Date.now());
    } finally {
      running.current = false;
      setSyncing(false);
      await reload();
    }
  }, [businessId, status, qc, reload]);

  useEffect(() => {
    let cancelled = false;
    (businessId ? sqliteOutboxStore.all(businessId) : Promise.resolve([])).then((next) => {
      if (!cancelled) setOps(next);
    });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  useEffect(() => {
    const unsubNet = NetInfo.addEventListener((s) => {
      const isOnline = !!s.isConnected && s.isInternetReachable !== false;
      setOnline(isOnline);
      if (isOnline) void syncNow();
    });
    const sub = AppState.addEventListener('change', (st) => st === 'active' && void syncNow());
    const timer = setInterval(() => void syncNow(), 60_000);
    return () => {
      unsubNet();
      sub.remove();
      clearInterval(timer);
    };
  }, [syncNow]);

  const submit: OutboxValue['submit'] = useCallback(
    async (kind, payload, summary, key) => {
      if (!businessId) throw new Error('No business selected');
      const id = key ?? newIdempotencyKey();
      const body: Record<string, unknown> = { ...payload, client_reference: id };
      const unresolvedLocal = typeof body.customer_id === 'string' && body.customer_id.startsWith(LOCAL_PREFIX);
      if (online && !unresolvedLocal) {
        try {
          const result = await api.post<never>(bizPath(businessId, PATHS[kind]), body, { idempotencyKey: id });
          await qc.invalidateQueries({ queryKey: [businessId] });
          return { queued: false, result };
        } catch (e) {
          if (!(e instanceof ApiError && e.isNetwork)) throw e;
        }
      }
      await sqliteOutboxStore.put(newOp(id, businessId, kind, payload, summary));
      await reload();
      return { queued: true, localId: `${LOCAL_PREFIX}${id}` };
    },
    [businessId, online, qc, reload],
  );

  const value: OutboxValue = {
    online,
    ops,
    pendingCount: ops.filter((o) => o.status === 'pending').length,
    failedCount: ops.filter((o) => o.status === 'failed').length,
    syncing,
    lastSyncAt,
    syncNow,
    retry: async (op) => {
      await retryOp(sqliteOutboxStore, op);
      await syncNow();
    },
    discard: async (op) => {
      await sqliteOutboxStore.remove(op.id);
      await reload();
    },
    submit,
  };
  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>;
}

export function useOutbox(): OutboxValue {
  const ctx = useContext(OutboxContext);
  if (!ctx) throw new Error('useOutbox must be used inside OutboxProvider');
  return ctx;
}
