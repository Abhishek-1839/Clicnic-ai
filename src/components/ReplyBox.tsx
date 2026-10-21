"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ReplyBox({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [ai, setAi] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);

  async function draft() {
    setBusy("draft");
    setNote(null);
    try {
      const res = await fetch(`/api/dashboard/conversations/${conversationId}/draft`, { method: "POST" });
      const data = (await res.json()) as { draft?: string; note?: string; error?: string };
      if (data.draft) {
        setText(data.draft);
        setAi(true);
      }
      setNote(data.error ?? data.note ?? null);
    } catch {
      setNote("Couldn't reach the assistant. You can write the reply yourself.");
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    setBusy("send");
    setNote(null);
    try {
      const res = await fetch(`/api/dashboard/conversations/${conversationId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, aiAssisted: ai }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setNote(data.error ?? "Could not send.");
      else {
        setText("");
        setAi(false);
        router.refresh();
      }
    } catch {
      setNote("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={1000}
        placeholder="Write a kind, clear reply…"
        aria-label="Reply to patient"
        className="w-full rounded-xl border border-slate-300 bg-white p-3 text-sm outline-none focus:border-teal-500"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={draft}
          disabled={busy !== null}
          className="rounded-full border border-slate-300 px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy === "draft" ? "Drafting…" : "Suggest a reply"}
        </button>
        <button
          onClick={send}
          disabled={busy !== null || !text.trim()}
          className="rounded-full bg-teal-600 px-4 py-1.5 text-sm text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy === "send" ? "Sending…" : "Send to patient"}
        </button>
        {ai && <span className="text-xs text-slate-500">AI-suggested: please review before sending.</span>}
      </div>
      {note && <p className="text-xs text-slate-600">{note}</p>}
    </div>
  );
}
