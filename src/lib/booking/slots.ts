// Per-doctor slot engine. The LLM never touches dates or slots: it only returns a raw phrase
// like "tomorrow", and this code turns it into a date range and the slots inside it.
import type { TimeOfDay } from "../ai/types";
import { addDays, dowOf, formatSlot, istDate, parseHm, toIst, ymdKey, type Ymd } from "./time";
import type { DoctorCfg, Slot } from "./types";

export type DateRange = { from: Ymd; to: Ymd };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Turn a phrase such as "tomorrow", "friday", "next week" into a day range (IST). Unknown phrases return null. */
export function parseDateHint(hint: string | null | undefined, now: Date): DateRange | null {
  if (!hint) return null;
  const h = hint.toLowerCase().trim();
  const t = toIst(now);
  const today: Ymd = { y: t.y, m: t.m, d: t.d };
  const one = (n: number): DateRange => {
    const d = addDays(today, n);
    return { from: d, to: d };
  };

  if (/day after tomorrow/.test(h)) return one(2);
  if (/tomorrow/.test(h)) return one(1);
  if (/\b(today|tonight)\b/.test(h)) return one(0);
  if (/next week/.test(h)) {
    const delta = (8 - t.dow) % 7 || 7; // next Monday
    const from = addDays(today, delta);
    return { from, to: addDays(from, 6) };
  }
  if (/this week/.test(h)) return { from: today, to: addDays(today, (7 - t.dow) % 7) };

  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (h.includes(WEEKDAYS[i])) {
      let delta = (i - t.dow + 7) % 7;
      if (/\bnext\b/.test(h)) delta = delta || 7;
      return one(delta);
    }
  }
  return null;
}

export function matchesTimeOfDay(slot: Slot, tod: TimeOfDay | null): boolean {
  if (!tod) return true;
  const minutes = toIst(new Date(slot.start)).minutes;
  if (tod === "morning") return minutes < 12 * 60;
  if (tod === "afternoon") return minutes >= 12 * 60 && minutes < 16 * 60;
  return minutes >= 16 * 60; // evening
}

/** All slots a doctor offers on one IST day, skipping anything sooner than `leadMinutes` from now. */
export function generateSlotsForDay(doc: DoctorCfg, day: Ymd, now: Date, leadMinutes = 60): Slot[] {
  if (!doc.working_days.includes(dowOf(day))) return [];
  const start = parseHm(doc.start_time);
  const end = parseHm(doc.end_time);
  const len = doc.slot_minutes;
  const earliest = now.getTime() + leadMinutes * 60_000;
  const out: Slot[] = [];
  for (let t = start; t + len <= end; t += len) {
    const s = istDate(day, t);
    if (s.getTime() < earliest) continue;
    out.push({
      doctorId: doc.id,
      doctorName: doc.name,
      start: s.toISOString(),
      end: istDate(day, t + len).toISOString(),
      label: formatSlot(s),
    });
  }
  return out;
}

export type BookedSlot = { doctorId: string; start: string };

export function availableSlots(args: {
  doctors: DoctorCfg[];
  booked: BookedSlot[];
  range: DateRange;
  timeOfDay: TimeOfDay | null;
  now: Date;
}): Slot[] {
  const taken = new Set(args.booked.map((b) => `${b.doctorId}|${new Date(b.start).getTime()}`));
  const out: Slot[] = [];
  const toKey = ymdKey(args.range.to);
  for (let i = 0; i < 45; i++) {
    const day = addDays(args.range.from, i);
    if (ymdKey(day) > toKey) break;
    for (const doc of args.doctors) {
      for (const slot of generateSlotsForDay(doc, day, args.now)) {
        if (taken.has(`${slot.doctorId}|${new Date(slot.start).getTime()}`)) continue;
        if (!matchesTimeOfDay(slot, args.timeOfDay)) continue;
        out.push(slot);
      }
    }
  }
  return out;
}

/** Pick up to `limit` slots, taking the earliest from each doctor in turn so several doctors are shown. */
export function pickSlots(slots: Slot[], limit = 6): Slot[] {
  const byDoctor = new Map<string, Slot[]>();
  for (const s of slots) {
    const list = byDoctor.get(s.doctorId) ?? [];
    list.push(s);
    byDoctor.set(s.doctorId, list);
  }
  const queues = [...byDoctor.values()].map((q) => q.sort((a, b) => a.start.localeCompare(b.start)));
  const picked: Slot[] = [];
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const q of queues) {
      const next = q.shift();
      if (next && picked.length < limit) {
        picked.push(next);
        progressed = true;
      }
    }
  }
  return picked.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Find slots for a request. If nothing matches, widen to 14 days, then drop the time-of-day filter.
 * `relaxed` tells the caller the result is "nearest available" rather than an exact match.
 */
export function findSlotsWindow(args: {
  doctors: DoctorCfg[];
  booked: BookedSlot[];
  dateHint: string | null;
  timeOfDay: TimeOfDay | null;
  now: Date;
  limit?: number;
}): { slots: Slot[]; relaxed: boolean } {
  const t = toIst(args.now);
  const today: Ymd = { y: t.y, m: t.m, d: t.d };
  const parsed = parseDateHint(args.dateHint, args.now);
  const base: DateRange = parsed ?? { from: today, to: addDays(today, 7) };
  const wide: DateRange = { from: base.from, to: addDays(base.from, 14) };

  const attempts: [DateRange, TimeOfDay | null][] = [
    [base, args.timeOfDay],
    [wide, args.timeOfDay],
    [wide, null],
  ];
  for (let i = 0; i < attempts.length; i++) {
    const [range, tod] = attempts[i];
    const found = availableSlots({ doctors: args.doctors, booked: args.booked, range, timeOfDay: tod, now: args.now });
    if (found.length > 0) {
      return {
        slots: pickSlots(found, args.limit ?? 6),
        relaxed: i > 0 && (parsed !== null || args.timeOfDay !== null),
      };
    }
  }
  return { slots: [], relaxed: false };
}
