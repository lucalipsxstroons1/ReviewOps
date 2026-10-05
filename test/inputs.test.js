import assert from "node:assert/strict";
import { test } from "node:test";
import { assertInputs, readInputs } from "../src/inputs.js";
import { createFakeCore } from "./helpers/fake-core.js";

test("reads both inputs", () => {
  const core = createFakeCore({
    "github-token": "token-value",
    "openai-api-key": "key-value",
  });

  assert.deepEqual(readInputs(core), {
    githubToken: "token-value",
    openaiApiKey: "key-value",
  });
});

test("masks both credentials", () => {
  const core = createFakeCore({
    "github-token": "token-value",
    "openai-api-key": "key-value",
  });

  readInputs(core);

  assert.deepEqual(core.messages("setSecret"), ["token-value", "key-value"]);
});

test("does not register an empty value as a secret", () => {
  const core = createFakeCore({ "github-token": "token-value" });

  readInputs(core);

  assert.deepEqual(core.messages("setSecret"), ["token-value"]);
});

test("accepts complete inputs", () => {
  assert.doesNotThrow(() =>
    assertInputs({ githubToken: "token-value", openaiApiKey: "key-value" }),
  );
});

test("rejects a missing API key and says how to provide it", () => {
  assert.throws(
    () => assertInputs({ githubToken: "token-value", openaiApiKey: "" }),
    /`openai-api-key` is missing.*repository secret/,
  );
});

test("rejects an empty token", () => {
  assert.throws(
    () => assertInputs({ githubToken: "", openaiApiKey: "key-value" }),
    /`github-token` is empty/,
  );
});

test("never puts a credential into its own error message", () => {
  for (const inputs of [
    { githubToken: "token-value", openaiApiKey: "" },
    { githubToken: "", openaiApiKey: "key-value" },
  ]) {
    assert.throws(
      () => assertInputs(inputs),
      (error) => !/token-value|key-value/.test(error.message),
    );
  }
});
