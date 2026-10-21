import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { allow, _resetForTests } from "./ratelimit";

beforeEach(() => _resetForTests());

test("allows up to the limit then blocks", () => {
  for (let i = 0; i < 3; i++) assert.equal(allow("a", 3, 1000, 100 + i), true);
  assert.equal(allow("a", 3, 1000, 200), false);
});

test("the window slides: old hits expire", () => {
  for (let i = 0; i < 3; i++) allow("a", 3, 1000, 100);
  assert.equal(allow("a", 3, 1000, 1200), true);
});

test("keys are independent", () => {
  for (let i = 0; i < 3; i++) allow("a", 3, 1000, 100);
  assert.equal(allow("b", 3, 1000, 100), true);
});
