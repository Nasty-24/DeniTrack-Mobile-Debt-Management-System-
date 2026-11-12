import { addDaysISO, daysBetween, dueLabel, formatDate, isValidISODate, todayISO } from '../utils/dates';
import { add, amountLabel, compare, formatKES, fromCents, parseAmountInput, subtract, toCents } from '../utils/money';
import { formatPhone, normalizeKenyanPhone } from '../utils/phone';
import { itemsOnOneLine } from '../utils/text';

describe('itemsOnOneLine', () => {
  it('joins one-item-per-line text with commas, dropping blank lines and spaces', () => {
    expect(itemsOnOneLine('Sugar 2kg\nBread\n\n  Milk 1L  \n')).toBe('Sugar 2kg, Bread, Milk 1L');
    expect(itemsOnOneLine('Sugar 2kg\r\nBread')).toBe('Sugar 2kg, Bread');
    expect(itemsOnOneLine('Sugar 2kg,\nBread;')).toBe('Sugar 2kg, Bread');
  });

  it('leaves a single line as it is', () => {
    expect(itemsOnOneLine('Cement 10 bags')).toBe('Cement 10 bags');
  });
});

describe('money', () => {
  it('parses what people type into canonical 2dp strings', () => {
    expect(parseAmountInput('1500')).toBe('1500.00');
    expect(parseAmountInput('1,500.5')).toBe('1500.50');
    expect(parseAmountInput(' 20 ')).toBe('20.00');
    expect(parseAmountInput('KSh250')).toBe('250.00');
  });

  it.each(['', 'abc', '-5', '1.234', '1e5', '12.', '.5', '1,2,3x'])('rejects %p', (bad) => {
    expect(() => parseAmountInput(bad)).toThrow();
  });

  it('adds without floating point error', () => {
    expect(add('0.10', '0.20')).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3); // the problem being avoided
    expect(add('999999999999.99', '0.01')).toBe('1000000000000.00');
    expect(subtract('100.00', '33.33')).toBe('66.67');
    expect(subtract('5.00', '7.50')).toBe('-2.50');
  });

  it('round-trips cents', () => {
    for (const v of ['0.00', '0.01', '12.30', '1000000.99', '-4.05']) expect(fromCents(toCents(v))).toBe(v);
  });

  it('compares', () => {
    expect(compare('10.00', '9.99')).toBe(1);
    expect(compare('10', '10.00')).toBe(0);
    expect(compare('-1.00', '0.00')).toBe(-1);
  });

  it('formats Kenyan shillings with grouping', () => {
    expect(formatKES('1234567.5')).toBe('KSh 1,234,567.50');
    expect(formatKES('500.00', { compact: true })).toBe('KSh 500');
    expect(formatKES('-20.00')).toBe('−KSh 20.00');
    expect(amountLabel('1500.50')).toBe('1,500 shillings and 50 cents');
  });
});

describe('phone', () => {
  it.each([
    ['0712345678', '+254712345678'],
    ['0712 345 678', '+254712345678'],
    ['712345678', '+254712345678'],
    ['254712345678', '+254712345678'],
    ['+254 712 345 678', '+254712345678'],
    ['0110123456', '+254110123456'],
  ])('normalises %p', (input, expected) => {
    expect(normalizeKenyanPhone(input)).toBe(expected);
  });

  it.each(['12345', '0812345678', '07123', 'phone', '+2547123456789'])('rejects %p', (bad) => {
    expect(normalizeKenyanPhone(bad)).toBeNull();
  });

  it('formats for display', () => {
    expect(formatPhone('+254712345678')).toBe('0712 345 678');
  });
});

describe('dates', () => {
  it('uses East Africa Time for "today"', () => {
    // 22:30 UTC on 31 Dec is already 1 Jan in Nairobi
    expect(todayISO(new Date('2026-12-31T22:30:00Z'))).toBe('2027-01-01');
  });

  it('does day arithmetic across months and leap years', () => {
    expect(addDaysISO('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59);
  });

  it('labels due dates', () => {
    expect(dueLabel('2026-05-10', '2026-05-10')).toBe('Due today');
    expect(dueLabel('2026-05-11', '2026-05-10')).toBe('Due tomorrow');
    expect(dueLabel('2026-05-15', '2026-05-10')).toBe('Due in 5 days');
    expect(dueLabel('2026-05-09', '2026-05-10')).toBe('1 day overdue');
    expect(dueLabel('2026-05-01', '2026-05-10')).toBe('9 days overdue');
  });

  it('validates ISO dates strictly', () => {
    expect(isValidISODate('2026-02-28')).toBe(true);
    expect(isValidISODate('2026-02-30')).toBe(false);
    expect(isValidISODate('28/02/2026')).toBe(false);
    expect(formatDate('2026-10-29')).toBe('29 Oct 2026');
  });
});
