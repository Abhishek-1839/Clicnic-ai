// Clinic time helpers. MVP supports Asia/Kolkata only (UTC+05:30, no daylight saving),
// so a fixed offset is exact and needs no timezone library.
export const IST_OFFSET_MIN = 330;
const MIN_MS = 60_000;

export type Ymd = { y: number; m: number; d: number };
export type IstParts = Ymd & { dow: number; minutes: number };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Calendar parts of an instant as seen in IST. `minutes` is minutes since local midnight. */
export function toIst(date: Date): IstParts {
  const t = new Date(date.getTime() + IST_OFFSET_MIN * MIN_MS);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    dow: t.getUTCDay(),
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

/** The instant for an IST calendar day plus minutes since local midnight. */
export function istDate(ymd: Ymd, minutes = 0): Date {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d) + minutes * MIN_MS - IST_OFFSET_MIN * MIN_MS);
}

export function addDays(ymd: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function dowOf(ymd: Ymd): number {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}

export function ymdKey(ymd: Ymd): string {
  return `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`;
}

/** "Thu 22 Oct, 10:30 AM" in clinic time. */
export function formatSlot(date: Date): string {
  const p = toIst(date);
  const h24 = Math.floor(p.minutes / 60);
  const mm = p.minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${DAYS[p.dow]} ${p.d} ${MONTHS[p.m - 1]}, ${h12}:${String(mm).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** "09:00" or "09:00:00" -> minutes since midnight. */
export function parseHm(t: string): number {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m ?? 0);
}
