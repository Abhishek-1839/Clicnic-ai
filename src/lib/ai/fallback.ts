// Deterministic intent + extraction used when no LLM is reachable (or its output is invalid).
// It keeps the booking flow usable: the chat can still ask for name/reason and show slot buttons.
import { detectEmergency } from "../safety/emergency";
import { EMPTY_EXTRACTION, type Analysis, type Extraction, type TimeOfDay } from "./types";

const DAY_WORDS =
  "today|tomorrow|day after tomorrow|tonight|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday";

export function extractRefCode(text: string): string | null {
  const m = text.match(/\bAPT[-\s]?([A-Z0-9]{4})\b/i);
  return m ? `APT-${m[1].toUpperCase()}` : null;
}

function extractName(text: string): string | null {
  const m = text.match(/(?:[Mm]y name is|[Ii] am|[Ii]'m|[Tt]his is|[Nn]ame:)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})/);
  return m ? m[1].trim() : null;
}

function extractTimeOfDay(text: string): TimeOfDay | null {
  const t = text.toLowerCase();
  if (/\bmorning\b/.test(t)) return "morning";
  if (/\bafternoon\b/.test(t)) return "afternoon";
  if (/\b(evening|late)\b/.test(t)) return "evening";
  return null;
}

function extractDateHint(text: string): string | null {
  const m = text.match(new RegExp(`\\b(next\\s+(?:${DAY_WORDS})|${DAY_WORDS})\\b`, "i"));
  return m ? m[1].toLowerCase() : null;
}

function extractDoctor(text: string): string | null {
  const dr = text.match(/\bDr\.?\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
  if (dr) return `Dr. ${dr[1]}`;
  const spec = text.match(/\b(general medicine|general physician|pediatric\w*|paediatric\w*|dermatolog\w*|skin doctor)\b/i);
  return spec ? spec[1].toLowerCase() : null;
}

function extractReason(text: string): string | null {
  const m = text.match(/\b(?:for|about|regarding|because of|due to)\s+(.{3,80}?)(?:[.,;!?]|$)/i);
  if (!m) return null;
  const reason = m[1].trim();
  // "appointment for tomorrow" is a date, not a reason.
  if (new RegExp(`^(${DAY_WORDS}|next\\s|the\\s+(morning|afternoon|evening))`, "i").test(reason)) return null;
  return reason;
}

export function ruleBasedAnalysis(text: string): Analysis {
  const extraction: Extraction = {
    ...EMPTY_EXTRACTION,
    patient_name: extractName(text),
    reason: extractReason(text),
    doctor_preference: extractDoctor(text),
    date_hint: extractDateHint(text),
    time_of_day: extractTimeOfDay(text),
    ref_code: extractRefCode(text),
  };

  if (detectEmergency(text).urgent) return { intent: "urgent", confidence: 1, extraction };

  const t = text.toLowerCase();
  let intent: Analysis["intent"] = "other";
  if (/\b(re-?schedul\w*|change (my )?(appointment|booking|slot|time)|move (my )?(appointment|booking)|different (time|day|slot))\b/.test(t)) {
    intent = "reschedule";
  } else if (/\b(cancel\w*|call off)\b/.test(t)) {
    intent = "cancel";
  } else if (/\b(status|is my (appointment|booking)|check (on )?my (appointment|booking)|confirmed yet)\b/.test(t)) {
    intent = "status";
  } else if (/\b(book\w*|appointment|schedule|see (a|the|dr)|consult\w*|visit|slot)\b/.test(t)) {
    intent = "book";
  } else if (
    /\?|\b(hours?|open|timings?|location|address|parking|fees?|cost|price|insurance|accept|walk[- ]?ins?)\b/.test(t)
  ) {
    intent = "faq";
  } else if (/^\s*(hi|hello|hey|good (morning|afternoon|evening)|namaste)\b/.test(t) && t.length < 40) {
    intent = "greeting";
  }

  return { intent, confidence: intent === "other" ? 0.3 : 0.6, extraction };
}
