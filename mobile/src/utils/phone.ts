/**
 * Client-side Kenyan phone normalisation for instant feedback. The server re-validates
 * every number with libphonenumber and is authoritative.
 */

// Safaricom, Airtel and Telkom mobile prefixes: 07xx and 01xx after the leading 0.
const KE_MOBILE = /^(?:7\d{8}|1[01]\d{7})$/;

export function normalizeKenyanPhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, '');
  let national: string;
  if (/^\+254\d+$/.test(digits)) national = digits.slice(4);
  else if (/^254\d+$/.test(digits)) national = digits.slice(3);
  else if (/^0\d+$/.test(digits)) national = digits.slice(1);
  else if (/^\d{9}$/.test(digits)) national = digits;
  else if (/^\+\d{8,15}$/.test(digits)) return digits; // other countries: accept, server validates
  else return null;
  return KE_MOBILE.test(national) ? `+254${national}` : null;
}

/** "+254712345678" -> "0712 345 678" */
export function formatPhone(e164: string): string {
  if (!e164.startsWith('+254') || e164.length !== 13) return e164;
  const n = `0${e164.slice(4)}`;
  return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
}
