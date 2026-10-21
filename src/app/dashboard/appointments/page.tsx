import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AppointmentActions } from "@/components/AppointmentActions";
import { StatusBadge } from "@/components/StatusBadge";
import { formatSlot } from "@/lib/booking/time";
import { STATUSES, STATUS_LABEL, type Role, type Status } from "@/lib/dashboard/transitions";

export const dynamic = "force-dynamic";

export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const filter = STATUSES.includes(status as Status) ? (status as Status) : null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user!.id).maybeSingle();
  const role = (profile?.role ?? "staff") as Role;

  let q = supabase
    .from("appointments")
    .select("id, ref_code, status, slot_start, reason, patients(name), doctors(name, specialty)")
    .order("slot_start", { ascending: true })
    .limit(100);
  if (filter) q = q.eq("status", filter);
  const { data: rows } = await q;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="eyebrow">Schedule</p>
        <h1 className="mt-1 text-3xl font-light">Appointments</h1>
        <p className="text-slate-600">
          {role === "doctor" ? "Your patients, in time order." : "Confirm requests and keep the day running smoothly."}
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {[{ key: null, label: "All" }, ...STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s] }))].map((f) => (
          <Link
            key={f.label}
            href={f.key ? `/dashboard/appointments?status=${f.key}` : "/dashboard/appointments"}
            className={`rounded-full px-4 py-1.5 ${
              filter === f.key ? "bg-teal-600 text-white" : "bg-white text-slate-600 hover:bg-teal-50"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {!rows || rows.length === 0 ? (
        <div className="card p-8 text-center text-slate-600">Nothing here right now.</div>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((a) => {
            const p = Array.isArray(a.patients) ? a.patients[0] : a.patients;
            const d = Array.isArray(a.doctors) ? a.doctors[0] : a.doctors;
            return (
              <li key={a.id} className="card flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{p?.name ?? "Patient"}</p>
                    <StatusBadge status={a.status as Status} />
                  </div>
                  <p className="text-sm text-slate-600">
                    {formatSlot(new Date(a.slot_start))} · {d?.name} ({d?.specialty})
                  </p>
                  {a.reason && <p className="text-sm text-slate-500">Reason: {a.reason}</p>}
                  <p className="text-xs text-slate-500">Ref {a.ref_code}</p>
                </div>
                <AppointmentActions id={a.id} status={a.status as Status} role={role} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
