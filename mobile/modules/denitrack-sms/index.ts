import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';

/** An SMS from the phone's inbox. `date` is milliseconds since 1970 (when it arrived). */
export interface InboxSms {
  id: string;
  address: string;
  body: string;
  date: number;
}

interface NativeSms {
  readInbox(senders: string[], sinceMs: number, limit: number): Promise<InboxSms[]>;
  sendSms(phone: string, message: string): Promise<'sent' | 'unconfirmed'>;
}

// Only present in Android builds of the app (not in Expo Go, iOS or tests).
const native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeSms>('DenitrackSms') : null;

/** True when this device can read and send SMS itself (Android builds of the app). */
export const smsAvailable = native !== null;

export type SmsPermission = 'read' | 'send';

const PERMISSION = {
  read: PermissionsAndroid.PERMISSIONS.READ_SMS,
  send: PermissionsAndroid.PERMISSIONS.SEND_SMS,
} as const;

export async function hasSmsPermission(kind: SmsPermission): Promise<boolean> {
  if (!native) return false;
  return PermissionsAndroid.check(PERMISSION[kind]);
}

/** Shows Android's permission prompt. Returns true if allowed. */
export async function requestSmsPermission(kind: SmsPermission): Promise<boolean> {
  if (!native) return false;
  const result = await PermissionsAndroid.request(PERMISSION[kind]);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export async function readInbox(senders: string[], sinceMs: number, limit = 100): Promise<InboxSms[]> {
  if (!native) return [];
  return native.readInbox(senders, sinceMs, limit);
}

/** Sends an SMS from this phone's SIM. Rejects with a readable message if it fails. */
export async function sendSms(phone: string, message: string): Promise<'sent' | 'unconfirmed'> {
  if (!native) throw new Error('This phone cannot send SMS from the app.');
  return native.sendSms(phone, message);
}
