import { allow, clientKey } from "@/lib/ratelimit";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAiEvent } from "@/lib/ai/log";
import { handleTurn, INITIAL_STATE, type ChatState } from "@/lib/booking/engine";
import { makeDeps, type StoreCtx } from "@/lib/booking/store";
import type { Action } from "@/lib/booking/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TURNS = 60;

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("intent"),
    intent: z.enum(["book", "reschedule", "cancel", "status", "faq", "staff"]),
  }),
  z.object({ type: z.literal("doctor"), doctorId: z.string().min(1).max(40) }),
  z.object({ type: z.literal("slot"), index: z.number().int().min(0).max(9) }),
  z.object({ type: z.literal("confirm"), yes: z.boolean() }),
  z.object({ type: z.literal("restart") }),
]);

const bodySchema = z
  .object({
    conversationId: z.string().uuid().nullish(),
    clinic: z.string().regex(/^[a-z0-9-]{1,60}$/).nullish(),
    message: z.string().max(1000).nullish(),
    action: actionSchema.nullish(),
  })
  .refine((b) => (b.message ?? "").trim().length > 0 || !!b.action, { message: "Send a message or an action." });

type Conv = { id: string; clinic_id: string; state: Record<string, unknown> | null; status: string };

function clinicSlug(requested: string | null | undefined): string {
  return requested || process.env.DEFAULT_CLINIC_SLUG || "sunrise-demo";
}

function coerceState(raw: Record<string, unknown> | null): ChatState {
  const { _ui, ...rest } = (raw ?? {}) as Record<string, unknown>;
  void _ui;
  return { ...INITIAL_STATE, ...(rest as Partial<ChatState>) };
}

async function snapshot(db: ReturnType<typeof createAdminClient>, conv: Conv) {
  const { data: messages } = await db
    .from("messages")
    .select("id, role, content, ai_generated, created_at")
    .eq("conversation_id", conv.id)
    .eq("review_status", "sent")
    .order("created_at", { ascending: true })
    .limit(200);
  const state = coerceState(conv.state);
  return {
    conversationId: conv.id,
    messages: messages ?? [],
    ui: (conv.state as { _ui?: unknown } | null)?._ui ?? null,
    flowActive: state.step !== null,
    status: conv.status,
  };
}

async function loadClinic(db: ReturnType<typeof createAdminClient>, slug: string) {
  const { data } = await db.from("clinics").select("id, faq_kb").eq("slug", slug).maybeSingle();
  return data as { id: string; faq_kb: unknown } | null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("conversationId") ?? "";
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Bad conversation id." }, { status: 400 });

  const db = createAdminClient();
  const clinic = await loadClinic(db, clinicSlug(url.searchParams.get("clinic")));
  if (!clinic) return NextResponse.json({ error: "Clinic not found." }, { status: 404 });

  const { data: conv } = await db
    .from("conversations")
    .select("id, clinic_id, state, status")
    .eq("id", id)
    .eq("clinic_id", clinic.id)
    .maybeSingle();
  if (!conv) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  return NextResponse.json(await snapshot(db, conv as Conv));
}

export async function POST(req: Request) {
  if (!allow(`chat:${clientKey(req)}`, 40, 60_000)) {
    return NextResponse.json({ error: "You're sending messages very quickly. Please wait a moment and try again." }, { status: 429 });
  }
  let parsed;
  try {
    parsed = bodySchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const body = parsed.data;

  try {
    const db = createAdminClient();
    const clinic = await loadClinic(db, clinicSlug(body.clinic));
    if (!clinic) return NextResponse.json({ error: "Clinic not found." }, { status: 404 });

    // Load or create the conversation. The unguessable conversation id acts as the patient's session key.
    let conv: Conv | null = null;
    if (body.conversationId) {
      const { data } = await db
        .from("conversations")
        .select("id, clinic_id, state, status")
        .eq("id", body.conversationId)
        .eq("clinic_id", clinic.id)
        .maybeSingle();
      conv = data as Conv | null;
      if (!conv) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    } else {
      const { data, error } = await db
        .from("conversations")
        .insert({ clinic_id: clinic.id, state: INITIAL_STATE })
        .select("id, clinic_id, state, status")
        .single();
      if (error || !data) throw new Error(error?.message ?? "could not create conversation");
      conv = data as Conv;
    }

    const state = coerceState(conv.state);
    if (state.turns >= MAX_TURNS) {
      return NextResponse.json(
        { error: "This chat has reached its message limit. Please start a new chat or contact the clinic directly." },
        { status: 429 }
      );
    }

    const ctx: StoreCtx = { patientId: null };
    const deps = makeDeps(db, clinic, ctx);

    // What to store as the patient's side of the transcript.
    const text = (body.message ?? "").trim().slice(0, 500);
    const action = (body.action ?? null) as Action | null;
    const patientText = text || (await actionLabel(action as Action, state, deps));

    const t0 = Date.now();
    const { error: msgErr } = await db.from("messages").insert({
      conversation_id: conv.id,
      clinic_id: clinic.id,
      role: "patient",
      content: patientText,
      ai_generated: false,
      review_status: "sent",
      created_at: new Date(t0).toISOString(),
    });
    if (msgErr) throw new Error(msgErr.message);

    const result = await handleTurn(state, { text: text || null, action }, deps);

    if (result.replies.length > 0) {
      const { error } = await db.from("messages").insert(
        result.replies.map((content, i) => ({
          conversation_id: conv!.id,
          clinic_id: clinic.id,
          role: "ai",
          content,
          ai_generated: true,
          review_status: "sent",
          created_at: new Date(t0 + 1 + i).toISOString(),
        }))
      );
      if (error) throw new Error(error.message);
    }

    const patch: Record<string, unknown> = { state: { ...result.state, _ui: result.ui } };
    if (result.escalate || result.urgent) patch.status = "awaiting_staff";
    if (result.urgent) patch.urgent = true;
    if (ctx.patientId) patch.patient_id = ctx.patientId;
    const { data: updated, error: upErr } = await db
      .from("conversations")
      .update(patch)
      .eq("id", conv.id)
      .select("id, clinic_id, state, status")
      .single();
    if (upErr || !updated) throw new Error(upErr?.message ?? "could not update conversation");

    for (const ev of result.events) await logAiEvent(db, { clinicId: clinic.id, conversationId: conv.id }, ev);

    return NextResponse.json(await snapshot(db, updated as Conv));
  } catch (e) {
    console.error("chat error:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Something went wrong on our side. Please try again in a moment." }, { status: 500 });
  }
}

async function actionLabel(
  a: Action,
  st: ChatState,
  deps: { listDoctors(): Promise<{ id: string; name: string }[]> }
): Promise<string> {
  switch (a.type) {
    case "intent":
      return {
        book: "I'd like to book an appointment",
        reschedule: "I'd like to reschedule an appointment",
        cancel: "I'd like to cancel an appointment",
        status: "I'd like to check my appointment status",
        faq: "I have a question",
        staff: "I'd like to message the clinic staff",
      }[a.intent];
    case "doctor": {
      if (a.doctorId === "any") return "Any available doctor";
      const d = (await deps.listDoctors()).find((x) => x.id === a.doctorId);
      return d ? d.name : "A doctor";
    }
    case "slot": {
      const s = st.offered[a.index];
      return s ? `${s.label} with ${s.doctorName}` : "A time slot";
    }
    case "confirm":
      return a.yes ? "Yes, cancel it" : "No, keep it";
    case "restart":
      return "Start over";
  }
}
