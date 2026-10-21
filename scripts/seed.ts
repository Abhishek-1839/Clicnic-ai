// Seeds one synthetic demo clinic: 3 doctors, demo logins, patients, appointments, conversations.
// Usage:  npm run seed            (fails if the demo clinic already exists)
//         npm run seed:reset      (deletes the demo clinic's data and recreates it)
//
// All names below are fictional. No real patient information is used.
import {
  adminClient,
  createClinic,
  createStaffUser,
  istSlot,
  makeRefCode,
  workingOffsets,
} from "./lib";

const DEMO_SLUG = "sunrise-demo";
const DEMO_NAME = "Sunrise Family Clinic (Demo)";
const PASSWORD = process.env.DEMO_PASSWORD ?? "Demo@12345";

const PATIENT_NAMES = [
  "Aarav Sharma",
  "Diya Patel",
  "Rohan Mehta",
  "Ananya Iyer",
  "Kabir Singh",
  "Isha Verma",
];

async function main() {
  const reset = process.argv.includes("--reset");
  const db = adminClient();

  const { data: existing } = await db.from("clinics").select("id").eq("slug", DEMO_SLUG).maybeSingle();
  if (existing) {
    if (!reset) {
      console.log(`Demo clinic "${DEMO_SLUG}" already exists. Run "npm run seed:reset" to recreate it.`);
      return;
    }
    // All clinic-owned tables cascade on delete.
    const { error } = await db.from("clinics").delete().eq("id", existing.id);
    if (error) throw error;
    console.log("Removed existing demo clinic data.");
  }

  // --- Clinic + doctors -------------------------------------------------
  const { clinic, doctors } = await createClinic(db, { name: DEMO_NAME, slug: DEMO_SLUG });
  console.log(`Created clinic: ${clinic.name}`);

  // --- Demo logins ------------------------------------------------------
  const logins: { email: string; role: string }[] = [];
  const mk = async (
    email: string,
    fullName: string,
    role: "admin" | "staff" | "doctor",
    doctorId?: string
  ) => {
    await createStaffUser(db, { clinicId: clinic.id, email, password: PASSWORD, fullName, role, doctorId });
    logins.push({ email, role });
  };

  await mk("admin@demo-clinic.example.com", "Priya Admin", "admin");
  await mk("staff@demo-clinic.example.com", "Vikram Staff", "staff");
  await mk("doctor@demo-clinic.example.com", doctors[0].name, "doctor", doctors[0].id);

  // --- Patients ---------------------------------------------------------
  const { data: patients, error: pErr } = await db
    .from("patients")
    .insert(PATIENT_NAMES.map((name) => ({ clinic_id: clinic.id, name })))
    .select("id, name");
  if (pErr || !patients) throw pErr ?? new Error("patients insert failed");

  // --- Appointments -----------------------------------------------------
  const future = workingOffsets(1, 4, 1);
  const past = workingOffsets(-1, 2, -1);

  type Plan = {
    p: number;
    d: number;
    off: number;
    time: string;
    status: "pending" | "confirmed" | "cancelled" | "completed" | "no_show";
    reason: string;
  };
  const plan: Plan[] = [
    { p: 0, d: 0, off: future[0], time: "09:30", status: "pending", reason: "Follow-up visit for routine check" },
    { p: 1, d: 1, off: future[0], time: "10:00", status: "confirmed", reason: "Child vaccination schedule" },
    { p: 2, d: 2, off: future[0], time: "11:30", status: "pending", reason: "Skin rash consultation" },
    { p: 3, d: 0, off: future[1], time: "14:00", status: "confirmed", reason: "Annual health check-up" },
    { p: 4, d: 0, off: future[1], time: "15:30", status: "cancelled", reason: "Medication review" },
    { p: 5, d: 1, off: future[2], time: "09:00", status: "pending", reason: "Growth and development check" },
    { p: 0, d: 2, off: future[2], time: "12:00", status: "confirmed", reason: "Acne treatment follow-up" },
    { p: 2, d: 0, off: future[3], time: "10:30", status: "pending", reason: "General consultation" },
    { p: 3, d: 1, off: future[3], time: "16:00", status: "cancelled", reason: "Routine pediatric visit" },
    { p: 1, d: 0, off: past[0], time: "10:00", status: "completed", reason: "Fever follow-up" },
    { p: 4, d: 2, off: past[0], time: "11:00", status: "no_show", reason: "Skin check" },
    { p: 5, d: 0, off: past[1], time: "09:30", status: "completed", reason: "Blood pressure review" },
  ];

  const apptRows = plan.map((x) => {
    const start = istSlot(x.off, x.time);
    return {
      clinic_id: clinic.id,
      ref_code: makeRefCode(),
      patient_id: patients[x.p].id,
      doctor_id: doctors[x.d].id,
      slot_start: start.toISOString(),
      slot_end: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
      reason: x.reason,
      status: x.status,
      source: "chat",
    };
  });
  const { error: aErr } = await db.from("appointments").insert(apptRows);
  if (aErr) throw aErr;

  // --- Conversations ----------------------------------------------------
  type Msg = {
    role: "patient" | "ai" | "staff";
    content: string;
    ai_generated?: boolean;
    review_status?: "draft" | "approved" | "sent";
  };
  const convos: {
    patient: number | null;
    status: "open" | "awaiting_staff" | "resolved";
    urgent?: boolean;
    messages: Msg[];
  }[] = [
    {
      patient: 0,
      status: "resolved",
      messages: [
        { role: "patient", content: "Hi, I'd like to book an appointment." },
        {
          role: "ai",
          ai_generated: true,
          content: "Happy to help! May I have your name and the reason for your visit?",
        },
        { role: "patient", content: "Aarav Sharma, a follow-up visit for a routine check." },
        {
          role: "ai",
          ai_generated: true,
          content: "Thanks, Aarav. Here are the next available slots. Please pick one.",
        },
      ],
    },
    {
      patient: 3,
      status: "awaiting_staff",
      messages: [
        { role: "patient", content: "Do you accept walk-ins on Saturdays, and is parking available?" },
        {
          role: "ai",
          ai_generated: true,
          review_status: "draft",
          content:
            "Thanks for asking. Our Saturday hours are 9:00 AM to 5:00 PM. I'm not certain about walk-ins or parking, so a staff member will confirm.",
        },
      ],
    },
    {
      patient: null,
      status: "awaiting_staff",
      urgent: true,
      messages: [
        { role: "patient", content: "I have severe chest pain and trouble breathing." },
        {
          role: "ai",
          ai_generated: true,
          content:
            "This may be an emergency. Please call your local emergency number right now or go to the nearest emergency department. I'm an administrative assistant and cannot assess symptoms. A staff member has been alerted.",
        },
      ],
    },
    {
      patient: 4,
      status: "awaiting_staff",
      messages: [
        { role: "patient", content: "Can I get a copy of my previous visit summary sent to me?" },
        {
          role: "ai",
          ai_generated: true,
          review_status: "draft",
          content:
            "Thanks for your request. Records requests are handled by our staff, who will review this and get back to you.",
        },
      ],
    },
  ];

  for (const c of convos) {
    const { data: conv, error: cErr } = await db
      .from("conversations")
      .insert({
        clinic_id: clinic.id,
        patient_id: c.patient === null ? null : patients[c.patient].id,
        status: c.status,
        urgent: c.urgent ?? false,
      })
      .select("id")
      .single();
    if (cErr || !conv) throw cErr ?? new Error("conversation insert failed");

    // Insert sequentially with increasing timestamps so ordering is stable.
    const base = Date.now() - c.messages.length * 60_000;
    const { error: mErr } = await db.from("messages").insert(
      c.messages.map((m, i) => ({
        conversation_id: conv.id,
        clinic_id: clinic.id,
        role: m.role,
        content: m.content,
        ai_generated: m.ai_generated ?? m.role === "ai",
        review_status: m.review_status ?? "sent",
        created_at: new Date(base + i * 60_000).toISOString(),
      }))
    );
    if (mErr) throw mErr;
  }

  console.log("\nSeed complete. Demo logins (password from DEMO_PASSWORD):");
  for (const l of logins) console.log(`  ${l.role.padEnd(7)} ${l.email}`);
  console.log(`  password: ${PASSWORD}`);
}

main().catch((e) => {
  console.error("Seed failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
