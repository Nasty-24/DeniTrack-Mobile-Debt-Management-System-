/**
 * The phone's contacts, for picking a customer quickly.
 *
 * Privacy: the phone book is read into memory only while a form that uses it is open. It is
 * never stored, queued or sent anywhere; only the person staff pick is saved, as a customer.
 */
import { Contact, ContactField, getPermissionsAsync, requestPermissionsAsync } from 'expo-contacts';

import { normalizeKenyanPhone } from '../utils/phone';

export interface PhoneBookNumber {
  raw: string;
  /** The number DeniTrack would save, or null when it can't be used (e.g. a landline). */
  e164: string | null;
}

export interface PhoneBookEntry {
  id: string;
  name: string;
  numbers: PhoneBookNumber[];
}

export type ContactsAccess = 'granted' | 'undetermined' | 'denied';

const MIN_QUERY = 2;
const MIN_DIGITS = 3;
const NUMBER_QUERY = /^[\d\s+()-]+$/;

function toAccess(status: string): ContactsAccess {
  return status === 'granted' || status === 'undetermined' ? status : 'denied';
}

export async function getContactsAccess(): Promise<ContactsAccess> {
  return toAccess((await getPermissionsAsync()).status);
}

export async function requestContactsAccess(): Promise<ContactsAccess> {
  return toAccess((await requestPermissionsAsync()).status);
}

/** Every contact that has a phone number: names and numbers only. */
export async function loadPhoneBook(): Promise<PhoneBookEntry[]> {
  const all = await Contact.getAllDetails([ContactField.FULL_NAME, ContactField.PHONES]);
  const book: PhoneBookEntry[] = [];
  for (const c of all) {
    const numbers = (c.phones ?? [])
      .map((p) => p.number?.trim() ?? '')
      .filter((raw) => raw.length > 0)
      .map((raw) => ({ raw, e164: normalizeKenyanPhone(raw) }));
    if (numbers.length === 0) continue;
    const name = c.fullName?.trim() || numbers[0].raw;
    book.push({ id: c.id, name, numbers });
  }
  return book;
}

/** National digits as the server's customer search compares them: no 254 or leading 0. */
function nationalDigits(s: string): string {
  const digits = s.replace(/\D/g, '');
  return digits.startsWith('254') ? digits.slice(3) : digits.replace(/^0+/, '');
}

/** Contacts whose name or number matches, leaving out people who are already customers. */
export function searchPhoneBook(
  book: PhoneBookEntry[],
  query: string,
  knownPhones: ReadonlySet<string>,
  limit = 20,
): PhoneBookEntry[] {
  const q = query.trim();
  if (q.length < MIN_QUERY) return [];
  const byNumber = NUMBER_QUERY.test(q) && q.replace(/\D/g, '').length >= MIN_DIGITS;
  const needle = byNumber ? nationalDigits(q) : q.toLowerCase();
  const out: PhoneBookEntry[] = [];
  for (const entry of book) {
    if (entry.numbers.some((n) => n.e164 !== null && knownPhones.has(n.e164))) continue;
    const hit = byNumber
      ? entry.numbers.some((n) => nationalDigits(n.raw).includes(needle))
      : entry.name.toLowerCase().includes(needle);
    if (hit) out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}
