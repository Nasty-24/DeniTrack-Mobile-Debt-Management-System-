/**
 * What this phone does with SMS for the business (Android builds only):
 *
 * - Reads M-Pesa "you have received" messages and sends them to the server, which records
 *   the payment when it matches one customer by phone number AND name (the rest wait in
 *   More → M-Pesa messages for an owner to match). Only messages from the sender M-PESA
 *   are read, starting from the moment the feature is turned on.
 * - Sends due reminder SMS from this phone's own SIM (normal SMS charges apply).
 *
 * Both are switched on per phone by an owner or administrator in Settings → This phone.
 * They run when the app opens, every minute while it is open, and about every 15 minutes
 * in the background (services/backgroundSync.ts).
 */
import * as SecureStore from 'expo-secure-store';
import { Linking } from 'react-native';

import { hasSmsPermission, readInbox, requestSmsPermission, sendSms, smsAvailable } from '../../modules/denitrack-sms';
import { getMeta, setMeta } from '../database/localDb';
import { getSelectedBusiness, secureTokenStore } from '../storage/secure';
import type { Membership } from '../types/api';
import { api, loadSavedApiUrl } from './api';
import { expectExternalActivity } from './appLifecycle';

export { smsAvailable };

export const MPESA_SENDERS = ['MPESA', 'M-PESA'];
const PREFS_KEY = 'denitrack.phoneSms';
const STATUS_KEY = 'phoneSms.status';
const SENT_KEY = 'phoneSms.sent';
const PROFILE_KEY = 'profile'; // written by the session (hooks/useSession.tsx)
const BATCH = 50;

export interface PhoneSmsPrefs {
  readMpesa: boolean;
  sendReminders: boolean;
}

export interface PhoneRunSummary {
  at: number;
  recorded: number;
  needsReview: number;
  remindersSent: number;
  error: string | null;
}

/** A reminder this phone should send (from the server). */
export interface PhoneSmsItem {
  reminder_id: string;
  customer_name: string;
  phone: string;
  message: string;
  whatsapp_url: string | null;
}

interface MpesaResult {
  status: string;
  detail: string | null;
}

const base = (businessId: string) => `/api/v1/businesses/${businessId}`;
const scanKey = (businessId: string) => `mpesa.lastScan.${businessId}`;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

// --------------------------------------------------------------------------- preferences (per phone)

export async function getPhoneSmsPrefs(): Promise<PhoneSmsPrefs> {
  const raw = await SecureStore.getItemAsync(PREFS_KEY).catch(() => null);
  try {
    return { readMpesa: false, sendReminders: false, ...(raw ? (JSON.parse(raw) as Partial<PhoneSmsPrefs>) : {}) };
  } catch {
    return { readMpesa: false, sendReminders: false };
  }
}

export async function setPhoneSmsPrefs(prefs: PhoneSmsPrefs): Promise<void> {
  await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(prefs));
}

/** Asks Android for the SMS permission. The prompt briefly leaves the app, so no splash on return. */
export async function askSmsPermission(kind: 'read' | 'send'): Promise<boolean> {
  if (await hasSmsPermission(kind)) return true;
  expectExternalActivity();
  return requestSmsPermission(kind);
}

// --------------------------------------------------------------------------- M-Pesa messages

/** Start from now: M-Pesa messages already on the phone are not recorded. */
export async function startMpesaReadingFromNow(businessId: string): Promise<void> {
  await setMeta(scanKey(businessId), String(Date.now()));
}

export async function syncMpesaInbox(businessId: string): Promise<{ recorded: number; needsReview: number }> {
  const saved = await getMeta(scanKey(businessId));
  if (!saved) {
    await startMpesaReadingFromNow(businessId);
    return { recorded: 0, needsReview: 0 };
  }
  let since = Number(saved) || Date.now();
  let recorded = 0;
  let needsReview = 0;
  for (let round = 0; round < 10; round++) {
    const batch = await readInbox(MPESA_SENDERS, since, BATCH);
    const payments = batch.filter((m) => /received/i.test(m.body) && m.body.trim().length >= 10);
    if (payments.length) {
      const res = await api.post<{ results: MpesaResult[] }>(`${base(businessId)}/mpesa-sms`, {
        messages: payments.map((m) => ({
          sender: m.address,
          body: m.body.slice(0, 1000),
          received_at: new Date(m.date).toISOString(),
        })),
      });
      for (const r of res.results) {
        if (r.status === 'applied' || r.status === 'confirmed') recorded++;
        else if (r.status === 'needs_review') needsReview++;
      }
    }
    // Only move on once the server has them, so nothing is skipped if it was unreachable.
    if (batch.length) {
      since = batch[batch.length - 1].date;
      await setMeta(scanKey(businessId), String(since));
    }
    if (batch.length < BATCH) break;
  }
  return { recorded, needsReview };
}

// --------------------------------------------------------------------------- reminder SMS

async function sentIds(): Promise<string[]> {
  try {
    return JSON.parse((await getMeta(SENT_KEY)) ?? '[]') as string[];
  } catch {
    return [];
  }
}

async function rememberSent(id: string): Promise<void> {
  const ids = [id, ...(await sentIds()).filter((x) => x !== id)].slice(0, 300);
  await setMeta(SENT_KEY, JSON.stringify(ids));
}

async function report(businessId: string, reminderId: string, sent: boolean, error?: string): Promise<void> {
  await api.post(`${base(businessId)}/reminders/${reminderId}/phone-result`, {
    sent,
    error: error ? error.slice(0, 300) : null,
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends the reminders the server says are due, from this phone's SIM. Returns how many went. */
export async function sendDueReminders(businessId: string): Promise<number> {
  const queue = await api.get<PhoneSmsItem[]>(`${base(businessId)}/reminders/phone-queue`);
  const already = new Set(await sentIds());
  let sent = 0;
  for (const item of queue) {
    if (already.has(item.reminder_id)) {
      // Sent earlier but the server never heard back: confirm instead of texting twice.
      await report(businessId, item.reminder_id, true);
      continue;
    }
    try {
      await sendSms(item.phone, item.message);
    } catch (e) {
      await report(businessId, item.reminder_id, false, messageOf(e)).catch(() => undefined);
      continue;
    }
    await rememberSent(item.reminder_id);
    sent++;
    await report(businessId, item.reminder_id, true).catch(() => undefined);
    await pause(1500); // Android limits how fast an app may send SMS
  }
  return sent;
}

// --------------------------------------------------------------------------- one-tap reminder

export type ManualChannel = 'sms' | 'whatsapp';

/**
 * Sends a reminder now with the business's wording and the customer's current balance.
 * SMS goes straight from this phone's SIM (or, without permission, opens the SMS app with
 * the message ready). WhatsApp opens the chat with the message ready; the person taps send.
 */
export async function sendManualReminder(
  businessId: string,
  customerId: string,
  channel: ManualChannel,
): Promise<{ outcome: 'sent' | 'opened'; item: PhoneSmsItem }> {
  const item = await api.post<PhoneSmsItem>(`${base(businessId)}/reminders/manual`, {
    customer_id: customerId,
    channel,
  });
  if (channel === 'whatsapp' && item.whatsapp_url) {
    expectExternalActivity();
    await Linking.openURL(item.whatsapp_url);
    return { outcome: 'opened', item };
  }
  if (smsAvailable && (await askSmsPermission('send'))) {
    try {
      await sendSms(item.phone, item.message);
    } catch (e) {
      await report(businessId, item.reminder_id, false, messageOf(e)).catch(() => undefined);
      throw e;
    }
    await rememberSent(item.reminder_id).catch(() => undefined);
    await report(businessId, item.reminder_id, true).catch(() => undefined);
    return { outcome: 'sent', item };
  }
  expectExternalActivity();
  await Linking.openURL(`sms:${item.phone}?body=${encodeURIComponent(item.message)}`);
  await report(businessId, item.reminder_id, true).catch(() => undefined);
  return { outcome: 'opened', item };
}

// --------------------------------------------------------------------------- running

let running: Promise<PhoneRunSummary | null> | null = null;

/** Does whatever this phone is switched on for. Safe to call often; runs one at a time. */
export function runPhoneTasks(ctx: { businessId: string; isManager: boolean }): Promise<PhoneRunSummary | null> {
  if (!smsAvailable || !ctx.isManager) return Promise.resolve(null);
  if (running) return running;
  running = (async () => {
    const prefs = await getPhoneSmsPrefs();
    if (!prefs.readMpesa && !prefs.sendReminders) return null;
    const summary: PhoneRunSummary = { at: Date.now(), recorded: 0, needsReview: 0, remindersSent: 0, error: null };
    try {
      if (prefs.readMpesa && (await hasSmsPermission('read'))) {
        const r = await syncMpesaInbox(ctx.businessId);
        summary.recorded = r.recorded;
        summary.needsReview = r.needsReview;
      }
      if (prefs.sendReminders && (await hasSmsPermission('send'))) {
        summary.remindersSent = await sendDueReminders(ctx.businessId);
      }
    } catch (e) {
      summary.error = messageOf(e);
    }
    await setMeta(STATUS_KEY, JSON.stringify(summary)).catch(() => undefined);
    return summary;
  })().finally(() => {
    running = null;
  });
  return running;
}

export async function lastPhoneRun(): Promise<PhoneRunSummary | null> {
  try {
    const raw = await getMeta(STATUS_KEY);
    return raw ? (JSON.parse(raw) as PhoneRunSummary) : null;
  } catch {
    return null;
  }
}

/** For the background task: works out who is signed in from what is saved on the phone. */
export async function runPhoneTasksFromStorage(): Promise<PhoneRunSummary | null> {
  if (!smsAvailable) return null;
  await loadSavedApiUrl().catch(() => undefined);
  if (!(await secureTokenStore.get())) return null;
  const businessId = await getSelectedBusiness();
  const profile = await getMeta(PROFILE_KEY);
  if (!businessId || !profile) return null;
  const { memberships } = JSON.parse(profile) as { memberships: Membership[] };
  const role = memberships.find((m) => m.business_id === businessId)?.role;
  return runPhoneTasks({ businessId, isManager: role === 'owner' || role === 'admin' });
}
