// Booking state machine. The SERVER controls the flow; the LLM only classifies the first message of a flow
// (via deps.analyze) and answers FAQs from the clinic knowledge base. Everything else is deterministic:
// questions asked, buttons offered, slots chosen, bookings written. This keeps the product working even
// when every AI provider is down, and makes double-booking via hallucination impossible.
//
// All I/O goes through `Deps`, so this module is unit-tested with an in-memory fake.
import { extractRefCode, ruleBasedAnalysis } from "../ai/fallback";
import type { AiEvent, Extraction, Intent, TimeOfDay } from "../ai/types";
import { detectEmergency, emergencyReply } from "../safety/emergency";
import { formatSlot } from "./time";
import type { Action, ApptView, Doctor, Slot, Ui } from "./types";

export type Flow = "book" | "reschedule" | "cancel" | "status";
export type Step =
  | "ask_name"
  | "ask_reason"
  | "ask_doctor"
  | "choose_slot"
  | "ask_ref"
  | "ask_verify_name"
  | "confirm_cancel";

export type ChatState = {
  flow: Flow | null;
  step: Step | null;
  name: string | null;
  reason: string | null;
  doctorId: string | null;
  anyDoctor: boolean;
  dateHint: string | null;
  timeOfDay: TimeOfDay | null;
  refCode: string | null;
  /** Latest appointment booked or verified in THIS chat; lets the patient skip re-typing the code. */
  knownRef: string | null;
  appointmentId: string | null;
  apptLabel: string | null;
  offered: Slot[];
  failedLookups: number;
  turns: number;
};

export const INITIAL_STATE: ChatState = {
  flow: null,
  step: null,
  name: null,
  reason: null,
  doctorId: null,
  anyDoctor: false,
  dateHint: null,
  timeOfDay: null,
  refCode: null,
  knownRef: null,
  appointmentId: null,
  apptLabel: null,
  offered: [],
  failedLookups: 0,
  turns: 0,
};

export type Input = { text?: string | null; action?: Action | null };

export type Deps = {
  now(): Date;
  analyze(text: string): Promise<{
    intent: Intent;
    extraction: Extraction;
    needsClinician: boolean;
    event: AiEvent;
  }>;
  answerFaq(text: string): Promise<{ answerable: boolean; answer: string; event: AiEvent }>;
  listDoctors(): Promise<Doctor[]>;
  findSlots(q: {
    doctorId: string | null;
    dateHint: string | null;
    timeOfDay: TimeOfDay | null;
  }): Promise<{ slots: Slot[]; relaxed: boolean }>;
  createAppointment(a: {
    name: string;
    reason: string;
    doctorId: string;
    slotStart: string;
    slotEnd: string;
  }): Promise<{ ok: true; appt: ApptView } | { ok: false; error: "slot_taken" | "failed" }>;
  findAppointment(refCode: string, name: string): Promise<ApptView | null>;
  cancelAppointment(id: string): Promise<boolean>;
  rescheduleAppointment(
    id: string,
    slot: Slot
  ): Promise<{ ok: true; appt: ApptView } | { ok: false; error: "slot_taken" | "failed" }>;
};

export type TurnResult = {
  state: ChatState;
  replies: string[];
  ui: Ui | null;
  urgent: boolean;
  escalate: boolean;
  events: AiEvent[];
};

type Out = Omit<TurnResult, "state">;
type Ctx = { s: ChatState; out: Out; deps: Deps };

const MAX_TEXT = 500;
const MAX_LOOKUPS = 3;

export const MENU_TEXT =
  "Hi! I'm the clinic's virtual assistant (AI). I can help you book, reschedule or cancel an appointment, check a booking's status, or answer questions about the clinic. What would you like to do?";
const STAFF_HANDOFF =
  "I've passed this to our clinic staff. They'll reply here in this chat, so please keep this page open or come back to it later on this device.";

const say = (c: Ctx, ...t: string[]): void => {
  c.out.replies.push(...t);
};

const first = (name: string | null): string => (name ?? "").split(" ")[0] || "there";

function resetFlow(c: Ctx): void {
  c.s = { ...INITIAL_STATE, name: c.s.name, turns: c.s.turns, knownRef: c.s.knownRef ?? null };
}

function statusText(status: string): string {
  switch (status) {
    case "pending":
      return "pending confirmation by our staff";
    case "confirmed":
      return "confirmed";
    case "cancelled":
      return "cancelled";
    case "completed":
      return "completed";
    case "no_show":
      return "marked as missed";
    default:
      return status;
  }
}

/** Accepts a plausible human name, or returns null. Strips lead-ins like "my name is". */
export function cleanName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw
    .trim()
    .replace(/^(my name is|i am|i'm|this is|name:?)\s+/i, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (t.length < 2 || t.length > 60) return null;
  if (!/^[\p{L}][\p{L}\s.'-]*$/u.test(t)) return null;
  if (t.split(/\s+/).length > 5) return null;
  return t.replace(/\s+/g, " ");
}

/** Match "Dr. Nair", "nair", "pediatrics" to exactly one doctor, else null. */
export function matchDoctor(pref: string | null | undefined, doctors: Doctor[]): Doctor | null {
  if (!pref) return null;
  const p = pref.toLowerCase().replace(/\bdr\.?\s*/g, "").trim();
  if (!p) return null;
  const tokens = p.split(/[^a-z]+/).filter((w) => w.length >= 3);
  const hits = doctors.filter((d) => {
    const name = d.name.toLowerCase().replace(/\bdr\.?\s*/g, "").trim();
    const spec = d.specialty.toLowerCase();
    if (name.includes(p) || p.includes(name)) return true;
    if (spec.includes(p) || p.includes(spec)) return true;
    return tokens.some(
      (t) => name.split(/\s+/).includes(t) || (t.length >= 5 && spec.split(/\s+/).some((w) => w.slice(0, 5) === t.slice(0, 5)))
    );
  });
  return hits.length === 1 ? hits[0] : null;
}

export async function handleTurn(state: ChatState, input: Input, deps: Deps): Promise<TurnResult> {
  const c: Ctx = {
    s: { ...state, turns: state.turns + 1 },
    out: { replies: [], ui: null, urgent: false, escalate: false, events: [] },
    deps,
  };
  const text = (input.text ?? "").trim().slice(0, MAX_TEXT);

  // 1) Safety first, on every turn, before anything else. Deterministic: no LLM involved.
  if (text) {
    const em = detectEmergency(text);
    if (em.urgent && em.kind) {
      say(c, emergencyReply(em.kind));
      c.out.urgent = true;
      c.out.escalate = true;
      c.out.events.push({ provider: "rules", intent: "urgent", extracted: null, latencyMs: 0, error: null });
      return { state: c.s, ...c.out };
    }
  }

  if (input.action) await handleAction(c, input.action);
  else if (text) {
    if (c.s.flow && c.s.step) await handleInFlow(c, text);
    else await handleNew(c, text);
  } else say(c, MENU_TEXT);

  return { state: c.s, ...c.out };
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry: a message with no active flow. The only place an LLM is used (plus FAQ answers).
// ---------------------------------------------------------------------------------------------------------------------
async function handleNew(c: Ctx, text: string): Promise<void> {
  const a = await c.deps.analyze(text);
  c.out.events.push(a.event);

  if (a.needsClinician) {
    c.out.escalate = true;
    say(
      c,
      "I'm an administrative assistant, so I can't give medical advice or assess symptoms. I've sent your question to our clinic staff so a clinician can respond. " +
        "If this is urgent, please call your local emergency number."
    );
    return;
  }

  switch (a.intent) {
    case "book":
    case "reschedule":
    case "cancel":
    case "status":
      return startFlow(c, a.intent, a.extraction);
    case "faq": {
      const f = await c.deps.answerFaq(text);
      c.out.events.push(f.event);
      if (f.answerable) {
        say(c, f.answer);
      } else {
        c.out.escalate = true;
        say(c, "I don't have that information to hand, so I've passed your question to our clinic staff. " + STAFF_HANDOFF);
      }
      return;
    }
    default:
      say(c, MENU_TEXT);
  }
}

async function startFlow(
  c: Ctx,
  flow: Flow,
  ex: Extraction | null
): Promise<void> {
  c.s = { ...INITIAL_STATE, turns: c.s.turns, name: c.s.name, knownRef: c.s.knownRef ?? null, flow };
  if (ex) {
    const nm = cleanName(ex.patient_name);
    if (nm) c.s.name = nm;
    if (ex.reason) c.s.reason = ex.reason.slice(0, 200);
    c.s.dateHint = ex.date_hint;
    c.s.timeOfDay = ex.time_of_day;
    if (ex.ref_code) c.s.refCode = extractRefCode(ex.ref_code);
    if (flow === "book" && ex.doctor_preference) {
      const d = matchDoctor(ex.doctor_preference, await c.deps.listDoctors());
      if (d) c.s.doctorId = d.id;
    }
  }
  // Same chat, same patient: reuse the appointment they just booked or looked up.
  if (flow !== "book" && !c.s.refCode && c.s.knownRef) c.s.refCode = c.s.knownRef;
  await advance(c);
}

// ---------------------------------------------------------------------------------------------------------------------
// advance(): decide the next question for the current flow. Idempotent, so it also re-asks after a stale click.
// ---------------------------------------------------------------------------------------------------------------------
async function advance(c: Ctx): Promise<void> {
  const s = c.s;

  if (s.flow === "book") {
    if (!s.name) {
      s.step = "ask_name";
      return say(c, "Happy to help you book an appointment. What's your full name?");
    }
    if (!s.reason) {
      s.step = "ask_reason";
      return say(
        c,
        `Thanks, ${first(s.name)}. What's the reason for your visit? A short phrase is enough; please don't include detailed medical history.`
      );
    }
    if (!s.doctorId && !s.anyDoctor) {
      s.step = "ask_doctor";
      c.out.ui = { type: "doctors", doctors: await c.deps.listDoctors() };
      return say(c, "Which doctor would you like to see?");
    }
    return offerSlots(c);
  }

  if (s.flow === "reschedule" || s.flow === "cancel" || s.flow === "status") {
    if (!s.refCode) {
      s.step = "ask_ref";
      return say(c, "Please share your appointment reference code. It looks like APT-4F7K.");
    }
    if (!s.name) {
      s.step = "ask_verify_name";
      return say(c, "Thanks. For security, what's the full name on the booking?");
    }
    if (!s.appointmentId) {
      const appt = await c.deps.findAppointment(s.refCode, s.name);
      if (!appt) {
        s.failedLookups += 1;
        if (s.failedLookups >= MAX_LOOKUPS) {
          c.out.escalate = true;
          resetFlow(c);
          c.s.name = null;
          c.s.knownRef = null;
          return say(c, "I couldn't verify those details. " + STAFF_HANDOFF);
        }
        s.refCode = null;
        s.knownRef = null;
        s.name = null;
        s.step = "ask_ref";
        return say(
          c,
          "I couldn't find an appointment matching those details. Please check the reference code and the name on the booking, then send the code again."
        );
      }

      s.knownRef = appt.refCode;
      const label = `${formatSlot(new Date(appt.slotStart))} with ${appt.doctorName}`;
      if (s.flow === "status") {
        c.out.ui = { type: "booking", appointment: appt, headline: "Your appointment" };
        say(c, `Your appointment ${appt.refCode} on ${label} is ${statusText(appt.status)}.`);
        return resetFlow(c);
      }
      const active = appt.status === "pending" || appt.status === "confirmed";
      if (!active || new Date(appt.slotStart).getTime() < c.deps.now().getTime()) {
        say(
          c,
          `That appointment (${appt.refCode}) is ${statusText(appt.status)} and can't be changed here. I can book a new appointment for you if you like.`
        );
        return resetFlow(c);
      }
      s.appointmentId = appt.id;
      s.apptLabel = label;
      s.doctorId = appt.doctorId;
      s.anyDoctor = false;
      if (s.flow === "reschedule") say(c, `I found your appointment with ${label}. Let's find a new time.`);
    }

    if (s.flow === "cancel") {
      s.step = "confirm_cancel";
      c.out.ui = { type: "confirm", label: s.apptLabel ?? "your appointment" };
      return say(c, `Do you want to cancel your appointment with ${s.apptLabel ?? "us"}?`);
    }
    return offerSlots(c);
  }

  say(c, MENU_TEXT);
}

async function offerSlots(c: Ctx): Promise<void> {
  const s = c.s;
  const r = await c.deps.findSlots({ doctorId: s.doctorId, dateHint: s.dateHint, timeOfDay: s.timeOfDay });
  if (r.slots.length === 0) {
    c.out.escalate = true;
    resetFlow(c);
    return say(c, "I couldn't find any open times in the next two weeks. " + STAFF_HANDOFF);
  }
  s.offered = r.slots;
  s.step = "choose_slot";
  c.out.ui = { type: "slots", slots: r.slots };
  say(
    c,
    r.relaxed
      ? "I couldn't find an opening that matches exactly, so here are the nearest available times. Tap one to choose it, or tell me another day."
      : 'Here are the available times. Tap one to choose it, or tell me another day or time, like "Friday afternoon".'
  );
}

async function completeSlot(c: Ctx, slot: Slot): Promise<void> {
  const s = c.s;

  if (s.flow === "book") {
    const r = await c.deps.createAppointment({
      name: s.name ?? "",
      reason: s.reason ?? "",
      doctorId: slot.doctorId,
      slotStart: slot.start,
      slotEnd: slot.end,
    });
    if (r.ok) {
      s.knownRef = r.appt.refCode;
      c.out.ui = { type: "booking", appointment: r.appt, headline: "Your appointment request" };
      say(
        c,
        `You're all set, ${first(s.name)}! I've requested ${slot.label} with ${slot.doctorName} under reference ${r.appt.refCode}. ` +
          "Our staff will confirm it shortly. Please save your reference code: you'll need it to reschedule, cancel or check the status."
      );
      return resetFlow(c);
    }
    if (r.error === "slot_taken") {
      say(c, "Sorry, that time was just taken by someone else. Here are the updated options.");
      return offerSlots(c);
    }
    c.out.ui = { type: "slots", slots: s.offered };
    return say(c, "Sorry, I couldn't save your booking just now. Please tap a time to try again.");
  }

  // reschedule
  const r = await c.deps.rescheduleAppointment(s.appointmentId ?? "", slot);
  if (r.ok) {
    s.knownRef = r.appt.refCode;
    c.out.ui = { type: "booking", appointment: r.appt, headline: "Your updated appointment" };
    say(
      c,
      `Done! Your appointment ${r.appt.refCode} has been moved to ${slot.label} with ${slot.doctorName}. It's pending reconfirmation by our staff.`
    );
    return resetFlow(c);
  }
  if (r.error === "slot_taken") {
    say(c, "Sorry, that time was just taken by someone else. Here are the updated options.");
    return offerSlots(c);
  }
  c.out.ui = { type: "slots", slots: s.offered };
  say(c, "Sorry, I couldn't move your appointment just now. Please tap a time to try again.");
}

async function doCancel(c: Ctx): Promise<void> {
  const ok = await c.deps.cancelAppointment(c.s.appointmentId ?? "");
  if (ok) {
    say(c, "Your appointment has been cancelled, and the time is now free for others. You can book a new one anytime.");
    return resetFlow(c);
  }
  c.out.ui = { type: "confirm", label: c.s.apptLabel ?? "your appointment" };
  say(c, "Sorry, I couldn't cancel that just now. Please try again, or I can pass this to our staff.");
}

// ---------------------------------------------------------------------------------------------------------------------
// Button clicks
// ---------------------------------------------------------------------------------------------------------------------
async function stale(c: Ctx): Promise<void> {
  say(c, "That option is no longer available.");
  if (c.s.flow) await advance(c);
  else say(c, MENU_TEXT);
}

async function handleAction(c: Ctx, a: Action): Promise<void> {
  switch (a.type) {
    case "restart":
      resetFlow(c);
      return say(c, MENU_TEXT);

    case "intent":
      if (a.intent === "staff") {
        c.out.escalate = true;
        return say(c, STAFF_HANDOFF);
      }
      if (a.intent === "faq") {
        resetFlow(c);
        return say(c, "Sure. What would you like to know? For example our hours, location, services or policies.");
      }
      return startFlow(c, a.intent, null);

    case "doctor": {
      if (c.s.step !== "ask_doctor") return stale(c);
      if (a.doctorId === "any") {
        c.s.anyDoctor = true;
        c.s.doctorId = null;
      } else {
        const d = (await c.deps.listDoctors()).find((x) => x.id === a.doctorId);
        if (!d) return stale(c);
        c.s.doctorId = d.id;
        c.s.anyDoctor = false;
      }
      return advance(c);
    }

    case "slot": {
      if (c.s.step !== "choose_slot") return stale(c);
      const slot = c.s.offered[a.index];
      if (!slot) return stale(c);
      return completeSlot(c, slot);
    }

    case "confirm": {
      if (c.s.step !== "confirm_cancel") return stale(c);
      if (a.yes) return doCancel(c);
      say(c, "No problem, I've kept your appointment as it is.");
      return resetFlow(c);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Free-text replies while a flow is active. Rule-based only (no LLM call): fast, free and predictable.
// ---------------------------------------------------------------------------------------------------------------------
async function handleInFlow(c: Ctx, text: string): Promise<void> {
  if (/^(start over|restart|never ?mind|menu|go back)\b/i.test(text)) {
    resetFlow(c);
    return say(c, MENU_TEXT);
  }
  const s = c.s;

  switch (s.step) {
    case "ask_name":
    case "ask_verify_name": {
      const n = cleanName(text);
      if (!n) return say(c, "Sorry, I didn't catch a name. Please type the full name, for example Asha Rao.");
      s.name = n;
      return advance(c);
    }

    case "ask_reason": {
      if (text.length < 3) return say(c, "Could you give me a short reason for the visit, for example \"follow-up check\"?");
      const ex = ruleBasedAnalysis(text).extraction;
      s.reason = text.slice(0, 200);
      s.dateHint = s.dateHint ?? ex.date_hint;
      s.timeOfDay = s.timeOfDay ?? ex.time_of_day;
      if (ex.doctor_preference) {
        const d = matchDoctor(ex.doctor_preference, await c.deps.listDoctors());
        if (d) s.doctorId = d.id;
      }
      return advance(c);
    }

    case "ask_doctor": {
      const doctors = await c.deps.listDoctors();
      if (/\b(any|anyone|whoever|no preference|first available|doesn'?t matter)\b/i.test(text)) {
        s.anyDoctor = true;
        s.doctorId = null;
      } else {
        const d = matchDoctor(text, doctors);
        if (!d) {
          c.out.ui = { type: "doctors", doctors };
          return say(c, 'I couldn\'t match that to one of our doctors. Please tap a doctor below, or say "any doctor".');
        }
        s.doctorId = d.id;
        s.anyDoctor = false;
      }
      const ex = ruleBasedAnalysis(text).extraction;
      s.dateHint = s.dateHint ?? ex.date_hint;
      s.timeOfDay = s.timeOfDay ?? ex.time_of_day;
      return advance(c);
    }

    case "ask_ref": {
      const ref = extractRefCode(text);
      if (!ref) return say(c, "I couldn't see a reference code in that. It looks like APT-4F7K.");
      s.refCode = ref;
      return advance(c);
    }

    case "choose_slot": {
      const ex = ruleBasedAnalysis(text).extraction;
      if (ex.date_hint || ex.time_of_day) {
        if (ex.date_hint) {
          s.dateHint = ex.date_hint;
          s.timeOfDay = ex.time_of_day;
        } else {
          s.timeOfDay = ex.time_of_day;
        }
        if (s.flow === "book" && ex.doctor_preference) {
          const d = matchDoctor(ex.doctor_preference, await c.deps.listDoctors());
          if (d) {
            s.doctorId = d.id;
            s.anyDoctor = false;
          }
        }
        return offerSlots(c);
      }
      c.out.ui = { type: "slots", slots: s.offered };
      return say(c, 'Please tap one of the times above, or tell me another day or time, for example "Friday afternoon".');
    }

    case "confirm_cancel": {
      if (/^(y|yes|yeah|yep|sure|confirm|ok|okay)\b/i.test(text)) return doCancel(c);
      if (/^(n|no|nope|don'?t|keep)\b/i.test(text)) {
        say(c, "No problem, I've kept your appointment as it is.");
        return resetFlow(c);
      }
      c.out.ui = { type: "confirm", label: s.apptLabel ?? "your appointment" };
      return say(c, "Please tap Yes to cancel or No to keep your appointment.");
    }

    default:
      return handleNew(c, text);
  }
}
