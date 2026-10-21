// Supabase-backed implementation of the engine's Deps. Server only (uses the service-role client).
// Every query is scoped by clinic_id. The database enforces no-double-booking via a partial unique index,
// so a lost race surfaces here as error code 23505 and becomes "slot_taken".
import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeMessage, answerFaq as aiAnswerFaq } from "../ai/analyze";
import type { Deps } from "./engine";
import { makeRefCode } from "./refcode";
import { findSlotsWindow } from "./slots";
import type { ApptView, DoctorCfg, Slot } from "./types";

type Clinic = { id: string; faq_kb: unknown };
export type StoreCtx = { patientId: string | null };

const SELECT = "id, ref_code, doctor_id, slot_start, status, reason, patients(name), doctors(name)";
const ACTIVE = ["pending", "confirmed"];

type Row = {
  id: string;
  ref_code: string;
  doctor_id: string;
  slot_start: string;
  status: string;
  reason: string;
  patients: { name: string } | { name: string }[] | null;
  doctors: { name: string } | { name: string }[] | null;
};

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function toView(r: Row): ApptView {
  return {
    id: r.id,
    refCode: r.ref_code,
    doctorId: r.doctor_id,
    doctorName: one(r.doctors)?.name ?? "the doctor",
    patientName: one(r.patients)?.name ?? "",
    slotStart: r.slot_start,
    status: r.status,
    reason: r.reason,
  };
}

export function makeDeps(db: SupabaseClient, clinic: Clinic, ctx: StoreCtx): Deps {
  async function loadAppt(id: string): Promise<ApptView | null> {
    const { data } = await db.from("appointments").select(SELECT).eq("id", id).eq("clinic_id", clinic.id).maybeSingle();
    return data ? toView(data as unknown as Row) : null;
  }

  return {
    now: () => new Date(),

    async analyze(text) {
      const r = await analyzeMessage(text);
      return { intent: r.analysis.intent, extraction: r.analysis.extraction, needsClinician: r.needsClinician, event: r.event };
    },

    async answerFaq(text) {
      const r = await aiAnswerFaq(text, clinic.faq_kb);
      return { answerable: r.answerable, answer: r.answer, event: r.event };
    },

    async listDoctors() {
      const { data } = await db
        .from("doctors")
        .select("id, name, specialty")
        .eq("clinic_id", clinic.id)
        .eq("active", true)
        .order("name");
      return data ?? [];
    },

    async findSlots(q) {
      const { data: docs } = await db
        .from("doctors")
        .select("id, name, specialty, working_days, start_time, end_time, slot_minutes")
        .eq("clinic_id", clinic.id)
        .eq("active", true);
      let doctors = (docs ?? []) as DoctorCfg[];
      if (q.doctorId) doctors = doctors.filter((d) => d.id === q.doctorId);

      const now = new Date();
      const horizon = new Date(now.getTime() + 35 * 86_400_000);
      const { data: booked } = await db
        .from("appointments")
        .select("doctor_id, slot_start")
        .eq("clinic_id", clinic.id)
        .in("status", ACTIVE)
        .gte("slot_start", now.toISOString())
        .lte("slot_start", horizon.toISOString());

      return findSlotsWindow({
        doctors,
        booked: (booked ?? []).map((b) => ({ doctorId: b.doctor_id as string, start: b.slot_start as string })),
        dateHint: q.dateHint,
        timeOfDay: q.timeOfDay,
        now,
      });
    },

    async createAppointment(a) {
      const { data: patient, error: pErr } = await db
        .from("patients")
        .insert({ clinic_id: clinic.id, name: a.name })
        .select("id")
        .single();
      if (pErr || !patient) return { ok: false, error: "failed" };

      const cleanup = async () => {
        await db.from("patients").delete().eq("id", patient.id);
      };

      for (let attempt = 0; attempt < 5; attempt++) {
        const { data, error } = await db
          .from("appointments")
          .insert({
            clinic_id: clinic.id,
            ref_code: makeRefCode(),
            patient_id: patient.id,
            doctor_id: a.doctorId,
            slot_start: a.slotStart,
            slot_end: a.slotEnd,
            reason: a.reason,
            status: "pending",
            source: "chat",
          })
          .select("id")
          .single();

        if (!error && data) {
          const appt = await loadAppt(data.id);
          if (!appt) break;
          ctx.patientId = patient.id;
          return { ok: true, appt };
        }
        if (error?.code === "23505") {
          if (error.message.includes("appointments_doctor_slot_active")) {
            await cleanup();
            return { ok: false, error: "slot_taken" };
          }
          continue; // reference-code collision: try a new code
        }
        break;
      }
      await cleanup();
      return { ok: false, error: "failed" };
    },

    async findAppointment(refCode, name) {
      const { data } = await db
        .from("appointments")
        .select(SELECT)
        .eq("clinic_id", clinic.id)
        .eq("ref_code", refCode.toUpperCase())
        .maybeSingle();
      if (!data) return null;
      const view = toView(data as unknown as Row);
      return norm(view.patientName) === norm(name) ? view : null;
    },

    async cancelAppointment(id) {
      const { data, error } = await db
        .from("appointments")
        .update({ status: "cancelled" })
        .eq("id", id)
        .eq("clinic_id", clinic.id)
        .in("status", ACTIVE)
        .select("id");
      return !error && !!data && data.length > 0;
    },

    async rescheduleAppointment(id, slot: Slot) {
      const { data, error } = await db
        .from("appointments")
        .update({ slot_start: slot.start, slot_end: slot.end, doctor_id: slot.doctorId, status: "pending" })
        .eq("id", id)
        .eq("clinic_id", clinic.id)
        .in("status", ACTIVE)
        .select("id");
      if (error?.code === "23505") return { ok: false, error: "slot_taken" };
      if (error || !data || data.length === 0) return { ok: false, error: "failed" };
      const appt = await loadAppt(id);
      return appt ? { ok: true, appt } : { ok: false, error: "failed" };
    },
  };
}
