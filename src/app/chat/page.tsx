"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Action, ApptView, Ui } from "@/lib/booking/types";

type Msg = { id: string; role: "patient" | "ai" | "staff"; content: string; ai_generated: boolean; created_at: string };
type Snapshot = { conversationId: string; messages: Msg[]; ui: Ui | null; flowActive: boolean; status: string };

const GREETING =
  "Hi! I'm the clinic's virtual assistant (AI). I can help you book, reschedule or cancel an appointment, check a booking's status, or answer questions about the clinic.";

const CHIPS: { label: string; action: Action }[] = [
  { label: "Book an appointment", action: { type: "intent", intent: "book" } },
  { label: "Reschedule", action: { type: "intent", intent: "reschedule" } },
  { label: "Cancel", action: { type: "intent", intent: "cancel" } },
  { label: "Check status", action: { type: "intent", intent: "status" } },
  { label: "Ask a question", action: { type: "intent", intent: "faq" } },
  { label: "Message staff", action: { type: "intent", intent: "staff" } },
];

function store(op: "get" | "set" | "del", key: string, value?: string): string | null {
  try {
    if (op === "get") return sessionStorage.getItem(key);
    if (op === "set") sessionStorage.setItem(key, value ?? "");
    else sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable: the chat still works, it just won't resume after a reload */
  }
  return null;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}

function BookingCard({ appt, headline }: { appt: ApptView; headline: string }) {
  const tone =
    appt.status === "confirmed"
      ? "bg-emerald-100 text-emerald-800"
      : appt.status === "cancelled" || appt.status === "no_show"
        ? "bg-red-100 text-red-800"
        : "bg-amber-100 text-amber-800";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <div className="flex items-center justify-between">
        <p className="font-medium">{headline}</p>
        <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${tone}`}>{appt.status.replace("_", " ")}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-wide">{appt.refCode}</p>
      <p className="text-xs text-slate-500">Save this reference code to reschedule, cancel or check status.</p>
      <dl className="mt-3 grid grid-cols-[5.5rem_1fr] gap-y-1">
        <dt className="text-slate-500">Patient</dt>
        <dd>{appt.patientName}</dd>
        <dt className="text-slate-500">Doctor</dt>
        <dd>{appt.doctorName}</dd>
        <dt className="text-slate-500">When</dt>
        <dd>{fmt(appt.slotStart)} (IST)</dd>
        {appt.reason && (
          <>
            <dt className="text-slate-500">Reason</dt>
            <dd>{appt.reason}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function ChatClient() {
  const clinic = useSearchParams().get("clinic") ?? "";
  const storageKey = `clinic-ai:conv:${clinic || "default"}`;

  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [ui, setUi] = useState<Ui | null>(null);
  const [flowActive, setFlowActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const busyRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  const apply = useCallback(
    (s: Snapshot) => {
      setConvId(s.conversationId);
      store("set", storageKey, s.conversationId);
      setMessages(s.messages);
      setUi(s.ui);
      setFlowActive(s.flowActive);
    },
    [storageKey]
  );

  const query = useCallback(
    (id: string) => `/api/chat?conversationId=${id}${clinic ? `&clinic=${encodeURIComponent(clinic)}` : ""}`,
    [clinic]
  );

  // Resume an earlier conversation on this device.
  useEffect(() => {
    const id = store("get", storageKey);
    if (!id) return;
    fetch(query(id))
      .then(async (r) => {
        if (r.ok) apply(await r.json());
        else store("del", storageKey);
      })
      .catch(() => {});
  }, [storageKey, query, apply]);

  // Poll for staff replies and confirmations (every 4s, and immediately when the tab regains focus).
  useEffect(() => {
    if (!convId) return;
    let stopped = false;
    const check = async () => {
      if (busyRef.current || stopped) return;
      try {
        const r = await fetch(query(convId), { cache: "no-store" });
        if (!r.ok) return;
        const s: Snapshot = await r.json();
        setMessages((prev) => {
          const same = prev.length === s.messages.length && prev[prev.length - 1]?.id === s.messages[s.messages.length - 1]?.id;
          return same ? prev : s.messages;
        });
      } catch {
        /* ignore transient network errors */
      }
    };
    const t = setInterval(check, 4000);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [convId, query]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy, ui]);

  async function send(payload: { message?: string; action?: Action }) {
    busyRef.current = true;
    setBusy(true);
    setError(null);
    if (payload.message) setPending(payload.message);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convId, clinic: clinic || undefined, ...payload }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Something went wrong.");
        if (res.status === 404 && convId) newChat();
        return;
      }
      apply(json as Snapshot);
    } catch {
      setError("Network problem. Please check your connection and try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
      setPending(null);
    }
  }

  function newChat() {
    store("del", storageKey);
    setConvId(null);
    setMessages([]);
    setUi(null);
    setFlowActive(false);
    setError(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void send({ message: text });
  }

  const act = (action: Action) => void send({ action });

  return (
    <main className="mx-auto flex h-[calc(100vh-2rem)] max-w-2xl flex-col px-4 py-4">
      <header className="flex items-center justify-between pb-3">
        <div>
          <h1 className="text-lg font-semibold">Clinic assistant</h1>
          <p className="text-xs text-slate-500">AI replies are labelled. Not for emergencies.</p>
        </div>
        <button onClick={newChat} className="text-sm text-teal-700 hover:underline">
          New chat
        </button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4" aria-live="polite">
        {messages.length === 0 && (
          <div className="max-w-[85%] rounded-2xl bg-slate-100 px-3 py-2 text-sm">
            <p>{GREETING}</p>
            <p className="mt-1 text-[11px] text-slate-500">AI-generated</p>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={m.role === "patient" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                m.role === "patient" ? "bg-teal-700 text-white" : m.role === "staff" ? "bg-sky-100" : "bg-slate-100"
              }`}
            >
              <p>{m.content}</p>
              {m.role !== "patient" && (
                <p className="mt-1 text-[11px] text-slate-500">{m.role === "staff" ? "Clinic staff" : "AI-generated"}</p>
              )}
            </div>
          </div>
        ))}

        {pending && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl bg-teal-700/70 px-3 py-2 text-sm text-white">{pending}</div>
          </div>
        )}
        {busy && <p className="text-xs text-slate-500">Assistant is typing...</p>}

        {!busy && ui?.type === "booking" && <BookingCard appt={ui.appointment} headline={ui.headline} />}

        {!busy && ui?.type === "slots" && (
          <div className="flex flex-wrap gap-2">
            {ui.slots.map((s, i) => (
              <button
                key={s.start + s.doctorId}
                onClick={() => act({ type: "slot", index: i })}
                className="rounded-lg border border-teal-700 px-3 py-1.5 text-left text-sm hover:bg-teal-50"
              >
                <span className="block font-medium">{s.label}</span>
                <span className="block text-xs text-slate-600">{s.doctorName}</span>
              </button>
            ))}
          </div>
        )}

        {!busy && ui?.type === "doctors" && (
          <div className="flex flex-wrap gap-2">
            {ui.doctors.map((d) => (
              <button
                key={d.id}
                onClick={() => act({ type: "doctor", doctorId: d.id })}
                className="rounded-lg border border-teal-700 px-3 py-1.5 text-left text-sm hover:bg-teal-50"
              >
                <span className="block font-medium">{d.name}</span>
                <span className="block text-xs text-slate-600">{d.specialty}</span>
              </button>
            ))}
            <button
              onClick={() => act({ type: "doctor", doctorId: "any" })}
              className="rounded-lg border border-slate-400 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Any available doctor
            </button>
          </div>
        )}

        {!busy && ui?.type === "confirm" && (
          <div className="flex gap-2">
            <button
              onClick={() => act({ type: "confirm", yes: true })}
              className="rounded-lg bg-red-600 px-4 py-1.5 text-sm text-white hover:bg-red-700"
            >
              Yes, cancel it
            </button>
            <button
              onClick={() => act({ type: "confirm", yes: false })}
              className="rounded-lg border border-slate-400 px-4 py-1.5 text-sm hover:bg-slate-50"
            >
              No, keep it
            </button>
          </div>
        )}

        {!busy && !flowActive && (
          <div className="flex flex-wrap gap-2 pt-1">
            {CHIPS.map((c) => (
              <button
                key={c.label}
                onClick={() => act(c.action)}
                className="rounded-full border border-slate-300 px-3 py-1 text-sm hover:border-teal-700 hover:text-teal-700"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={500}
          disabled={busy}
          placeholder="Type your message..."
          className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
        >
          Send
        </button>
      </form>
      {flowActive && (
        <button onClick={() => act({ type: "restart" })} disabled={busy} className="mt-2 self-start text-xs text-slate-500 hover:underline">
          Start over
        </button>
      )}
    </main>
  );
}

export default function ChatPage() {
  return (
    <Suspense>
      <ChatClient />
    </Suspense>
  );
}
