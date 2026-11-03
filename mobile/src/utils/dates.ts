const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Today's date in Nairobi as YYYY-MM-DD (businesses operate on East Africa Time). */
export function todayISO(now: Date = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return eat.toISOString().slice(0, 10);
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** "2026-10-29" -> "29 Oct 2026" */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const eat = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  const hh = String(eat.getUTCHours()).padStart(2, '0');
  const mm = String(eat.getUTCMinutes()).padStart(2, '0');
  return `${formatDate(eat.toISOString())}, ${hh}:${mm}`;
}

/** Human phrasing relative to today: "Due today", "Due in 3 days", "5 days overdue". */
export function dueLabel(dueISO: string, today: string = todayISO()): string {
  const diff = daysBetween(today, dueISO);
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  if (diff > 1) return `Due in ${diff} days`;
  if (diff === -1) return '1 day overdue';
  return `${-diff} days overdue`;
}

export function isValidISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
