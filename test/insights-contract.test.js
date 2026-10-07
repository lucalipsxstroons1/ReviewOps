import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateInsightsPayload } from "./helpers/insights-contract.js";
import { fromRoot } from "./helpers/run-action.js";

const load = () =>
  JSON.parse(
    readFileSync(fromRoot("test/fixtures/insights-review-v1.json"), "utf8"),
  );

test("the example of the contract is valid", () => {
  assert.deepEqual(validateInsightsPayload(load()), []);
});

const BROKEN = [
  ["a missing field", (p) => delete p.model, /report: fields/],
  ["an extra field", (p) => (p.title = "x"), /report: fields/],
  [
    "an extra field in a finding",
    (p) => (p.findings[0].text = "x"),
    /findings\[0\]: fields/,
  ],
  ["a wrong schema version", (p) => (p.schemaVersion = 2), /schemaVersion/],
  [
    "an upper case delivery id",
    (p) => (p.deliveryId = p.deliveryId.toUpperCase()),
    /deliveryId/,
  ],
  ["a repository without owner", (p) => (p.repository = "shop"), /repository/],
  [
    "a repository over 140 characters",
    (p) => (p.repository = `${"a".repeat(70)}/${"b".repeat(70)}`),
    /repository/,
  ],
  ["a short sha", (p) => (p.commitSha = "9f3c"), /commitSha/],
  ["an unsafe run id", (p) => (p.runId = 2 ** 53), /runId/],
  ["a model with a space", (p) => (p.model = "gpt 4"), /model/],
  ["negative tokens", (p) => (p.tokens.input = -1), /tokens\.input/],
  ["a fractional duration", (p) => (p.durationMs = 1.5), /durationMs/],
  ["a text as number", (p) => (p.prNumber = "42"), /prNumber/],
  ["an unknown mode", (p) => (p.mode = "partial"), /mode/],
  ["a review id of 0", (p) => (p.githubReviewId = 0), /githubReviewId/],
  [
    "more than 500 findings",
    (p) => (p.findings = Array(501).fill(p.findings[0])),
    /findings: at most/,
  ],
  [
    "an unknown severity",
    (p) => (p.findings[0].severity = "blocker"),
    /severity/,
  ],
  [
    "a category with upper case",
    (p) => (p.findings[0].category = "React"),
    /category/,
  ],
  ["an empty path", (p) => (p.findings[0].path = ""), /path/],
  [
    "a path of 1025 code points",
    (p) => (p.findings[0].path = "a".repeat(1025)),
    /path/,
  ],
  [
    "a line without a fingerprint",
    (p) => (p.findings[2].line = 3),
    /fingerprint/,
  ],
  [
    "a fingerprint without a line",
    (p) => (p.findings[0].line = null),
    /fingerprint/,
  ],
  [
    "an unknown placement",
    (p) => (p.findings[0].placement = "top"),
    /placement/,
  ],
];

for (const [name, change, expected] of BROKEN) {
  test(`the validator rejects ${name}`, () => {
    const payload = load();
    change(payload);
    const errors = validateInsightsPayload(payload);
    assert.ok(
      errors.some((error) => expected.test(error)),
      errors.join("\n"),
    );
  });
}
