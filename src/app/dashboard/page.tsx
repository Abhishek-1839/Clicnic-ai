import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { StatCard } from "@/components/StatCard";
import { StatusBadge } from "@/components/StatusBadge";
import { formatSlot } from "@/lib/booking/time";
import type { Status } from "@/lib/dashboard/transitions";

export const dynamic = "force-dynamic";

async function count(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: "appointments" | "conversations",
  filter?: { column: string; value: string }
) {
  let q = supabase.from(table).select("*", { count: "exact", head: true });
  if (filter) q = q.eq(filter.column, filter.value);
  const { count: n } = await q;
  return n ?? 0;
}

function greeting() {
  const h = (new Date().getUTCHours() + 5.5) % 24; // IST
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase.from("profiles").select("full_name, role").eq("id", user!.id).maybeSingle();

  // RLS scopes every query to the signed-in user's clinic (and, for doctors, their own appointments).
  const [total, pending, confirmed, cancelled, awaiting, urgent, { data: next }] = await Promise.all([
    count(supabase, "appointments"),
    count(supabase, "appointments", { column: "status", value: "pending" }),
    count(supabase, "appointments", { column: "status", value: "confirmed" }),
    count(supabase, "appointments", { column: "status", value: "cancelled" }),
    count(supabase, "conversations", { column: "status", value: "awaiting_staff" }),
    count(supabase, "conversations", { column: "urgent", value: "true" }),
    supabase
      .from("appointments")
      .select("id, ref_code, status, slot_start, reason, patients(name), doctors(name)")
      .eq("status", "pending")
      .order("slot_start", { ascending: true })
      .limit(4),
  ]);

  const first = (profile?.full_name ?? "").split(" ")[0];
  const canMessage = profile?.role !== "doctor";

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="eyebrow">Today at a glance</p>
        <h1 className="mt-1 text-3xl font-light text-slate-900">
          {greeting()}
          {first ? `, ${first}` : ""}.
        </h1>
        <p className="mt-1 text-slate-600">
          {pending + awaiting === 0
            ? "Everything is up to date. Nothing needs your attention right now."
            : `A few things are waiting for you: ${pending} request${pending === 1 ? "" : "s"} to confirm and ${awaiting} message${awaiting === 1 ? "" : "s"} to answer.`}
        </p>
      </div>

      {urgent > 0 && canMessage && (
        <Link
          href="/dashboard/inquiries"
          role="alert"
          className="card flex items-center justify-between gap-3 border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900"
        >
          <span>
            {urgent === 1 ? "A patient has" : `${urgent} patients have`} mentioned something urgent. Please take a look
            when you can.
          </span>
          <span className="font-medium">Open &rarr;</span>
        </Link>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="All appointments" value={total} />
        <StatCard label="Awaiting confirmation" value={pending} tone="amber" />
        <StatCard label="Confirmed" value={confirmed} tone="green" />
        <StatCard label="Cancelled" value={cancelled} tone="red" />
        <StatCard label="Messages to answer" value={awaiting} tone="blue" />
      </div>

      <section>
        <div className="mb-3 flex items-end justify-between">
          <div>
            <p className="eyebrow">Next up</p>
            <h2 className="text-xl font-light">Requests waiting for a yes</h2>
          </div>
          <Link href="/dashboard/appointments" className="text-sm text-teal-700 hover:underline">
            See all appointments
          </Link>
        </div>
        {!next || next.length === 0 ? (
          <div className="card p-6 text-slate-600">No requests are waiting. Enjoy the quiet moment.</div>
        ) : (
          <ul className="flex flex-col gap-3">
            {next.map((a) => {
              const p = Array.isArray(a.patients) ? a.patients[0] : a.patients;
              const d = Array.isArray(a.doctors) ? a.doctors[0] : a.doctors;
              return (
                <li key={a.id} className="card flex flex-wrap items-center justify-between gap-2 px-5 py-4">
                  <div>
                    <p className="font-medium">{p?.name ?? "Patient"}</p>
                    <p className="text-sm text-slate-600">
                      {formatSlot(new Date(a.slot_start))} · {d?.name}
                    </p>
                  </div>
                  <StatusBadge status={a.status as Status} />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
