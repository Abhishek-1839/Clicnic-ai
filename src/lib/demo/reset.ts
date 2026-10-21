import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, dowOf, istDate, toIst, type Ymd } from "@/lib/booking/time";
import { makeRefCode } from "@/lib/booking/refcode";

export const DEMO_SLUG = "sunrise-demo";

const PATIENTS = ["Aarav Sharma", "Diya Menon", "Kabir Singh", "Ananya Iyer", "Rohan Gupta", "Isha Verma"];

function workingDays(from: Ymd, count: number, step: 1 | -1): Ymd[] {
  const out: Ymd[] = [];
  let d = addDays(from, step);
  while (out.length < count) {
    if (dowOf(d) !== 0) out.push(d);
    d = addDays(d, step);
  }
  return out;
}

type Status = "pending" | "confirmed" | "cancelled" | "completed" | "no_show";

/**
 * Wipes the demo clinic's patients, appointments, conversations and AI logs, then loads fresh sample data.
 * Keeps the clinic, doctors and staff logins. Refuses any clinic that is not the demo clinic.
 */
export async function resetDemoData(db: SupabaseClient, clinicId: string) {
  const { data: clinic } = await db.from("clinics").select("id, slug").eq("id", clinicId).maybeSingle();
  if (!clinic || clinic.slug !== DEMO_SLUG) throw new Error("Reset is only available for the demo clinic.");

  const { data: doctors } = await db.from("doctors").select("id").eq("clinic_id", clinicId).order("created_at");
  if (!doctors || doctors.length < 3) throw new Error("The demo clinic needs its 3 doctors. Run npm run seed:reset.");

  // Cascades remove appointments, history and conversations' messages with their patients/conversations.
  for (const table of ["ai_events", "messages", "conversations", "appointments", "patients"] as const) {
    const { error } = await db.from(table).delete().eq("clinic_id", clinicId);
    if (error) throw new Error(`Could not clear ${table}.`);
  }

  const { data: patients, error: pErr } = await db
    .from("patients")
    .insert(PATIENTS.map((name) => ({ clinic_id: clinicId, name })))
    .select("id, name");
  if (pErr || !patients) throw new Error("Could not create sample patients.");
  const byName = (n: string) => patients.find((p) => p.name === n)!.id;

  const today = toIst(new Date());
  const future = workingDays(today, 4, 1);
  const past = workingDays(today, 2, -1);
  const at = (day: Ymd, hm: string) => {
    const [h, m] = hm.split(":").map(Number);
    return istDate(day, h * 60 + m);
  };

  const plan: { p: number; d: number; day: Ymd; time: string; status: Status; reason: string }[] = [
    { p: 0, d: 0, day: future[0], time: "09:30", status: "pending", reason: "Follow-up visit for routine check" },
    { p: 1, d: 1, day: future[0], time: "10:00", status: "confirmed", reason: "Child vaccination schedule" },
    { p: 2, d: 2, day: future[0], time: "11:30", status: "pending", reason: "Skin rash consultation" },
    { p: 3, d: 0, day: future[1], time: "14:00", status: "confirmed", reason: "Annual health check-up" },
    { p: 4, d: 0, day: future[1], time: "15:30", status: "cancelled", reason: "Medication review" },
    { p: 5, d: 1, day: future[2], time: "09:00", status: "pending", reason: "Growth and development check" },
    { p: 0, d: 2, day: future[2], time: "12:00", status: "confirmed", reason: "Acne treatment follow-up" },
    { p: 2, d: 0, day: future[3], time: "10:30", status: "pending", reason: "General consultation" },
    { p: 3, d: 1, day: future[3], time: "16:00", status: "cancelled", reason: "Routine pediatric visit" },
    { p: 1, d: 0, day: past[0], time: "10:00", status: "completed", reason: "Fever follow-up" },
    { p: 4, d: 2, day: past[0], time: "11:00", status: "no_show", reason: "Skin check" },
    { p: 5, d: 0, day: past[1], time: "09:30", status: "completed", reason: "Blood pressure review" },
  ];
  const used = new Set<string>();
  const rows = plan.map((x) => {
    let ref = makeRefCode();
    while (used.has(ref)) ref = makeRefCode();
    used.add(ref);
    const start = at(x.day, x.time);
    return {
      clinic_id: clinicId,
      ref_code: ref,
      patient_id: patients[x.p].id,
      doctor_id: doctors[x.d].id,
      slot_start: start.toISOString(),
      slot_end: new Date(start.getTime() + 30 * 60_000).toISOString(),
      reason: x.reason,
      status: x.status,
      source: "chat",
    };
  });
  const { error: aErr } = await db.from("appointments").insert(rows);
  if (aErr) throw new Error("Could not create sample appointments.");

  const convos = [
    { patient: byName("Kabir Singh"), status: "awaiting_staff", urgent: false, msgs: [["patient", "Do you accept walk-ins on Saturdays, and is parking available?"]] },
    { patient: byName("Ananya Iyer"), status: "awaiting_staff", urgent: false, msgs: [["patient", "Can I get a copy of my previous visit summary sent to me?"]] },
    {
      patient: null,
      status: "awaiting_staff",
      urgent: true,
      msgs: [
        ["patient", "I have severe chest pain and trouble breathing."],
        ["ai", "This may be an emergency. Please call your local emergency number right now or go to the nearest emergency department. I'm an administrative assistant and cannot assess symptoms. A staff member has been alerted."],
      ],
    },
    { patient: byName("Aarav Sharma"), status: "resolved", urgent: false, msgs: [["patient", "Hi, I'd like to book an appointment."], ["ai", "Happy to help! May I have your name and the reason for your visit?"]] },
  ] as const;

  for (const c of convos) {
    const { data: conv, error } = await db
      .from("conversations")
      .insert({ clinic_id: clinicId, patient_id: c.patient, status: c.status, urgent: c.urgent })
      .select("id")
      .single();
    if (error || !conv) throw new Error("Could not create sample conversations.");
    const base = Date.now() - c.msgs.length * 60_000;
    const { error: mErr } = await db.from("messages").insert(
      c.msgs.map(([role, content], i) => ({
        conversation_id: conv.id,
        clinic_id: clinicId,
        role,
        content,
        ai_generated: role === "ai",
        review_status: "sent",
        created_at: new Date(base + i * 60_000).toISOString(),
      }))
    );
    if (mErr) throw new Error("Could not create sample messages.");
  }
  return { appointments: rows.length, conversations: convos.length };
}
