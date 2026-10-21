// The AI workflow entry points used by the chat API (phase 3).
//
// analyzeMessage: emergency rules -> LLM (validated, one repair retry) -> rules fallback.
// answerFaq:      LLM answers ONLY from the clinic knowledge base; anything else goes to staff.
import { complete, LlmUnavailableError } from "./llm";
import { ruleBasedAnalysis } from "./fallback";
import { ANALYZE_SYSTEM, FAQ_SYSTEM } from "./prompts";
import { parseAnalysis, parseFaq } from "./schemas";
import type { AiEvent, Analysis, Attempt, ChatMessage, Provider } from "./types";
import { detectEmergency, type EmergencyKind } from "../safety/emergency";
import { asksForClinicalAdvice, looksLikeClinicalAdvice } from "../safety/medical";
import { EMPTY_EXTRACTION } from "./types";

const MAX_INPUT_CHARS = 1000;

export type AnalyzeResult = {
  analysis: Analysis;
  provider: Provider;
  latencyMs: number;
  attempts: Attempt[];
  emergency: EmergencyKind | null;
  /** Patient asked for clinical advice: do not answer, hand to staff. */
  needsClinician: boolean;
  event: AiEvent;
};

export async function analyzeMessage(rawText: string): Promise<AnalyzeResult> {
  const started = Date.now();
  const text = rawText.slice(0, MAX_INPUT_CHARS);
  const needsClinician = asksForClinicalAdvice(text);

  const finish = (
    analysis: Analysis,
    provider: Provider,
    attempts: Attempt[],
    emergency: EmergencyKind | null,
    error: string | null
  ): AnalyzeResult => {
    const latencyMs = Date.now() - started;
    return {
      analysis,
      provider,
      latencyMs,
      attempts,
      emergency,
      needsClinician,
      event: { provider, intent: analysis.intent, extracted: analysis.extraction, latencyMs, error },
    };
  };

  // 1) Safety first: deterministic, no LLM involved.
  const em = detectEmergency(text);
  if (em.urgent) {
    return finish(
      { intent: "urgent", confidence: 1, extraction: { ...EMPTY_EXTRACTION } },
      "rules",
      [],
      em.kind,
      null
    );
  }

  // 2) LLM with validation and one repair retry.
  const messages: ChatMessage[] = [
    { role: "system", content: ANALYZE_SYSTEM },
    { role: "user", content: text },
  ];
  const attempts: Attempt[] = [];

  try {
    let result = await complete(messages, { json: true });
    attempts.push(...result.attempts);
    let parsed = parseAnalysis(result.text);

    if (!parsed.ok) {
      const repair: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: result.text.slice(0, 600) },
        {
          role: "user",
          content: `Your previous output was invalid: ${parsed.error} Return ONLY the corrected JSON object.`,
        },
      ];
      result = await complete(repair, { json: true });
      attempts.push(...result.attempts);
      parsed = parseAnalysis(result.text);
    }

    if (parsed.ok) {
      const analysis = parsed.value;
      // The model must not downgrade a rule-detected reference code or invent an urgent flag.
      if (analysis.intent === "urgent") analysis.intent = "other"; // rules already handled real emergencies
      return finish(analysis, result.provider, attempts, null, null);
    }
    const fb = ruleBasedAnalysis(text);
    return finish(fb, "rules", attempts, null, `invalid LLM output: ${parsed.error}`);
  } catch (e) {
    const err = e instanceof LlmUnavailableError ? e : null;
    if (err) attempts.push(...err.attempts);
    const fb = ruleBasedAnalysis(text);
    return finish(fb, "rules", attempts, null, e instanceof Error ? e.message : "llm failure");
  }
}

export type FaqResult = {
  answerable: boolean;
  answer: string;
  provider: Provider;
  latencyMs: number;
  event: AiEvent;
};

/** Answer from the clinic KB only. If unsure, or the question is clinical, answerable=false -> staff review queue. */
export async function answerFaq(rawText: string, kb: unknown): Promise<FaqResult> {
  const started = Date.now();
  const text = rawText.slice(0, MAX_INPUT_CHARS);

  const done = (answerable: boolean, answer: string, provider: Provider, error: string | null): FaqResult => ({
    answerable,
    answer,
    provider,
    latencyMs: Date.now() - started,
    event: {
      provider,
      intent: "faq",
      extracted: null,
      latencyMs: Date.now() - started,
      error,
    },
  });

  if (asksForClinicalAdvice(text)) return done(false, "", "rules", null);

  try {
    const result = await complete(
      [
        { role: "system", content: FAQ_SYSTEM + JSON.stringify(kb ?? {}) },
        { role: "user", content: text },
      ],
      { json: true }
    );
    const parsed = parseFaq(result.text);
    if (!parsed) return done(false, "", result.provider, "invalid FAQ output");
    if (!parsed.answerable || !parsed.answer.trim()) return done(false, "", result.provider, null);
    if (looksLikeClinicalAdvice(parsed.answer)) return done(false, "", result.provider, "blocked: clinical advice");
    return done(true, parsed.answer.trim(), result.provider, null);
  } catch (e) {
    return done(false, "", "rules", e instanceof Error ? e.message : "llm failure");
  }
}
