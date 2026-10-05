import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor } from "../src/redact.js";

test("replaces every occurrence of every secret", () => {
  const redact = createRedactor(["alpha-secret", "beta-secret"]);

  assert.equal(
    redact("alpha-secret, beta-secret and alpha-secret again"),
    "***, *** and *** again",
  );
});

test("leaves text without secrets untouched", () => {
  const redact = createRedactor(["alpha-secret"]);

  assert.equal(redact("nothing to hide"), "nothing to hide");
});

test("ignores empty and non-string values", () => {
  const redact = createRedactor(["", undefined, null, 12345678]);

  assert.equal(redact("12345678 is the answer"), "12345678 is the answer");
});

test("ignores values too short to be a credential", () => {
  const redact = createRedactor(["a", "1234567"]);

  assert.equal(
    redact("a bad request happened, code 1234567"),
    "a bad request happened, code 1234567",
  );
});

test("replaces a value of exactly eight characters", () => {
  const redact = createRedactor(["12345678"]);

  assert.equal(redact("code 12345678"), "code ***");
});

test("replaces a secret that contains another one as a whole", () => {
  const redact = createRedactor(["alpha-secret", "alpha-secret-and-more"]);

  assert.equal(redact("value: alpha-secret-and-more"), "value: ***");
});

test("turns non-string input into a string", () => {
  const redact = createRedactor(["alpha-secret"]);

  assert.equal(
    redact(new Error("failed with alpha-secret")),
    "Error: failed with ***",
  );
});
