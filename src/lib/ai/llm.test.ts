import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { complete, LlmUnavailableError } from "./llm";

// Primary provider in these tests: xAI. Backup: Gemini. Network is fully mocked.
const realFetch = globalThis.fetch;
let calls: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const xaiOk = (t: string) => jsonResponse({ choices: [{ message: { content: t } }] });
const geminiOk = (t: string) => jsonResponse({ candidates: [{ content: { parts: [{ text: t }] } }] });

const which = (url: string) => (url.includes("x.ai") ? "xai" : url.includes("groq") ? "groq" : "gemini");

function mockFetch(handler: (url: string, n: number) => Response | Promise<Response>) {
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(which(url));
    return handler(url, n++);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  delete process.env.GROQ_API_KEY;
  process.env.XAI_API_KEY = "test-xai";
  process.env.XAI_MODEL = "test-model";
  process.env.GEMINI_API_KEY = "test-gemini";
  process.env.LLM_PROVIDER_ORDER = "xai,gemini";
  process.env.LLM_TIMEOUT_MS = "500";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const msgs = [{ role: "user" as const, content: "hi" }];

test("uses xAI first when it works", async () => {
  mockFetch(() => xaiOk('{"ok":true}'));
  const r = await complete(msgs, { json: true });
  assert.equal(r.provider, "xai");
  assert.equal(r.model, "test-model");
  assert.deepEqual(calls, ["xai"]);
});

test("a 429 from xAI falls straight through to Gemini without retrying xAI", async () => {
  mockFetch((url) => (url.includes("x.ai") ? jsonResponse({ error: "rate" }, 429) : geminiOk("{}")));
  const r = await complete(msgs);
  assert.equal(r.provider, "gemini");
  assert.deepEqual(calls, ["xai", "gemini"]);
  assert.equal(r.attempts[0].status, 429);
});

test("a 401 is not retried either", async () => {
  mockFetch((url) => (url.includes("x.ai") ? jsonResponse({ error: "bad key" }, 401) : geminiOk("{}")));
  const r = await complete(msgs);
  assert.equal(r.provider, "gemini");
  assert.deepEqual(calls, ["xai", "gemini"]);
});

test("a 5xx is retried once on the same provider before falling through", async () => {
  mockFetch((url) => (url.includes("x.ai") ? jsonResponse({ error: "boom" }, 503) : geminiOk("{}")));
  const r = await complete(msgs);
  assert.equal(r.provider, "gemini");
  assert.deepEqual(calls, ["xai", "xai", "gemini"]);
});

test("a transient 5xx that succeeds on retry stays on the same provider", async () => {
  mockFetch((_u, n) => (n === 0 ? jsonResponse({}, 500) : xaiOk("{}")));
  const r = await complete(msgs);
  assert.equal(r.provider, "xai");
  assert.deepEqual(calls, ["xai", "xai"]);
});

test("a hung provider times out and the next one is used", async () => {
  mockFetch((url) =>
    url.includes("x.ai")
      ? new Promise<Response>(() => {
          /* never resolves */
        })
      : geminiOk("{}")
  );
  // The mock ignores the abort signal, so emulate real fetch by rejecting when the signal aborts.
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      (orig as typeof fetch)(input, init).then(resolve, reject);
    })) as typeof fetch;
  const r = await complete(msgs);
  assert.equal(r.provider, "gemini");
  assert.equal(r.attempts[0].error, "timeout");
});

test("throws LlmUnavailableError when every provider fails", async () => {
  mockFetch(() => jsonResponse({ error: "x" }, 429));
  await assert.rejects(complete(msgs), (e: unknown) => e instanceof LlmUnavailableError && e.attempts.length === 2);
});

test("throws a clear error when no provider is configured", async () => {
  delete process.env.XAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  mockFetch(() => xaiOk("{}"));
  await assert.rejects(complete(msgs), /No LLM provider is configured/);
  assert.deepEqual(calls, []);
});

test("xAI without XAI_MODEL is treated as not configured", async () => {
  delete process.env.XAI_MODEL;
  delete process.env.GEMINI_API_KEY;
  mockFetch(() => xaiOk("{}"));
  await assert.rejects(complete(msgs), /No LLM provider is configured/);
  assert.deepEqual(calls, []);
});

test("works with only Gemini configured", async () => {
  delete process.env.XAI_API_KEY;
  mockFetch(() => geminiOk('{"a":1}'));
  const r = await complete(msgs, { json: true });
  assert.equal(r.provider, "gemini");
  assert.equal(r.text, '{"a":1}');
});

test("xAI is tried first by default, even when Gemini is also configured", async () => {
  delete process.env.LLM_PROVIDER_ORDER;
  mockFetch((url) => (url.includes("x.ai") ? xaiOk("{}") : geminiOk("{}")));
  const r = await complete(msgs);
  assert.equal(r.provider, "xai");
  assert.deepEqual(calls, ["xai"]);
});