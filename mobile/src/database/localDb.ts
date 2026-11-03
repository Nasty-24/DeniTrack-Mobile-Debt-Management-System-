/**
 * Local SQLite database: offline outbox, id mappings, and a read cache of the last
 * server responses. Encrypted with SQLCipher (key in the platform keystore) when the
 * native build includes it; `encryption` reports which is the case so the Settings
 * screen can show it honestly.
 */
import * as SQLite from 'expo-sqlite';

import type { OutboxOp, OutboxStore } from '../services/outbox';
import { getDatabaseKey } from '../storage/secure';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
export let encryption: 'sqlcipher' | 'unavailable' | 'unknown' = 'unknown';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY NOT NULL,
  business_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS id_map (local_id TEXT PRIMARY KEY NOT NULL, server_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS query_cache (
  key TEXT PRIMARY KEY NOT NULL,
  business_id TEXT NOT NULL,
  body TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`;

async function open(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync('denitrack.db');
  const key = await getDatabaseKey();
  // Hex keys contain only [0-9a-f], so this interpolation cannot inject SQL.
  await db.execAsync(`PRAGMA key = "x'${key}'"`);
  const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version');
  encryption = cipher ? 'sqlcipher' : 'unavailable';
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync(SCHEMA);
  return db;
}

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

interface OutboxRow {
  id: string;
  business_id: string;
  kind: string;
  payload: string;
  summary: string;
  created_at: number;
  status: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number;
}

function rowToOp(r: OutboxRow): OutboxOp {
  return {
    id: r.id,
    businessId: r.business_id,
    kind: r.kind as OutboxOp['kind'],
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    summary: r.summary,
    createdAt: r.created_at,
    status: r.status as OutboxOp['status'],
    attempts: r.attempts,
    lastError: r.last_error,
    nextAttemptAt: r.next_attempt_at,
  };
}

export const sqliteOutboxStore: OutboxStore = {
  async all(businessId) {
    const db = await getDb();
    const rows = await db.getAllAsync<OutboxRow>(
      'SELECT * FROM outbox WHERE business_id = $b ORDER BY created_at',
      { $b: businessId },
    );
    return rows.map(rowToOp);
  },
  async put(op) {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO outbox (id, business_id, kind, payload, summary, created_at, status, attempts,
         last_error, next_attempt_at)
       VALUES ($id, $b, $kind, $payload, $summary, $created, $status, $attempts, $err, $next)`,
      {
        $id: op.id,
        $b: op.businessId,
        $kind: op.kind,
        $payload: JSON.stringify(op.payload),
        $summary: op.summary,
        $created: op.createdAt,
        $status: op.status,
        $attempts: op.attempts,
        $err: op.lastError,
        $next: op.nextAttemptAt,
      },
    );
  },
  async remove(id) {
    const db = await getDb();
    await db.runAsync('DELETE FROM outbox WHERE id = $id', { $id: id });
  },
  async getMapping(localId) {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_id: string }>('SELECT server_id FROM id_map WHERE local_id = $l', {
      $l: localId,
    });
    return row?.server_id ?? null;
  },
  async setMapping(localId, serverId) {
    const db = await getDb();
    await db.runAsync('INSERT OR REPLACE INTO id_map (local_id, server_id) VALUES ($l, $s)', {
      $l: localId,
      $s: serverId,
    });
  },
};

export interface CachedBody<T> {
  body: T;
  savedAt: number;
}

export async function readCache<T>(key: string): Promise<CachedBody<T> | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ body: string; saved_at: number }>(
    'SELECT body, saved_at FROM query_cache WHERE key = $k',
    { $k: key },
  );
  return row ? { body: JSON.parse(row.body) as T, savedAt: row.saved_at } : null;
}

export async function writeCache(key: string, businessId: string, body: unknown): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO query_cache (key, business_id, body, saved_at) VALUES ($k, $b, $body, $t)', {
    $k: key,
    $b: businessId,
    $body: JSON.stringify(body),
    $t: Date.now(),
  });
}

export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = $k', { $k: key });
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES ($k, $v)', { $k: key, $v: value });
}

/** Called on sign-out: no customer or financial data stays on the device. */
export async function wipeLocalData(): Promise<void> {
  const db = await getDb();
  await db.execAsync('DELETE FROM outbox; DELETE FROM id_map; DELETE FROM query_cache; DELETE FROM meta;');
}
