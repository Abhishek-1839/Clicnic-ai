import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleBasedAnalysis } from "../ai/fallback";
import type { AiEvent } from "../ai/types";
import { asksForClinicalAdvice } from "../safety/medical";
import { cleanName, handleTurn, INITIAL_STATE, matchDoctor, type ChatState, type Deps, type Input } from "./engine";
import { findSlotsWindow } from "./slots";
import { toIst } from "./time";
import type { ApptView, DoctorCfg, Slot } from "./types";

const NOW = new Date("2026-10-21T06:30:00Z"); // Wed 21 Oct 2026, 12:00 IST

const DOCS: DoctorCfg[] = [
  { id: "d1", name: "Dr. Meera Rao", specialty: "General Medicine", working_days: [1, 2, 3, 4, 5, 6], start_time: "09:00:00", end_time: "17:00:00", slot_minutes: 30 },
  { id: "d2", name: "Dr. Arjun Nair", specialty: "Pediatrics", working_days: [1, 2, 3, 4, 5, 6], start_time: "09:00:00", end_time: "17:00:00", slot_minutes: 30 },
];

type Rec = { id: string; refCode: string; doctorId: string; patientName: string; slotStart: string; slotEnd: string; status: string; reason: string };

function ev(intent: AiEvent["intent"]): AiEvent {
  return { provider: "rules", intent, extracted: null, latencyMs: 0, error: null };
}

function makeWorld() {
  const appts: Rec[] = [];
  const world = { appts, stealNext: false };

  const view = (a: Rec): ApptView => ({
    id: a.id,
    refCode: a.refCode,
    doctorId: a.doctorId,
    doctorName: DOCS.find((d) => d.id === a.doctorId)!.name,
    patientName: a.patientName,
    slotStart: a.slotStart,
    status: a.status,
    reason: a.reason,
  });
  const booked = () =>
    appts.filter((a) => a.status === "pending" || a.status === "confirmed").map((a) => ({ doctorId: a.doctorId, start: a.slotStart }));
  const isTaken = (doctorId: string, start: string) =>
    booked().some((b) => b.doctorId === doctorId && new Date(b.start).getTime() === new Date(start).getTime());

  const deps: Deps = {
    now: () => NOW,
    analyze: async (text) => {
      const r = ruleBasedAnalysis(text);
      return { intent: r.intent, extraction: r.extraction, needsClinician: asksForClinicalAdvice(text), event: ev(r.intent) };
    },
    answerFaq: async (text) =>
      /hours/i.test(text)
        ? { answerable: true, answer: "We are open 9 AM to 5 PM, Monday to Saturday.", event: ev("faq") }
        : { answerable: false, answer: "", event: ev("faq") },
    listDoctors: async () => DOCS.map(({ id, name, specialty }) => ({ id, name, specialty })),
    findSlots: async (q) =>
      findSlotsWindow({
        doctors: q.doctorId ? DOCS.filter((d) => d.id === q.doctorId) : DOCS,
        booked: booked(),
        dateHint: q.dateHint,
        timeOfDay: q.timeOfDay,
        now: NOW,
      }),
    createAppointment: async (a) => {
      if (world.stealNext) {
        world.stealNext = false;
        appts.push({ id: "x" + appts.length, refCode: "APT-ZZZZ", doctorId: a.doctorId, patientName: "Someone Else", slotStart: a.slotStart, slotEnd: a.slotEnd, status: "pending", reason: "" });
        return { ok: false, error: "slot_taken" };
      }
      if (isTaken(a.doctorId, a.slotStart)) return { ok: false, error: "slot_taken" };
      const rec: Rec = { id: "a" + appts.length, refCode: "APT-" + (1000 + appts.length), doctorId: a.doctorId, patientName: a.name, slotStart: a.slotStart, slotEnd: a.slotEnd, status: "pending", reason: a.reason };
      appts.push(rec);
      return { ok: true, appt: view(rec) };
    },
    findAppointment: async (ref, name) => {
      const a = appts.find((x) => x.refCode === ref && x.patientName.toLowerCase() === name.toLowerCase());
      return a ? view(a) : null;
    },
    cancelAppointment: async (id) => {
      const a = appts.find((x) => x.id === id);
      if (!a) return false;
      a.status = "cancelled";
      return true;
    },
    rescheduleAppointment: async (id, slot: Slot) => {
      const a = appts.find((x) => x.id === id)!;
      if (isTaken(slot.doctorId, slot.start)) return { ok: false, error: "slot_taken" };
      a.slotStart = slot.start;
      a.slotEnd = slot.end;
      a.doctorId = slot.doctorId;
      a.status = "pending";
      return { ok: true, appt: view(a) };
    },
  };
  return { world, deps };
}

function seedAppt(world: ReturnType<typeof makeWorld>["world"], status = "pending") {
  world.appts.push({
    id: "a-seed",
    refCode: "APT-AAAA",
    doctorId: "d1",
    patientName: "Aarav Sharma",
    slotStart: "2026-10-23T04:00:00.000Z", // Fri 09:30 IST
    slotEnd: "2026-10-23T04:30:00.000Z",
    status,
    reason: "Check-up",
  });
}

/** Run several inputs in sequence, returning every result. */
async function run(deps: Deps, inputs: Input[], start: ChatState = INITIAL_STATE) {
  const results = [];
  let state = start;
  for (const input of inputs) {
    const r = await handleTurn(state, input, deps);
    results.push(r);
    state = r.state;
  }
  return results;
}

const T = (text: string): Input => ({ text });

test("happy path: book step by step", async () => {
  const { world, deps } = makeWorld();
  const [r1, r2, r3, r4, r5] = await run(deps, [
    T("I want to book an appointment"),
    T("Aarav Sharma"),
    T("Follow-up visit"),
    { action: { type: "doctor", doctorId: "any" } },
    { action: { type: "slot", index: 0 } },
  ]);
  assert.equal(r1.state.step, "ask_name");
  assert.equal(r2.state.step, "ask_reason");
  assert.equal(r2.state.name, "Aarav Sharma");
  assert.equal(r3.state.step, "ask_doctor");
  assert.equal(r3.ui?.type, "doctors");
  assert.equal(r4.state.step, "choose_slot");
  assert.equal(r4.ui?.type, "slots");
  assert.ok(r4.ui?.type === "slots" && r4.ui.slots.length === 6);
  assert.equal(r5.ui?.type, "booking");
  assert.equal(world.appts.length, 1);
  assert.equal(world.appts[0].status, "pending");
  assert.equal(world.appts[0].patientName, "Aarav Sharma");
  assert.equal(r5.state.flow, null);
  assert.equal(r5.state.name, "Aarav Sharma");
});

test("one message with everything skips straight to matching slots", async () => {
  const { deps } = makeWorld();
  const [r] = await run(deps, [T("My name is Diya Patel, I need to see Dr. Nair tomorrow morning for my son's vaccination")]);
  assert.equal(r.state.name, "Diya Patel");
  assert.equal(r.state.doctorId, "d2");
  assert.equal(r.state.step, "choose_slot");
  assert.ok(r.ui?.type === "slots");
  if (r.ui?.type === "slots") {
    assert.equal(r.ui.slots.length, 6);
    for (const s of r.ui.slots) {
      assert.equal(s.doctorId, "d2");
      assert.ok(s.label.startsWith("Thu 22 Oct"));
      assert.ok(toIst(new Date(s.start)).minutes < 720);
    }
  }
});

test("a slot taken in a race is refused and fresh options are offered", async () => {
  const { world, deps } = makeWorld();
  const [r1, r2] = await run(deps, [
    T("My name is Diya Patel, I need to see Dr. Nair tomorrow morning for a vaccination"),
    { action: { type: "slot", index: 0 } },
  ]).then((rs) => {
    return [rs[0], rs[1]];
  });
  // First run only offered slots; now simulate the race on a second attempt.
  assert.ok(r1.ui?.type === "slots");
  const offered = r1.ui?.type === "slots" ? r1.ui.slots : [];
  assert.equal(r2.ui?.type, "booking"); // sanity: normal booking works

  world.stealNext = true;
  const [r3] = await run(deps, [{ action: { type: "slot", index: 0 } }], {
    ...r1.state,
    offered: offered.slice(1), // pick a different first slot
  });
  const stolen = offered[1];
  assert.match(r3.replies[0], /just taken/i);
  assert.ok(r3.ui?.type === "slots");
  if (r3.ui?.type === "slots") assert.ok(!r3.ui.slots.some((s) => s.start === stolen.start && s.doctorId === stolen.doctorId));
  assert.equal(r3.state.step, "choose_slot");
});

test("emergency text mid-flow is escalated immediately and keeps the flow", async () => {
  const { deps } = makeWorld();
  const rs = await run(deps, [T("I want to book an appointment"), T("Aarav Sharma"), T("I have severe chest pain")]);
  const r = rs[2];
  assert.equal(r.urgent, true);
  assert.equal(r.escalate, true);
  assert.match(r.replies[0], /emergency/i);
  assert.equal(r.state.step, "ask_reason");
});

test("medical-advice questions go to staff, not the AI", async () => {
  const { deps } = makeWorld();
  const [r] = await run(deps, [T("Should I take ibuprofen for my headache?")]);
  assert.equal(r.escalate, true);
  assert.match(r.replies[0], /medical advice/i);
  assert.equal(r.state.flow, null);
});

test("FAQ: answers when the knowledge base covers it, escalates when it doesn't", async () => {
  const { deps } = makeWorld();
  const [a] = await run(deps, [T("What are your hours?")]);
  assert.equal(a.escalate, false);
  assert.match(a.replies[0], /^We are open/);
  const [b] = await run(deps, [T("Do you have a cafeteria?")]);
  assert.equal(b.escalate, true);
});

test("cancel: wrong details are rejected, correct ones lead to a confirmation, yes cancels", async () => {
  const { world, deps } = makeWorld();
  seedAppt(world);
  const rs = await run(deps, [
    T("I want to cancel my appointment"),
    T("APT-AAAA"),
    T("Wrong Name"),
    T("APT-AAAA"),
    T("Aarav Sharma"),
    { action: { type: "confirm", yes: true } },
  ]);
  assert.equal(rs[0].state.step, "ask_ref");
  assert.equal(rs[1].state.step, "ask_verify_name");
  assert.equal(rs[2].state.step, "ask_ref"); // lookup failed
  assert.equal(rs[2].state.failedLookups, 1);
  assert.equal(rs[2].state.refCode, null);
  assert.equal(rs[3].state.step, "ask_verify_name");
  assert.equal(rs[4].state.step, "confirm_cancel");
  assert.equal(rs[4].ui?.type, "confirm");
  assert.equal(world.appts[0].status, "cancelled");
  assert.match(rs[5].replies[0], /cancelled/i);
  assert.equal(rs[5].state.flow, null);
});

test("cancel: answering No keeps the appointment", async () => {
  const { world, deps } = makeWorld();
  seedAppt(world);
  const rs = await run(deps, [
    T("cancel my appointment"),
    T("APT-AAAA"),
    T("Aarav Sharma"),
    { action: { type: "confirm", yes: false } },
  ]);
  assert.equal(world.appts[0].status, "pending");
  assert.match(rs[3].replies[0], /kept/i);
});

test("three failed lookups hand the chat to staff", async () => {
  const { world, deps } = makeWorld();
  seedAppt(world);
  const inputs: Input[] = [T("cancel my appointment")];
  for (let i = 0; i < 3; i++) inputs.push(T("APT-AAAA"), T("Nobody Known"));
  const rs = await run(deps, inputs);
  const last = rs[rs.length - 1];
  assert.equal(last.escalate, true);
  assert.equal(last.state.flow, null);
});

test("reschedule moves the appointment to the chosen slot and asks staff to reconfirm", async () => {
  const { world, deps } = makeWorld();
  seedAppt(world, "confirmed");
  const rs = await run(deps, [
    T("I need to reschedule my appointment"),
    T("APT-AAAA"),
    T("Aarav Sharma"),
    { action: { type: "slot", index: 0 } },
  ]);
  const offer = rs[2];
  assert.equal(offer.state.step, "choose_slot");
  assert.ok(offer.ui?.type === "slots" && offer.ui.slots.every((s) => s.doctorId === "d1"));
  const chosen = offer.ui?.type === "slots" ? offer.ui.slots[0] : null;
  assert.equal(world.appts[0].slotStart, chosen?.start);
  assert.equal(world.appts[0].status, "pending");
  assert.match(rs[3].replies[0], /moved/i);
});

test("status shows the booking card without changing anything", async () => {
  const { world, deps } = makeWorld();
  seedAppt(world);
  const rs = await run(deps, [T("What is the status of my booking APT-AAAA?"), T("Aarav Sharma")]);
  assert.equal(rs[0].state.step, "ask_verify_name");
  assert.equal(rs[1].ui?.type, "booking");
  if (rs[1].ui?.type === "booking") assert.equal(rs[1].ui.appointment.status, "pending");
  assert.equal(rs[1].state.flow, null);
  assert.equal(world.appts[0].status, "pending");
});

test("a cancelled appointment cannot be rescheduled", async () => {
  const { world, deps } = makeWorld();
  seedAppt(world, "cancelled");
  const rs = await run(deps, [T("I need to reschedule"), T("APT-AAAA"), T("Aarav Sharma")]);
  assert.match(rs[2].replies[0], /can't be changed/i);
  assert.equal(rs[2].ui, null);
  assert.equal(rs[2].state.flow, null);
});

test("invalid names are re-asked; lead-ins are stripped", async () => {
  const { deps } = makeWorld();
  const rs = await run(deps, [T("book an appointment"), T("12345"), T("my name is Asha Rao")]);
  assert.equal(rs[1].state.step, "ask_name");
  assert.equal(rs[1].state.name, null);
  assert.match(rs[1].replies[0], /name/i);
  assert.equal(rs[2].state.name, "Asha Rao");
  assert.equal(rs[2].state.step, "ask_reason");
});

test("typing a doctor's name or specialty picks that doctor", async () => {
  const { deps } = makeWorld();
  const base = [T("book an appointment"), T("Asha Rao"), T("skin check")];
  const [, , , byName] = await run(deps, [...base, T("Dr. Rao")]);
  assert.equal(byName.state.doctorId, "d1");
  assert.equal(byName.state.step, "choose_slot");
  const [, , , bySpec] = await run(deps, [...base, T("pediatrics")]);
  assert.equal(bySpec.state.doctorId, "d2");
});

test("while choosing a slot, a new day or time re-searches", async () => {
  const { deps } = makeWorld();
  const rs = await run(deps, [
    T("book an appointment"),
    T("Asha Rao"),
    T("check-up"),
    { action: { type: "doctor", doctorId: "any" } },
    T("Friday afternoon"),
  ]);
  const r = rs[4];
  assert.equal(r.state.step, "choose_slot");
  assert.ok(r.ui?.type === "slots");
  if (r.ui?.type === "slots") {
    for (const s of r.ui.slots) {
      assert.ok(s.label.startsWith("Fri 23 Oct"));
      const m = toIst(new Date(s.start)).minutes;
      assert.ok(m >= 720 && m < 960);
    }
  }
});

test("stale or invalid button clicks are handled gracefully", async () => {
  const { deps } = makeWorld();
  const [r] = await run(deps, [{ action: { type: "slot", index: 3 } }]);
  assert.match(r.replies[0], /no longer available/i);
  assert.equal(r.state.flow, null);
});

test("start over resets the flow and keeps the name", async () => {
  const { deps } = makeWorld();
  const rs = await run(deps, [T("book an appointment"), T("Asha Rao"), { action: { type: "restart" } }]);
  assert.equal(rs[2].state.flow, null);
  assert.equal(rs[2].state.step, null);
  assert.equal(rs[2].state.name, "Asha Rao");
  assert.match(rs[2].replies[0], /virtual assistant/i);
});

test("helpers: cleanName and matchDoctor", () => {
  assert.equal(cleanName("  I'm  Asha   Rao. "), "Asha Rao");
  assert.equal(cleanName("a"), null);
  assert.equal(cleanName("Robert'); DROP TABLE"), null);
  assert.equal(cleanName("one two three four five six"), null);
  const docs = DOCS.map(({ id, name, specialty }) => ({ id, name, specialty }));
  assert.equal(matchDoctor("Dr. Nair", docs)?.id, "d2");
  assert.equal(matchDoctor("general", docs)?.id, "d1");
  assert.equal(matchDoctor("dr", docs), null);
  assert.equal(matchDoctor("cardiology", docs), null);
});

test("the chat remembers the verified appointment: later requests do not ask for the code or name again", async () => {
  const { world, deps } = makeWorld();
  seedAppt(world);
  const rs = await run(deps, [
    T("What is the status of my booking APT-AAAA?"),
    T("Aarav Sharma"),
    T("I want to cancel my appointment"),
    { action: { type: "confirm", yes: true } },
  ]);
  assert.equal(rs[1].state.knownRef, "APT-AAAA");
  assert.equal(rs[2].state.step, "confirm_cancel"); // straight to the confirmation
  assert.equal(world.appts[0].status, "cancelled");
});

test("a failed lookup forgets the remembered code so it cannot loop", async () => {
  const { deps } = makeWorld();
  const rs = await run(deps, [T("cancel my appointment APT-ZZZZ"), T("Nobody Known")]);
  assert.equal(rs[1].state.knownRef, null);
  assert.equal(rs[1].state.step, "ask_ref");
});
