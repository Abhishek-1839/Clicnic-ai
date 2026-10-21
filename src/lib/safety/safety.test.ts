import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEmergency, emergencyReply } from "./emergency";
import { asksForClinicalAdvice, looksLikeClinicalAdvice } from "./medical";

test("flags medical emergencies", () => {
  const cases = [
    "I have severe chest pain and trouble breathing",
    "my father can't breathe",
    "She is unconscious and not responding",
    "He had a seizure just now",
    "there is heavy bleeding that won't stop",
    "I think I'm having a heart attack",
    "my baby isn't breathing",
    "Her throat is swelling after eating peanuts",
  ];
  for (const c of cases) {
    const r = detectEmergency(c);
    assert.equal(r.urgent, true, `should flag: ${c}`);
    assert.equal(r.kind, "medical", `medical kind: ${c}`);
  }
});

test("flags self-harm and uses the self-harm kind", () => {
  for (const c of ["I want to die", "i am thinking about suicide", "I want to hurt myself"]) {
    const r = detectEmergency(c);
    assert.equal(r.urgent, true, c);
    assert.equal(r.kind, "self_harm", c);
  }
});

test("does not flag routine administrative messages", () => {
  const cases = [
    "I'd like to book an appointment for tomorrow morning",
    "Can I reschedule my visit to Friday?",
    "What are your opening hours on Saturday?",
    "Please cancel APT-4F7K",
    "Do you accept insurance?",
    "I need a follow-up for my child's vaccination",
  ];
  for (const c of cases) assert.equal(detectEmergency(c).urgent, false, c);
});

test("emergency replies are fixed and mention the emergency number", () => {
  assert.match(emergencyReply("medical"), /emergency/i);
  assert.match(emergencyReply("self_harm"), /helpline/i);
});

test("detects clinical-advice requests from patients", () => {
  assert.equal(asksForClinicalAdvice("Should I take ibuprofen for this?"), true);
  assert.equal(asksForClinicalAdvice("What is the dosage for amoxicillin"), true);
  assert.equal(asksForClinicalAdvice("Is this serious?"), true);
  assert.equal(asksForClinicalAdvice("I want to book an appointment"), false);
  assert.equal(asksForClinicalAdvice("What are your clinic hours?"), false);
  assert.equal(asksForClinicalAdvice("Do I have to bring my ID card?"), false);
  assert.equal(asksForClinicalAdvice("Do I have an appointment tomorrow?"), false);
  assert.equal(asksForClinicalAdvice("Could I have diabetes?"), true);
});

test("blocks AI replies that look like diagnosis or treatment", () => {
  assert.equal(looksLikeClinicalAdvice("You probably have a skin infection."), true);
  assert.equal(looksLikeClinicalAdvice("Take 500 mg twice a day."), true);
  assert.equal(looksLikeClinicalAdvice("I can help you book with Dr. Rao tomorrow."), false);
  assert.equal(looksLikeClinicalAdvice("Our clinic is open 9 AM to 5 PM, Monday to Saturday."), false);
});
