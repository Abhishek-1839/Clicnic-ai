export const INTENTS = [
  "book",
  "reschedule",
  "cancel",
  "status",
  "faq",
  "urgent",
  "greeting",
  "other",
] as const;
export type Intent = (typeof INTENTS)[number];

export const TIMES_OF_DAY = ["morning", "afternoon", "evening"] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

/** What we pull out of a patient message. Anything not stated is null. Times are NEVER resolved by the LLM. */
export type Extraction = {
  patient_name: string | null;
  reason: string | null;
  doctor_preference: string | null; // a doctor's name or specialty, exactly as the patient said it
  date_hint: string | null; // raw phrase such as "tomorrow" or "next Tuesday"; code does the date math
  time_of_day: TimeOfDay | null;
  ref_code: string | null; // e.g. APT-4F7K
};

export type Analysis = {
  intent: Intent;
  confidence: number; // 0..1
  extraction: Extraction;
};

/** Where an answer came from. "rules" = deterministic fallback or safety layer (no LLM). */
export type Provider = "xai" | "gemini" | "rules";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type Attempt = {
  provider: "xai" | "gemini";
  ok: boolean;
  status?: number;
  error?: string;
  latencyMs: number;
};

/** One row for the ai_events table. */
export type AiEvent = {
  provider: Provider;
  intent: Intent | null;
  extracted: Extraction | null;
  latencyMs: number;
  error: string | null;
};

export const EMPTY_EXTRACTION: Extraction = {
  patient_name: null,
  reason: null,
  doctor_preference: null,
  date_hint: null,
  time_of_day: null,
  ref_code: null,
};
