import { createClient } from "@/lib/supabase/server";
import { ResetButton } from "@/components/ResetButton";
import { StatCard } from "@/components/StatCard";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = await createClient();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: events } = await supabase.from("ai_events").select("provider, error").gte("created_at", since).limit(1000);
  const list = events ?? [];
  const by = (p: string) => list.filter((e) => e.provider === p).length;
  const fallbacks = list.filter((e) => e.provider === "rules").length;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="eyebrow">Admin</p>
        <h1 className="mt-1 text-3xl font-light">Settings and demo tools</h1>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-light">Assistant health, last 24 hours</h2>
        <div className="grid gap-4 sm:grid-cols-4">
          <StatCard label="AI replies" value={list.length} />
          <StatCard label="Primary model" value={by("xai")} tone="green" />
          <StatCard label="Backup model" value={by("gemini")} tone="blue" />
          <StatCard label="Simple fallback" value={fallbacks} tone="amber" hint="Used if the AI services are unavailable" />
        </div>
      </section>

      <section className="card flex flex-col gap-3 p-6">
        <h2 className="text-xl font-light">Demo data</h2>
        <p className="text-sm text-slate-600">
          Start a fresh walkthrough. This replaces sample patients, appointments and messages. Staff logins and doctors stay
          as they are. Only available for the demo clinic.
        </p>
        <ResetButton />
      </section>
    </div>
  );
}
