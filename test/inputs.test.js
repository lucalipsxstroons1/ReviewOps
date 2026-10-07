import assert from "node:assert/strict";
import { test } from "node:test";
import { assertInputs, readInputs, secretsOf } from "../src/inputs.js";
import { createFakeCore } from "./helpers/fake-core.js";

test("reads all inputs", () => {
  const core = createFakeCore({
    "github-token": "token-value",
    "openai-api-key": "key-value",
    "openai-model": "gpt-4.1",
    language: "de",
    exclude: "docs/**\n*.txt",
    "max-files": "10",
    "max-diff-chars": "5000",
    "max-comments": "20",
    "fail-on": "critical",
    "review-drafts": "true",
    "skip-label": "skip-me",
    "review-bots": "true",
  });

  assert.deepEqual(readInputs(core), {
    githubToken: "token-value",
    openaiApiKey: "key-value",
    openaiModel: "gpt-4.1",
    language: "de",
    exclude: "docs/**\n*.txt",
    maxFiles: "10",
    maxDiffChars: "5000",
    maxComments: "20",
    failOn: "critical",
    reviewDrafts: "true",
    skipLabel: "skip-me",
    reviewBots: "true",
  });
});

test("reads the limits as text and leaves checking them to parseLimits", () => {
  const core = createFakeCore({
    "github-token": "token-value",
    "openai-api-key": "key-value",
    "max-files": "not a number",
  });

  const inputs = readInputs(core);

  assert.equal(inputs.maxFiles, "not a number");
  assert.equal(inputs.maxDiffChars, "");
  assert.equal(inputs.maxComments, "");
});

test("reads a missing exclude input as empty text", () => {
  const core = createFakeCore({
    "github-token": "token-value",
    "openai-api-key": "key-value",
  });

  assert.equal(readInputs(core).exclude, "");
});

test("masks the credentials, but not the model, the patterns or the limits", () => {
  const core = createFakeCore({
    "github-token": "token-value",
    "openai-api-key": "key-value",
    "openai-model": "gpt-4.1-long-name",
    language: "de",
    exclude: "documentation/**",
    "max-files": "1000000",
    "max-diff-chars": "1000000",
    "max-comments": "1000000",
  });

  const inputs = readInputs(core);

  assert.deepEqual(core.messages("setSecret"), ["token-value", "key-value"]);
  assert.deepEqual(secretsOf(inputs), ["token-value", "key-value"]);
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

const LINE_FEED = String.fromCodePoint(0x0a);
const ELLIPSIS = String.fromCodePoint(0x2026);
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);

for (const [name, key] of [
  ["a space", "sk-abcdef ghijkl"],
  ["a line break", `sk-abcdef${LINE_FEED}ghijkl`],
  ["a tab", `sk-abcdef${String.fromCodePoint(0x09)}ghijkl`],
  ["the ellipsis of a shortened display", `sk-abcdef${ELLIPSIS}ghijkl`],
  ["a no-break space", `sk-abcdef${NO_BREAK_SPACE}ghijkl`],
  ["a letter outside of ASCII", "sk-abcdefö-ghijkl"],
]) {
  test(`rejects an API key with ${name} without repeating the key`, () => {
    assert.throws(
      () => assertInputs({ githubToken: "token-value", openaiApiKey: key }),
      (error) => {
        assert.match(
          error.message,
          /^Input `openai-api-key` contains a character that is not allowed.*Copy the key from OpenAI again.*`OPENAI_API_KEY`/,
        );
        assert.equal(error.message.includes("abcdef"), false);
        return true;
      },
    );
  });
}

test("accepts the characters of real keys", () => {
  for (const key of [
    "sk-proj-AbC123_dEf-456",
    // Same characters as a real key, but too short to look like one: a value
    // that matches the pattern of a key would be reported by secret scanning.
    "sk-svcacct-AbC_dEf-123",
    "placeholder-until-issue-11",
    "key-value",
  ]) {
    assert.doesNotThrow(() =>
      assertInputs({ githubToken: "token-value", openaiApiKey: key }),
    );
  }
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

test("a run that leaves out the review needs the token but no key", () => {
  assert.doesNotThrow(() =>
    assertInputs(
      { githubToken: "token-value", openaiApiKey: "" },
      { needsKey: false },
    ),
  );
  assert.throws(
    () =>
      assertInputs({ githubToken: "", openaiApiKey: "" }, { needsKey: false }),
    /Input `github-token` is empty/,
  );
});

test("a run that asks the model still needs the key", () => {
  assert.throws(
    () => assertInputs({ githubToken: "token-value", openaiApiKey: "" }),
    /Input `openai-api-key` is missing/,
  );
  assert.throws(
    () =>
      assertInputs(
        { githubToken: "token-value", openaiApiKey: "" },
        { needsKey: true },
      ),
    /Input `openai-api-key` is missing/,
  );
});
