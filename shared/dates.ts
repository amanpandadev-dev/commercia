// Dates are stored as ISO "YYYY-MM-DD" in India time; timestamps as ISO strings (UTC).

const IST_OFFSET_MIN = 330;

export function istDate(d: Date = new Date()): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  return ist.toISOString().slice(0, 10);
}

export function istTime(iso: string): string {
  const ist = new Date(new Date(iso).getTime() + IST_OFFSET_MIN * 60000);
  return ist.toISOString().slice(11, 16);
}

/** "2026-10-12" -> "12-10-2026" */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-12" -> "12 Oct" */
export function shortDate(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}
