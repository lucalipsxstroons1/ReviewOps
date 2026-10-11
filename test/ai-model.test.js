import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  acceptsTemperature,
  parseBaseUrl,
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
  // Two modules of this action, no package: the check of an address and the
  // way to print a value from the workflow.
  assert.deepEqual(imports, ["../address.js", "../printable.js"]);
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

// --- The address of the API (#40) -------------------------------------------------

const STANDARD = "https://api.openai.com/v1";

test("an empty or missing address means the standard address", () => {
  for (const value of [undefined, "", "  ", "\n"]) {
    assert.deepEqual(parseBaseUrl(value), {
      url: STANDARD,
      host: "api.openai.com",
      isDefault: true,
    });
  }
  assert.equal(DEFAULT_BASE_URL, STANDARD);
});

test("the standard address, written out, counts as the standard", () => {
  for (const value of [
    STANDARD,
    `${STANDARD}/`,
    "https://API.OPENAI.COM/v1",
    "  https://api.openai.com/v1  ",
  ]) {
    const result = parseBaseUrl(value);
    assert.equal(result.isDefault, true, value);
    assert.equal(result.url, STANDARD, value);
  }
});

test("takes an address with its path and port, without a slash at the end", () => {
  assert.deepEqual(
    parseBaseUrl("https://my-resource.openai.azure.com/openai/v1/"),
    {
      url: "https://my-resource.openai.azure.com/openai/v1",
      host: "my-resource.openai.azure.com",
      isDefault: false,
    },
  );
  assert.deepEqual(parseBaseUrl("https://gateway.example.com:8443/proxy///"), {
    url: "https://gateway.example.com:8443/proxy",
    host: "gateway.example.com:8443",
    isDefault: false,
  });
  // No path is demanded: the SDK adds `/chat/completions` to what it gets.
  assert.equal(
    parseBaseUrl("https://gateway.example.com").url,
    "https://gateway.example.com",
  );
});

test("accepts http only for the machine of the runner", () => {
  for (const value of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:11434/v1/",
    "http://localhost/v1",
  ]) {
    const result = parseBaseUrl(value);
    assert.equal(result.isDefault, false, value);
    assert.match(result.url, /^http:\/\/(localhost|127\.0\.0\.1)/);
  }
  for (const value of [
    "http://example.com/v1",
    "http://localhost.evil.example/v1",
    "http://127.0.0.1.evil.example/v1",
    "http://[::1]:11434/v1",
    "http://192.168.0.5/v1",
    "http://api.openai.com/v1",
    "ftp://example.com/v1",
    "ws://example.com/v1",
  ]) {
    assert.throws(
      () => parseBaseUrl(value),
      /must start with `https:\/\/`/,
      value,
    );
  }
});

const TOO_LONG = `https://example.com/${"a".repeat(2100)}`;
const UNUSABLE = [
  [
    "a user name and a password",
    "https://user:SECRETWORD@example.com/v1",
    /user name or a password/,
  ],
  [
    "a user name alone",
    "https://SECRETUSER@example.com/v1",
    /user name or a password/,
  ],
  ["a query", "https://example.com/v1?key=SECRETWORD", /query/],
  ["an empty query", "https://example.com/v1?", /query/],
  ["a fragment", "https://example.com/v1#SECRETWORD", /fragment/],
  ["a space", "https://example.com/v 1", /space or a control character/],
  [
    "a line break",
    "https://example.com/v1\nSECRETWORD",
    /space or a control character/,
  ],
  ["a tab", "https://example.com/\tv1", /space or a control character/],
  [
    "a control character",
    `https://example.com/${String.fromCodePoint(0x1b)}v1`,
    /space or a control character/,
  ],
  [
    "no address at all",
    "not an address SECRETWORD",
    /space or a control character/,
  ],
  ["no protocol", "example.com/v1", /not a valid address/],
  ["only a protocol", "https://", /not a valid address/],
  ["too many characters", TOO_LONG, /too long/],
];

for (const [name, value, rule] of UNUSABLE) {
  test(`refuses an address with ${name}, and names no part of it`, () => {
    assert.throws(
      () => parseBaseUrl(value),
      (error) => {
        assert.match(error.message, rule);
        assert.match(error.message, /^Input `openai-base-url` /);
        // Not the address, not a host, not a word of it.
        assert.doesNotMatch(
          error.message,
          /SECRETWORD|SECRETUSER|example\.com/,
        );
        return true;
      },
    );
  });
}

test("the message about credentials names the key input, not the key", () => {
  assert.throws(
    () => parseBaseUrl("https://user:pw@example.com/v1"),
    /Pass the secret in `openai-api-key`\./,
  );
});

test("the address that is accepted is checked as the address of the report is", () => {
  // The same function: the limit and the rules are those of `insights-url`.
  assert.equal(
    parseBaseUrl(`https://example.com/${"a".repeat(2048 - 20)}`).isDefault,
    false,
  );
});
