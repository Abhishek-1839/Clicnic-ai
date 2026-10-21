import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedNext, canTransition, statusMessage, sortInquiries, validReply } from "./transitions";

test("staff and admin can confirm or cancel a pending request", () => {
  assert.deepEqual(allowedNext("staff", "pending"), ["confirmed", "cancelled"]);
  assert.deepEqual(allowedNext("admin", "pending"), ["confirmed", "cancelled"]);
});

test("doctors can only complete or mark no-show, and not from pending", () => {
  assert.deepEqual(allowedNext("doctor", "confirmed"), ["completed", "no_show"]);
  assert.deepEqual(allowedNext("doctor", "pending"), []);
  assert.equal(canTransition("doctor", "confirmed", "cancelled"), false);
});

test("finished appointments are final", () => {
  for (const s of ["cancelled", "completed", "no_show"] as const) {
    assert.deepEqual(allowedNext("staff", s), []);
  }
});

test("patients get no dashboard actions", () => {
  assert.deepEqual(allowedNext("patient", "pending"), []);
});

test("cannot skip straight from pending to completed", () => {
  assert.equal(canTransition("staff", "pending", "completed"), false);
});

test("confirmation and cancellation messages mention the details", () => {
  const a = { refCode: "APT-4F7K", doctorName: "Dr. Meera Rao", when: "Thu 22 Oct, 10:30 AM" };
  assert.match(statusMessage("confirmed", a)!, /APT-4F7K.*confirmed/s);
  assert.match(statusMessage("cancelled", a)!, /cancelled/);
  assert.equal(statusMessage("completed", a), null);
});

test("inquiry queue: urgent first, then longest waiting", () => {
  const rows = [
    { id: "a", urgent: false, updated_at: "2026-10-20T10:00:00Z" },
    { id: "b", urgent: false, updated_at: "2026-10-20T08:00:00Z" },
    { id: "c", urgent: true, updated_at: "2026-10-20T12:00:00Z" },
  ];
  assert.deepEqual(sortInquiries(rows).map((r) => r.id), ["c", "b", "a"]);
});

test("reply validation trims and bounds length", () => {
  assert.equal(validReply("  hello  "), "hello");
  assert.equal(validReply("   "), null);
  assert.equal(validReply(42), null);
  assert.equal(validReply("x".repeat(1001)), null);
});
