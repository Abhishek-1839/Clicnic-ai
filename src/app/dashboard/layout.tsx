import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name, clinic_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) redirect("/login?error=forbidden");

  const { data: clinic } = await supabase.from("clinics").select("name").eq("id", profile.clinic_id).maybeSingle();
  const links = [
    { href: "/dashboard", label: "Overview" },
    { href: "/dashboard/appointments", label: "Appointments" },
    ...(profile.role !== "doctor" ? [{ href: "/dashboard/inquiries", label: "Patient messages" }] : []),
    ...(profile.role === "admin" ? [{ href: "/dashboard/admin", label: "Admin" }] : []),
  ];

  return (
    <div className="min-h-screen">
      <AutoRefresh />
      <header className="bg-white/70 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <p className="eyebrow">Care team</p>
            <p className="font-medium text-slate-900">{clinic?.name ?? "Clinic"}</p>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className="rounded-full px-4 py-1.5 text-slate-600 hover:bg-teal-50 hover:text-teal-700">
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm text-slate-600">
            <span>
              {profile.full_name || user.email}
              <span className="ml-2 rounded-full bg-teal-50 px-2 py-0.5 text-xs capitalize text-teal-700">{profile.role}</span>
            </span>
            <form action="/auth/signout" method="post">
              <button type="submit" className="text-teal-700 hover:underline">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>
    </div>
  );
}
