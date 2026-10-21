import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRefCode, ruleBasedAnalysis } from "./fallback";

test("intent detection", () => {
  const cases: [string, string][] = [
    ["I'd like to book an appointment", "book"],
    ["Can I see a doctor tomorrow morning?", "book"],
    ["Please cancel my appointment APT-4F7K", "cancel"],
    ["I need to reschedule my visit", "reschedule"],
    ["Can I change my appointment to Friday", "reschedule"],
    ["What is the status of my booking APT-9XK2?", "status"],
    ["What are your opening hours?", "faq"],
    ["Do you have parking", "faq"],
    ["Hello", "greeting"],
    ["asdf qwerty", "other"],
    ["I have severe chest pain", "urgent"],
  ];
  for (const [text, intent] of cases) assert.equal(ruleBasedAnalysis(text).intent, intent, text);
});

test("extraction", () => {
  const a = ruleBasedAnalysis("Hi, my name is Aarav Sharma and I want to book with Dr. Rao tomorrow morning for a skin rash");
  assert.equal(a.extraction.patient_name, "Aarav Sharma");
  assert.equal(a.extraction.doctor_preference, "Dr. Rao");
  assert.equal(a.extraction.date_hint, "tomorrow");
  assert.equal(a.extraction.time_of_day, "morning");
  assert.equal(a.extraction.reason, "a skin rash");
});

test("a date is not mistaken for a reason", () => {
  const a = ruleBasedAnalysis("I want an appointment for tomorrow");
  assert.equal(a.extraction.reason, null);
  assert.equal(a.extraction.date_hint, "tomorrow");
});

test("reference codes are normalised", () => {
  assert.equal(extractRefCode("cancel apt-4f7k please"), "APT-4F7K");
  assert.equal(extractRefCode("my code is APT 9XK2"), "APT-9XK2");
  assert.equal(extractRefCode("no code here"), null);
});

test("never invents values", () => {
  const a = ruleBasedAnalysis("book an appointment");
  assert.equal(a.extraction.patient_name, null);
  assert.equal(a.extraction.reason, null);
  assert.equal(a.extraction.doctor_preference, null);
});
