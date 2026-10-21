import { NextResponse } from "next/server";
import { getStaff } from "@/lib/dashboard/auth";
import { canTransition, statusMessage, STATUSES, type Status } from "@/lib/dashboard/transitions";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatSlot } from "@/lib/booking/time";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return NextResponse.json({ error: "Please sign in." }, { status: 401 });

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { status?: string };
  const to = body.status as Status;
  if (!STATUSES.includes(to)) return NextResponse.json({ error: "Unknown status." }, { status: 400 });

  // RLS-bound read: doctors only see their own appointments, other clinics are invisible.
  const { data: appt } = await staff.supabase
    .from("appointments")
    .select("id, clinic_id, patient_id, ref_code, status, slot_start, doctors(name)")
    .eq("id", id)
    .maybeSingle();
  if (!appt) return NextResponse.json({ error: "Appointment not found." }, { status: 404 });

  const from = appt.status as Status;
  if (!canTransition(staff.role, from, to)) {
    return NextResponse.json({ error: `You can't change this from "${from}" to "${to}".` }, { status: 403 });
  }

  const { data: updated, error } = await staff.supabase
    .from("appointments")
    .update({ status: to })
    .eq("id", id)
    .eq("status", from) // guards against two staff acting at once
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not update. Please try again." }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "Someone else just updated this. Refresh to see it." }, { status: 409 });

  // Workflow C: tell the patient in their chat thread.
  let notified = false;
  const doctor = Array.isArray(appt.doctors) ? appt.doctors[0] : appt.doctors;
  const text = statusMessage(to, {
    refCode: appt.ref_code,
    doctorName: doctor?.name ?? "your doctor",
    when: formatSlot(new Date(appt.slot_start)),
  });
  if (text) {
    try {
      const db = createAdminClient();
      // Prefer the chat that booked/verified this reference; fall back to the patient's latest chat.
      let { data: conv } = await db
        .from("conversations")
        .select("id")
        .eq("clinic_id", appt.clinic_id)
        .eq("state->>knownRef", appt.ref_code)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!conv) {
        ({ data: conv } = await db
          .from("conversations")
          .select("id")
          .eq("clinic_id", appt.clinic_id)
          .eq("patient_id", appt.patient_id)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle());
      }
      if (conv) {
        const { error: mErr } = await db.from("messages").insert({
          conversation_id: conv.id,
          clinic_id: appt.clinic_id,
          role: "ai",
          content: text,
          ai_generated: true,
          review_status: "sent",
        });
        notified = !mErr;
      }
    } catch {
      /* the status change already succeeded; the notice is best-effort */
    }
  }
  return NextResponse.json({ ok: true, status: to, notified });
}
