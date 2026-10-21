// Shared helpers for the seed / add-clinic scripts. Run with tsx (see package.json).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Fill in .env.local first."
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type DoctorSeed = { name: string; specialty: string };

export const DEFAULT_DOCTORS: DoctorSeed[] = [
  { name: "Dr. Meera Rao", specialty: "General Medicine" },
  { name: "Dr. Arjun Nair", specialty: "Pediatrics" },
  { name: "Dr. Sana Iqbal", specialty: "Dermatology" },
];

export function defaultFaq(clinicName: string) {
  return {
    about: `${clinicName} is a fictional demo clinic. All data is synthetic.`,
    hours: "Monday to Saturday, 9:00 AM to 5:00 PM (IST). Closed on Sundays.",
    location: "12 Demo Street, Sample City (fictional address).",
    services: ["General Medicine", "Pediatrics", "Dermatology"],
    appointment_policy:
      "Appointments are 30 minutes. Requests are confirmed by clinic staff, usually within one business day.",
    cancellation_policy:
      "Please cancel or reschedule at least 4 hours before your appointment so the slot can be offered to others.",
    contact: "For non-urgent questions, message us here. A staff member will review and reply.",
    emergencies:
      "This chat is for administrative help only. In an emergency, call your local emergency number immediately.",
  };
}

/** Create the auth user, or reuse (and reset the password of) an existing one. Returns the user id. */
export async function ensureUser(
  db: SupabaseClient,
  email: string,
  password: string,
  fullName: string
): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (data?.user) return data.user.id;

  if (error && /already|registered|exists/i.test(error.message)) {
    for (let page = 1; page <= 20; page++) {
      const { data: list, error: listErr } = await db.auth.admin.listUsers({ page, perPage: 200 });
      if (listErr) throw listErr;
      const found = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (found) {
        const { error: updErr } = await db.auth.admin.updateUserById(found.id, { password });
        if (updErr) throw updErr;
        return found.id;
      }
      if (list.users.length < 200) break;
    }
  }
  throw error ?? new Error(`Could not create user ${email}`);
}

export type ClinicRow = { id: string; name: string; slug: string };
export type DoctorRow = { id: string; name: string; specialty: string };

/** Insert a clinic and its doctors. Every clinic gets its own isolated data via clinic_id. */
export async function createClinic(
  db: SupabaseClient,
  opts: { name: string; slug: string; doctors?: DoctorSeed[]; timezone?: string }
): Promise<{ clinic: ClinicRow; doctors: DoctorRow[] }> {
  const { data: clinic, error } = await db
    .from("clinics")
    .insert({
      name: opts.name,
      slug: opts.slug,
      timezone: opts.timezone ?? "Asia/Kolkata",
      faq_kb: defaultFaq(opts.name),
    })
    .select("id, name, slug")
    .single();
  if (error || !clinic) throw error ?? new Error("Failed to create clinic");

  const docs = opts.doctors && opts.doctors.length > 0 ? opts.doctors : DEFAULT_DOCTORS;
  const { data: doctors, error: docErr } = await db
    .from("doctors")
    .insert(docs.map((d) => ({ clinic_id: clinic.id, name: d.name, specialty: d.specialty })))
    .select("id, name, specialty");
  if (docErr || !doctors) throw docErr ?? new Error("Failed to create doctors");

  return { clinic: clinic as ClinicRow, doctors: doctors as DoctorRow[] };
}

/** Create (or update) a staff login and attach it to a clinic with a role. */
export async function createStaffUser(
  db: SupabaseClient,
  opts: {
    clinicId: string;
    email: string;
    password: string;
    fullName: string;
    role: "admin" | "staff" | "doctor";
    doctorId?: string;
  }
): Promise<string> {
  const userId = await ensureUser(db, opts.email, opts.password, opts.fullName);
  const { error } = await db.from("profiles").upsert({
    id: userId,
    clinic_id: opts.clinicId,
    role: opts.role,
    full_name: opts.fullName,
    doctor_id: opts.role === "doctor" ? opts.doctorId ?? null : null,
  });
  if (error) throw error;
  return userId;
}

const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function makeRefCode(): string {
  let s = "APT-";
  for (let i = 0; i < 4; i++) s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  return s;
}

/** Slot start for (IST day offset from today, "HH:MM"). Demo data only supports Asia/Kolkata. */
export function istSlot(dayOffset: number, hhmm: string): Date {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const d = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + dayOffset)
  );
  const ymd = d.toISOString().slice(0, 10);
  return new Date(`${ymd}T${hhmm}:00+05:30`);
}

export function isIstSunday(dayOffset: number): boolean {
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const d = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + dayOffset)
  );
  return d.getUTCDay() === 0;
}

/** Pick `count` working-day offsets walking from `start` in direction `step` (+1 / -1), skipping Sundays. */
export function workingOffsets(start: number, count: number, step: 1 | -1): number[] {
  const out: number[] = [];
  let off = start;
  while (out.length < count) {
    if (!isIstSunday(off)) out.push(off);
    off += step;
  }
  return out;
}
