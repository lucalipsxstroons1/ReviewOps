import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_MODEL,
  acceptsTemperature,
  parseModel,
} from "../src/ai/model.js";
import { fromRoot } from "./helpers/run-action.js";

const ESCAPE = String.fromCodePoint(0x1b);

test("uses the default model when the input is empty or missing", () => {
  for (const value of [undefined, "", "  ", "\n"]) {
    assert.equal(parseModel(value), "gpt-6-luna");
  }
  assert.equal(DEFAULT_MODEL, "gpt-6-luna");
});

for (const name of [
  "gpt-4o-mini",
  "gpt-4.1",
  "o3-mini",
  "gpt-4o-2024-08-06",
  "ft:gpt-4o-mini:my-org::abc123",
  "chatgpt-4o-latest",
  "a",
  "a".repeat(100),
]) {
  test(`accepts the model name ${name.slice(0, 40)}`, () => {
    assert.equal(parseModel(name), name);
  });
}

test("trims the model name", () => {
  assert.equal(parseModel("  gpt-4.1  "), "gpt-4.1");
});

const INVALID = [
  ["a space inside", "gpt 4"],
  ["a slash", "openai/gpt-4"],
  ["a path", "../secrets"],
  ["a quote", 'gpt"4'],
  ["a backtick", "gpt`4`"],
  ["a dollar sign", "$(whoami)"],
  ["a line break", "gpt\n4"],
  ["a name with 101 characters", "a".repeat(101)],
  ["non-ASCII letters", "gpt-4ö"],
];

for (const [name, value] of INVALID) {
  test(`rejects ${name} and says what is allowed`, () => {
    assert.throws(
      () => parseModel(value),
      (error) => {
        assert.match(
          error.message,
          /^Input `openai-model` must be the name of an OpenAI model \(letters, digits, "\.", "-", "_" and ":", at most 100 characters\), but is "/,
        );
        // The value is shown as one harmless line.
        assert.doesNotMatch(error.message, /\n/);
        return true;
      },
    );
  });
}

test("shows an odd value as harmless text, shortened", () => {
  assert.throws(
    () => parseModel(`gpt${ESCAPE}[31m`),
    (error) => {
      assert.equal(error.message.includes(ESCAPE), false);
      assert.match(error.message, /"gpt\\u001b\[31m"/);
      return true;
    },
  );
  assert.throws(
    () => parseModel("x y".repeat(3000)),
    (error) => error.message.length < 400,
  );
});

test("does not load the SDK, so that run() does not pull it into the bundle", () => {
  const source = readFileSync(fromRoot("src/ai/model.js"), "utf8");

  const imports = [...source.matchAll(/^import .* from "(.*)";$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports, ["../printable.js"]);
});

// --- Which models take `temperature` (#122) -----------------------------------

for (const name of [
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4.1-2025-04-14",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4o-2024-08-06",
  "gpt-4o-mini-2024-07-18",
  "ft:gpt-4o-mini:my-org::abc123",
  "ft:gpt-4.1:my-org:suffix:abc123",
]) {
  test(`${name} takes temperature`, () => {
    assert.equal(acceptsTemperature(name), true);
  });
}

for (const name of [
  "gpt-6-luna",
  "gpt-6.1-sol",
  "o3-mini",
  "o1",
  "gpt-4",
  "gpt-4-turbo",
  "gpt-4.10",
  "gpt-4.1x",
  "gpt-4omni",
  "gpt-4o_mini",
  "chatgpt-4o-latest",
  "my-gpt-4o",
  "ft:gpt-4:my-org::abc123",
  "ft:o3-mini:my-org::abc123",
  "GPT-4O",
  "something-unknown",
  "a",
  "",
]) {
  test(`${name || "an empty name"} does not take temperature`, () => {
    assert.equal(acceptsTemperature(name), false);
  });
}

test("the default model does not take temperature", () => {
  assert.equal(acceptsTemperature(DEFAULT_MODEL), false);
});

test("anything that is not a name does not take temperature", () => {
  for (const value of [undefined, null, 4, {}, ["gpt-4o"]]) {
    assert.equal(acceptsTemperature(value), false);
  }
});
