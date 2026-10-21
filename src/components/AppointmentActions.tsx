"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { allowedNext, STATUS_LABEL, type Role, type Status } from "@/lib/dashboard/transitions";

const VERB: Partial<Record<Status, string>> = {
  confirmed: "Confirm",
  cancelled: "Cancel",
  completed: "Mark completed",
  no_show: "Did not attend",
};

export function AppointmentActions({ id, status, role }: { id: string; status: Status; role: Role }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Status | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const options = allowedNext(role, status);
  if (options.length === 0) return null;

  async function go(to: Status) {
    if (to === "cancelled" && !window.confirm("Cancel this appointment? The patient will be notified.")) return;
    setBusy(to);
    setMsg(null);
    try {
      const res = await fetch(`/api/dashboard/appointments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: to }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setMsg(data.error ?? "Something went wrong.");
      else router.refresh();
    } catch {
      setMsg("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        {options.map((to) => (
          <button
            key={to}
            onClick={() => go(to)}
            disabled={busy !== null}
            aria-label={`${VERB[to] ?? STATUS_LABEL[to]}`}
            className={`rounded-full px-4 py-1.5 text-sm disabled:opacity-50 ${
              to === "confirmed" ? "bg-teal-600 text-white hover:bg-teal-700" : "border border-slate-300 text-slate-700 hover:bg-slate-50"
            }`}
          >
            {busy === to ? "Saving…" : (VERB[to] ?? STATUS_LABEL[to])}
          </button>
        ))}
      </div>
      {msg && <p className="text-xs text-rose-700">{msg}</p>}
    </div>
  );
}
