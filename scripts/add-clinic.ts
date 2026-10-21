// Onboard another clinic with its own isolated data, doctors and admin login.
//
// Usage:
//   npm run add-clinic -- --name "Lotus Health" --slug lotus-health \
//     --admin-email admin@lotus.example.com --admin-password "ChangeMe#123" \
//     [--admin-name "Asha Admin"] \
//     [--doctors "Dr. A One:General Medicine,Dr. B Two:Pediatrics"]
//
// If --doctors is omitted, three default doctors are created.
import { adminClient, createClinic, createStaffUser, DEFAULT_DOCTORS, type DoctorSeed } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseDoctors(raw: string | undefined): DoctorSeed[] {
  if (!raw) return DEFAULT_DOCTORS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, specialty] = s.split(":").map((p) => p.trim());
      if (!name || !specialty) throw new Error(`Bad --doctors entry "${s}". Use "Name:Specialty".`);
      return { name, specialty };
    });
}

async function main() {
  const name = arg("name");
  const slug = arg("slug");
  const email = arg("admin-email");
  const password = arg("admin-password");
  if (!name || !slug || !email || !password) {
    throw new Error("Required: --name, --slug, --admin-email, --admin-password");
  }
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("--slug must be lowercase letters, numbers and hyphens.");
  if (password.length < 8) throw new Error("--admin-password must be at least 8 characters.");

  const db = adminClient();
  const { clinic, doctors } = await createClinic(db, { name, slug, doctors: parseDoctors(arg("doctors")) });
  await createStaffUser(db, {
    clinicId: clinic.id,
    email,
    password,
    fullName: arg("admin-name") ?? "Clinic Admin",
    role: "admin",
  });

  console.log(`Created clinic "${clinic.name}" (${clinic.slug}) with ${doctors.length} doctors.`);
  console.log(`Admin login: ${email}`);
}

main().catch((e) => {
  console.error("add-clinic failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
