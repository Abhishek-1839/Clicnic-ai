import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { analyzeMessage, answerFaq } from "./analyze";

const realFetch = globalThis.fetch;
let calls = 0;

const okReply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

function mock(handler: (n: number) => Response) {
  calls = 0;
  globalThis.fetch = (async () => handler(calls++)) as typeof fetch;
}

beforeEach(() => {
  delete process.env.GROQ_API_KEY;
  process.env.XAI_API_KEY = "test";
  process.env.XAI_MODEL = "test-model";
  process.env.LLM_PROVIDER_ORDER = "xai";
  delete process.env.GEMINI_API_KEY;
  process.env.LLM_TIMEOUT_MS = "500";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const GOOD = JSON.stringify({
  intent: "book",
  confidence: 0.92,
  extraction: {
    patient_name: "Aarav Sharma",
    reason: "follow-up",
    doctor_preference: "",
    date_hint: "tomorrow",
    time_of_day: "Morning",
    ref_code: "null",
  },
});

test("emergency messages never reach the LLM", async () => {
  mock(() => okReply(GOOD));
  const r = await analyzeMessage("I have severe chest pain and can't breathe");
  assert.equal(r.analysis.intent, "urgent");
  assert.equal(r.emergency, "medical");
  assert.equal(r.provider, "rules");
  assert.equal(calls, 0);
});

test("valid LLM output is parsed and normalised", async () => {
  mock(() => okReply(GOOD));
  const r = await analyzeMessage("book me tomorrow morning, I'm Aarav Sharma");
  assert.equal(r.provider, "xai");
  assert.equal(r.analysis.intent, "book");
  assert.equal(r.analysis.extraction.time_of_day, "morning"); // "Morning" lower-cased
  assert.equal(r.analysis.extraction.doctor_preference, null); // "" -> null
  assert.equal(r.analysis.extraction.ref_code, null); // "null" -> null
  assert.equal(r.event.error, null);
});

test("invalid JSON triggers one repair retry that succeeds", async () => {
  mock((n) => okReply(n === 0 ? "Sure! Here you go: {intent: book" : GOOD));
  const r = await analyzeMessage("I want to book an appointment");
  assert.equal(calls, 2);
  assert.equal(r.provider, "xai");
  assert.equal(r.analysis.intent, "book");
});

test("two invalid outputs fall back to rules and record why", async () => {
  mock(() => okReply("not json at all"));
  const r = await analyzeMessage("please cancel APT-4F7K");
  assert.equal(r.provider, "rules");
  assert.equal(r.analysis.intent, "cancel");
  assert.equal(r.analysis.extraction.ref_code, "APT-4F7K");
  assert.match(r.event.error ?? "", /invalid LLM output/);
});

test("a provider outage falls back to rules and the flow still works", async () => {
  mock(() => new Response("{}", { status: 429 }));
  const r = await analyzeMessage("I'd like to book an appointment for tomorrow");
  assert.equal(r.provider, "rules");
  assert.equal(r.analysis.intent, "book");
  assert.ok(r.event.error);
});

test("the LLM cannot raise an urgent intent on its own", async () => {
  mock(() => okReply(JSON.stringify({ intent: "urgent", confidence: 1, extraction: {} })));
  const r = await analyzeMessage("what time do you open?");
  assert.notEqual(r.analysis.intent, "urgent");
});

test("clinical-advice questions are flagged for a clinician", async () => {
  mock(() => okReply(JSON.stringify({ intent: "other", confidence: 0.8, extraction: {} })));
  const r = await analyzeMessage("Should I take ibuprofen for my headache?");
  assert.equal(r.needsClinician, true);
});

test("FAQ: answers from the knowledge base", async () => {
  mock(() => okReply(JSON.stringify({ answerable: true, answer: "We are open 9 AM to 5 PM, Monday to Saturday." })));
  const r = await answerFaq("What are your hours?", { hours: "Mon-Sat 9-5" });
  assert.equal(r.answerable, true);
  assert.match(r.answer, /9 AM/);
});

test("FAQ: unanswerable questions go to staff", async () => {
  mock(() => okReply(JSON.stringify({ answerable: false, answer: "" })));
  const r = await answerFaq("Do you have a cafeteria?", {});
  assert.equal(r.answerable, false);
});

test("FAQ: clinical questions never reach the LLM", async () => {
  mock(() => okReply(JSON.stringify({ answerable: true, answer: "Take paracetamol." })));
  const r = await answerFaq("What medicine should I take for fever?", {});
  assert.equal(r.answerable, false);
  assert.equal(calls, 0);
});

test("FAQ: an answer that sounds like a diagnosis is blocked", async () => {
  mock(() => okReply(JSON.stringify({ answerable: true, answer: "You probably have a skin infection." })));
  const r = await answerFaq("Do you treat skin problems?", {});
  assert.equal(r.answerable, false);
  assert.match(r.event.error ?? "", /blocked/);
});
