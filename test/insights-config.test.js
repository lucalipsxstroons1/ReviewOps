import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_URL_CHARS,
  MIN_SECRET_CHARS,
  parseInsightsConfig,
} from "../src/insights/config.js";

// The rules for the two inputs of the report (#76). The address decides where
// repository names and file paths go, so every rule has a test, and no message
// may repeat the address or the secret.

const SECRET = `TESTSECRET-not-a-real-secret-${"0123456789abcdef"}`;
const URL_OK = "https://insights.example.com/api/v1/ingest/review";

const parse = (insightsUrl, insightsSecret = SECRET) =>
  parseInsightsConfig({ insightsUrl, insightsSecret });

test("is off without an address, also when a secret is set", () => {
  assert.equal(parseInsightsConfig({}), null);
  assert.equal(parse("", SECRET), null);
  assert.equal(parse("   ", SECRET), null);
  // Not even a secret that could not be used matters then.
  assert.equal(parse("", "short"), null);
});

test("accepts an https address and names its host", () => {
  assert.deepEqual(parse(URL_OK), {
    url: URL_OK,
    host: "insights.example.com",
    secret: SECRET,
  });
});

test("gives the host with its port and keeps the path", () => {
  const config = parse("https://insights.example.com:8443/in/gest");

  assert.equal(config.host, "insights.example.com:8443");
  assert.equal(config.url, "https://insights.example.com:8443/in/gest");
});

test("removes white space around the address and writes it in its normal form", () => {
  assert.equal(parse(`  ${URL_OK}  `).url, URL_OK);
  assert.equal(
    parse("HTTPS://Insights.Example.COM/x").url,
    "https://insights.example.com/x",
  );
});

test("accepts private addresses: the workflow sets the address like the key", () => {
  assert.equal(parse("https://10.0.0.5/ingest").host, "10.0.0.5");
});

for (const address of [
  "http://localhost:3000/api/v1/ingest/review",
  "http://127.0.0.1:3000/api/v1/ingest/review",
  "http://LOCALHOST/x",
]) {
  test(`accepts http for the machine itself: ${address}`, () => {
    assert.equal(parse(address).secret, SECRET);
  });
}

for (const address of [
  "http://insights.example.com/x",
  "http://localhost.example.com/x",
  "http://127.0.0.2/x",
  "http://[::1]/x",
  "ftp://insights.example.com/x",
  "file:///etc/passwd",
]) {
  test(`refuses an address that is not https and not local: ${address}`, () => {
    assert.throws(() => parse(address), /must start with `https:\/\//);
  });
}

for (const [name, address, message] of [
  [
    "a user name",
    "https://admin@insights.example.com/x",
    /must not contain a user name or a password/,
  ],
  [
    "a password",
    "https://admin:hunter22@insights.example.com/x",
    /must not contain a user name or a password/,
  ],
  [
    "a query",
    "https://insights.example.com/x?token=abc",
    /must not contain a query/,
  ],
  [
    "an empty query",
    "https://insights.example.com/x?",
    /must not contain a query/,
  ],
  ["a fragment", "https://insights.example.com/x#top", /fragment/],
  ["an empty fragment", "https://insights.example.com/x#", /fragment/],
  [
    "a space",
    "https://insights.example.com/a b",
    /space or a control character/,
  ],
  [
    "a line break",
    "https://insights.example.com/a\nb",
    /space or a control character/,
  ],
  [
    "a tab",
    "https://insights.example.com/a\tb",
    /space or a control character/,
  ],
  ["no scheme", "insights.example.com/x", /not a valid address/],
  ["no host", "https://", /not a valid address/],
  ["only a scheme", "https:", /not a valid address/],
  ["text", "not an address", /space or a control character/],
]) {
  test(`refuses an address with ${name}`, () => {
    assert.throws(() => parse(address), message);
  });
}

test("refuses an address over the length limit and accepts one at the limit", () => {
  const prefix = "https://insights.example.com/";
  const atLimit = prefix + "a".repeat(MAX_URL_CHARS - prefix.length);

  assert.equal(atLimit.length, MAX_URL_CHARS);
  assert.equal(parse(atLimit).host, "insights.example.com");
  assert.throws(() => parse(`${atLimit}a`), /too long/);
});

test("takes no secret from an address that is refused first", () => {
  assert.throws(() => parse("http://insights.example.com/x", "short"), /https/);
});

test("reads no secret as null: run() decides what that means", () => {
  assert.equal(parse(URL_OK, "").secret, null);
  assert.equal(parseInsightsConfig({ insightsUrl: URL_OK }).secret, null);
});

test("accepts a secret of exactly the minimum length and refuses a shorter one", () => {
  assert.equal(parse(URL_OK, "k".repeat(MIN_SECRET_CHARS)).secret.length, 32);
  assert.throws(
    () => parse(URL_OK, "k".repeat(MIN_SECRET_CHARS - 1)),
    /too short: at least 32 characters/,
  );
});

for (const [name, secret] of [
  ["a space", `${"k".repeat(40)} ${"k".repeat(5)}`],
  ["a line break", `${"k".repeat(40)}\n`],
  ["a character outside of ASCII", `${"k".repeat(40)}é`],
  ["an ellipsis from a shortened display", `${"k".repeat(40)}…`],
]) {
  test(`refuses a secret with ${name}`, () => {
    assert.throws(() => parse(URL_OK, secret), /character that is not allowed/);
  });
}

test("no message repeats the address or the secret", () => {
  const addresses = [
    "https://admin:hunter22@insights.example.com/x",
    "http://insights.example.com/hunter22",
    "https://insights.example.com/x?hunter22=1",
    "https://insights.example.com/hunter22 x",
    "hunter22",
  ];
  for (const address of addresses) {
    assert.throws(
      () => parse(address),
      (error) => !error.message.includes("hunter22"),
    );
  }
  const secrets = [`${"hunter22".repeat(2)} x`, "hunter22"];
  for (const secret of secrets) {
    assert.throws(
      () => parse(URL_OK, secret),
      (error) => !error.message.includes("hunter22"),
    );
  }
});
