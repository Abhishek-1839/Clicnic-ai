import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ReplyBox } from "@/components/ReplyBox";
import { sortInquiries } from "@/lib/dashboard/transitions";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = { patient: "Patient", ai: "Assistant (AI)", staff: "Clinic team" };

export default async function InquiriesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user!.id).maybeSingle();
  if (profile?.role === "doctor") redirect("/dashboard");

  const { data: convs } = await supabase
    .from("conversations")
    .select("id, urgent, status, updated_at, patients(name)")
    .eq("status", "awaiting_staff")
    .limit(30);
  const queue = sortInquiries(convs ?? []);

  const ids = queue.map((c) => c.id);
  const { data: msgs } = ids.length
    ? await supabase
        .from("messages")
        .select("conversation_id, role, content, created_at, ai_generated")
        .in("conversation_id", ids)
        .eq("review_status", "sent")
        .order("created_at", { ascending: true })
    : { data: [] };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="eyebrow">Patient messages</p>
        <h1 className="mt-1 text-3xl font-light">Messages waiting for you</h1>
        <p className="text-slate-600">Take your time. Urgent ones are shown first.</p>
      </div>

      {queue.length === 0 ? (
        <div className="card p-8 text-center text-slate-600">All caught up. No one is waiting for a reply.</div>
      ) : (
        <ul className="flex flex-col gap-4">
          {queue.map((c) => {
            const p = Array.isArray(c.patients) ? c.patients[0] : c.patients;
            const thread = (msgs ?? []).filter((m) => m.conversation_id === c.id).slice(-6);
            return (
              <li key={c.id} className={`card p-5 ${c.urgent ? "border-amber-300 bg-amber-50/40" : ""}`}>
                <div className="flex items-center justify-between">
                  <p className="font-medium">{p?.name ?? "Patient (not yet named)"}</p>
                  {c.urgent && <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs text-amber-900">Needs a quick look</span>}
                </div>
                <ul className="mt-3 flex flex-col gap-2 text-sm">
                  {thread.map((m, i) => (
                    <li key={i} className={m.role === "patient" ? "" : "pl-4 text-slate-600"}>
                      <span className="text-xs text-slate-500">{ROLE_LABEL[m.role] ?? m.role}: </span>
                      {m.content}
                    </li>
                  ))}
                </ul>
                <ReplyBox conversationId={c.id} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
