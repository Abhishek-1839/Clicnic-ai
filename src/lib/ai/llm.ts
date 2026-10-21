// Provider chain: Groq -> Gemini. Plain fetch, no SDKs.
//
// Per provider: a hard timeout, and ONE retry only for network errors / 5xx.
// A 429 (rate limit) is not retried on the same provider; we move straight to the next one.
// If every provider fails we throw LlmUnavailableError and the caller uses the rules fallback.
import type { Attempt, ChatMessage } from "./types";

type ProviderName = "gemini" | "xai";

export type LlmResult = {
  text: string;
  provider: ProviderName;
  model: string;
  latencyMs: number;
  attempts: Attempt[];
};

export class LlmUnavailableError extends Error {
  attempts: Attempt[];
  constructor(attempts: Attempt[]) {
    super(
      attempts.length === 0
        ? "No LLM provider is configured (set GROQ_API_KEY, GEMINI_API_KEY, or XAI_API_KEY + XAI_MODEL)."
        : `All LLM providers failed: ${attempts.map((a) => `${a.provider}:${a.status ?? a.error ?? "error"}`).join(", ")}`
    );
    this.name = "LlmUnavailableError";
    this.attempts = attempts;
  }
}

class ProviderError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    // Network failures (no status) and 5xx are worth one retry. 4xx (incl. 429) are not.
    this.retryable = status === undefined || status >= 500;
  }
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

const TIMEOUT_MS = () => Number(env("LLM_TIMEOUT_MS") ?? 8000);

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new ProviderError(`HTTP ${res.status} ${detail}`, res.status);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new ProviderError(aborted ? "timeout" : e instanceof Error ? e.message : "network error");
  } finally {
    clearTimeout(timer);
  }
}


async function callOpenAiCompatible(
  name: "xai",
  url: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  json: boolean
): Promise<{ text: string; model: string }> {
  const data = (await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 500,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  })) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new ProviderError(`empty response from ${name}`, 502);
  return { text, model };
}
const callXai = (messages: ChatMessage[], json: boolean) =>
  callOpenAiCompatible("xai", "https://api.x.ai/v1/chat/completions", env("XAI_API_KEY")!, env("XAI_MODEL")!, messages, json);


async function callGemini(messages: ChatMessage[], json: boolean): Promise<{ text: string; model: string }> {
  const key = env("GEMINI_API_KEY")!;
  const model = (env("GEMINI_MODEL") ?? "gemini-2.5-flash").replace(/^models\//, "");
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

  const data = (await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 500,
          ...(json ? { responseMimeType: "application/json" } : {}),
        },
      }),
    }
  )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!text) throw new ProviderError("empty response from gemini", 502);
  return { text, model };
}

function configuredProviders(): ProviderName[] {
  const order: ProviderName[] = [];
  if (env("XAI_API_KEY") && env("XAI_MODEL")) order.push("xai");
  if (env("GEMINI_API_KEY")) order.push("gemini");
  return order;
}

/** Ask the chain for a completion. `json: true` requests JSON output from both providers. */
export async function complete(messages: ChatMessage[], opts: { json?: boolean } = {}): Promise<LlmResult> {
  const json = opts.json ?? false;
  const attempts: Attempt[] = [];

  for (const provider of configuredProviders()) {
    for (let tryNo = 0; tryNo < 2; tryNo++) {
      const started = Date.now();
      try {
        const out = provider === "xai" ? await callXai(messages, json) : await callGemini(messages, json);
        const latencyMs = Date.now() - started;
        attempts.push({ provider, ok: true, latencyMs });
        return { text: out.text, provider, model: out.model, latencyMs, attempts };
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : "unknown");
        attempts.push({
          provider,
          ok: false,
          status: err.status,
          error: err.message.slice(0, 160),
          latencyMs: Date.now() - started,
        });
        if (!err.retryable) break; // 4xx / 429: skip retry, go to next provider
      }
    }
  }
  throw new LlmUnavailableError(attempts);
}
