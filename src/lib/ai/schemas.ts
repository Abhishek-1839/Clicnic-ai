import { z } from "zod";
import { INTENTS, TIMES_OF_DAY, type Analysis } from "./types";

// Models sometimes return "" or "null" strings for missing values; normalise those to null.
const nullableText = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null) return null;
    const s = v.trim();
    return s === "" || s.toLowerCase() === "null" || s.toLowerCase() === "none" ? null : s.slice(0, 200);
  });

const timeOfDay = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const s = (v ?? "").toString().trim().toLowerCase();
    return (TIMES_OF_DAY as readonly string[]).includes(s) ? (s as (typeof TIMES_OF_DAY)[number]) : null;
  });

export const analysisSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1).catch(0.5),
  extraction: z
    .object({
      patient_name: nullableText,
      reason: nullableText,
      doctor_preference: nullableText,
      date_hint: nullableText,
      time_of_day: timeOfDay,
      ref_code: nullableText,
    })
    .default({
      patient_name: null,
      reason: null,
      doctor_preference: null,
      date_hint: null,
      time_of_day: null,
      ref_code: null,
    }),
});

export const faqSchema = z.object({
  answerable: z.boolean(),
  answer: z.string().max(800).default(""),
});

/** Parse model text into a validated Analysis, or return a short error string for the repair prompt. */
export function parseAnalysis(raw: string): { ok: true; value: Analysis } | { ok: false; error: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(stripFence(raw));
  } catch {
    return { ok: false, error: "Output was not valid JSON." };
  }
  const r = analysisSchema.safeParse(obj);
  if (!r.success) {
    return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) };
  }
  return { ok: true, value: r.data as Analysis };
}

export function parseFaq(raw: string): { answerable: boolean; answer: string } | null {
  try {
    const r = faqSchema.safeParse(JSON.parse(stripFence(raw)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function stripFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}
