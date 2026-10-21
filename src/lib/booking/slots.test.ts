import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, formatSlot, istDate, toIst, ymdKey } from "./time";
import { availableSlots, findSlotsWindow, generateSlotsForDay, matchesTimeOfDay, parseDateHint, pickSlots } from "./slots";
import type { DoctorCfg } from "./types";

// Wed 21 Oct 2026, 12:00 IST
const NOW = new Date("2026-10-21T06:30:00Z");

const doc = (id: string, name: string, days = [1, 2, 3, 4, 5, 6]): DoctorCfg => ({
  id,
  name,
  specialty: "General Medicine",
  working_days: days,
  start_time: "09:00:00",
  end_time: "17:00:00",
  slot_minutes: 30,
});

test("IST conversion and formatting", () => {
  const p = toIst(NOW);
  assert.deepEqual([p.y, p.m, p.d, p.dow, p.minutes], [2026, 10, 21, 3, 720]);
  assert.equal(istDate({ y: 2026, m: 10, d: 21 }, 570).toISOString(), "2026-10-21T04:00:00.000Z");
  assert.equal(formatSlot(new Date("2026-10-22T05:00:00Z")), "Thu 22 Oct, 10:30 AM");
  assert.equal(formatSlot(new Date("2026-10-22T10:30:00Z")), "Thu 22 Oct, 4:00 PM");
});

test("date hints", () => {
  const key = (h: string) => {
    const r = parseDateHint(h, NOW);
    return r ? `${ymdKey(r.from)}..${ymdKey(r.to)}` : null;
  };
  assert.equal(key("tomorrow"), "2026-10-22..2026-10-22");
  assert.equal(key("day after tomorrow"), "2026-10-23..2026-10-23");
  assert.equal(key("today"), "2026-10-21..2026-10-21");
  assert.equal(key("friday"), "2026-10-23..2026-10-23");
  assert.equal(key("wednesday"), "2026-10-21..2026-10-21");
  assert.equal(key("next wednesday"), "2026-10-28..2026-10-28");
  assert.equal(key("sunday"), "2026-10-25..2026-10-25");
  assert.equal(key("next week"), "2026-10-26..2026-11-01");
  assert.equal(key("whenever"), null);
  assert.equal(parseDateHint(null, NOW), null);
});

test("a full working day has 16 half-hour slots; Sunday has none", () => {
  const monday = { y: 2026, m: 10, d: 26 };
  assert.equal(generateSlotsForDay(doc("d1", "A"), monday, NOW).length, 16);
  assert.equal(generateSlotsForDay(doc("d1", "A"), { y: 2026, m: 10, d: 25 }, NOW).length, 0);
});

test("past slots and the 60-minute lead time are excluded", () => {
  const today = { y: 2026, m: 10, d: 21 };
  const slots = generateSlotsForDay(doc("d1", "A"), today, NOW); // now = 12:00 IST -> earliest 13:00
  assert.equal(slots.length, 8);
  assert.equal(slots[0].start, "2026-10-21T07:30:00.000Z");
});

test("booked slots are excluded", () => {
  const day = { y: 2026, m: 10, d: 22 };
  const all = generateSlotsForDay(doc("d1", "A"), day, NOW);
  const booked = [{ doctorId: "d1", start: new Date(all[0].start).toISOString().replace("Z", "+00:00") }];
  const left = availableSlots({ doctors: [doc("d1", "A")], booked, range: { from: day, to: day }, timeOfDay: null, now: NOW });
  assert.equal(left.length, 15);
  assert.ok(!left.some((s) => s.start === all[0].start));
});

test("time-of-day filter splits a day into 6 morning, 8 afternoon, 2 evening slots", () => {
  const day = { y: 2026, m: 10, d: 22 };
  const all = generateSlotsForDay(doc("d1", "A"), day, NOW);
  assert.equal(all.filter((s) => matchesTimeOfDay(s, "morning")).length, 6);
  assert.equal(all.filter((s) => matchesTimeOfDay(s, "afternoon")).length, 8);
  assert.equal(all.filter((s) => matchesTimeOfDay(s, "evening")).length, 2);
});

test("pickSlots shows every doctor, earliest first", () => {
  const day = { y: 2026, m: 10, d: 22 };
  const a = generateSlotsForDay(doc("d1", "A"), day, NOW);
  const b = generateSlotsForDay(doc("d2", "B"), day, NOW);
  const picked = pickSlots([...a, ...b], 4);
  assert.equal(picked.length, 4);
  assert.deepEqual(new Set(picked.map((s) => s.doctorId)), new Set(["d1", "d2"]));
  assert.deepEqual(
    picked.map((s) => s.start),
    [...picked.map((s) => s.start)].sort()
  );
});

test("a fully booked day widens the search and reports relaxed", () => {
  const tomorrow = addDays({ y: 2026, m: 10, d: 21 }, 1);
  const d = doc("d1", "A");
  const booked = generateSlotsForDay(d, tomorrow, NOW).map((s) => ({ doctorId: "d1", start: s.start }));
  const r = findSlotsWindow({ doctors: [d], booked, dateHint: "tomorrow", timeOfDay: null, now: NOW });
  assert.equal(r.relaxed, true);
  assert.ok(r.slots.length > 0);
  assert.ok(r.slots.every((s) => s.start > "2026-10-22T23:59:59Z"));
});

test("an exact match is not marked relaxed", () => {
  const r = findSlotsWindow({ doctors: [doc("d1", "A")], booked: [], dateHint: "friday", timeOfDay: "afternoon", now: NOW });
  assert.equal(r.relaxed, false);
  assert.ok(r.slots.length > 0);
  assert.ok(r.slots.every((s) => s.label.startsWith("Fri 23 Oct")));
});

test("no doctors means no slots", () => {
  const r = findSlotsWindow({ doctors: [], booked: [], dateHint: null, timeOfDay: null, now: NOW });
  assert.deepEqual(r, { slots: [], relaxed: false });
});
