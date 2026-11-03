/**
 * Money is carried as decimal strings ("1500.00") exactly as the API sends them and
 * converted to integer cents (BigInt) for any arithmetic. JavaScript numbers are never
 * used for amounts, so 0.1 + 0.2 problems cannot occur.
 */

const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;

export class AmountError extends Error {}

/** Parse what a person typed ("1,500", "1500.5", " 20 ") into a canonical "1500.50" string. */
export function parseAmountInput(input: string): string {
  const cleaned = input.replace(/[,\s]/g, '').replace(/^KSh/i, '');
  if (!AMOUNT_RE.test(cleaned)) {
    throw new AmountError('Enter an amount like 1500 or 1500.50');
  }
  return fromCents(toCents(cleaned));
}

export function isValidAmountInput(input: string): boolean {
  try {
    parseAmountInput(input);
    return true;
  } catch {
    return false;
  }
}

export function toCents(amount: string): bigint {
  const negative = amount.startsWith('-');
  const body = negative ? amount.slice(1) : amount;
  if (!/^\d+(\.\d{1,2})?$/.test(body)) {
    throw new AmountError(`Invalid amount: ${amount}`);
  }
  const [whole, frac = ''] = body.split('.');
  const cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return negative ? -cents : cents;
}

export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

export function add(...amounts: string[]): string {
  return fromCents(amounts.reduce((acc, a) => acc + toCents(a), 0n));
}

export function subtract(a: string, b: string): string {
  return fromCents(toCents(a) - toCents(b));
}

export function compare(a: string, b: string): -1 | 0 | 1 {
  const d = toCents(a) - toCents(b);
  return d === 0n ? 0 : d > 0n ? 1 : -1;
}

export function isZero(a: string): boolean {
  return toCents(a) === 0n;
}

export function isPositive(a: string): boolean {
  return toCents(a) > 0n;
}

/** "KSh 1,234,567.50". Grouping is done on the string, never via Number. */
export function formatKES(amount: string, opts: { withSymbol?: boolean; compact?: boolean } = {}): string {
  const { withSymbol = true, compact = false } = opts;
  const cents = toCents(amount);
  const negative = cents < 0n;
  const [whole, frac] = fromCents(negative ? -cents : cents).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = compact && frac === '00' ? grouped : `${grouped}.${frac}`;
  return `${negative ? '−' : ''}${withSymbol ? 'KSh ' : ''}${body}`;
}

/** Spoken form for screen readers: "1,500 shillings and 50 cents". */
export function amountLabel(amount: string): string {
  const [whole, frac] = fromCents(toCents(amount)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === '00' ? `${grouped} shillings` : `${grouped} shillings and ${Number(frac)} cents`;
}
