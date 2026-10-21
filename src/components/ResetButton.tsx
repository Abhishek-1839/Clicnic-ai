"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ResetButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function reset() {
    if (!window.confirm("Replace all sample appointments, patients and messages with a fresh set?")) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/dashboard/admin/reset", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(res.ok ? "Sample data refreshed." : (data.error ?? "Reset failed."));
      if (res.ok) router.refresh();
    } catch {
      setMsg("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button onClick={reset} disabled={busy} className="rounded-full bg-teal-600 px-5 py-2 text-sm text-white hover:bg-teal-700 disabled:opacity-50">
        {busy ? "Refreshing…" : "Reset demo data"}
      </button>
      {msg && <span className="text-sm text-slate-600">{msg}</span>}
    </div>
  );
}
