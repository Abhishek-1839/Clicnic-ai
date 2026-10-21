import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiEvent } from "./types";

/** Persist an AI event. Never throws: logging must not break the patient's chat. */
export async function logAiEvent(
  db: SupabaseClient,
  ctx: { clinicId: string; conversationId?: string | null },
  event: AiEvent
): Promise<void> {
  try {
    const { error } = await db.from("ai_events").insert({
      clinic_id: ctx.clinicId,
      conversation_id: ctx.conversationId ?? null,
      provider: event.provider,
      intent: event.intent,
      extracted: event.extracted,
      latency_ms: event.latencyMs,
      error: event.error,
    });
    if (error) console.error("ai_events insert failed:", error.message);
  } catch (e) {
    console.error("ai_events insert threw:", e instanceof Error ? e.message : e);
  }
}
