import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PROMPT_VERSION } from "../src/ai/prompt.js";
import { buildInsightsPayload } from "../src/insights/payload.js";
import { ACTION_VERSION } from "../src/version.js";
import { validateInsightsPayload } from "./helpers/insights-contract.js";
import { fromRoot } from "./helpers/run-action.js";

const FIXTURE = JSON.parse(
  readFileSync(fromRoot("test/fixtures/insights-review-v1.json"), "utf8"),
);

const DELIVERY_ID = "3f2b8c1e-5d47-4a9b-8e21-7c6f0d9a4b12";

/** A finding as `parseReview()` returns it, with a marker in every text. */
const finding = (path, line, severity, category, marker = "MARK") => ({
  path,
  line,
  severity,
  category,
  title: `${marker}-title`,
  comment: `${marker}-comment`,
  suggestion: `${marker}-suggestion`,
});

/** The prepared run behind the example of the contract. */
function preparedRun(change = {}) {
  return {
    pullRequest: {
      owner: "octo-org",
      repo: "shop-api",
      pullNumber: 42,
      headSha: "9f3c1a7b2d4e6f8091a2b3c4d5e6f708192a3b4c",
      title: "TITLE-MARKER",
    },
    run: { runId: 18234567890, runAttempt: 1 },
    model: "gpt-4o-mini",
    usage: { inputTokens: 18250, outputTokens: 1140, totalTokens: 19390 },
    mode: "full",
    posted: { reviewId: 2817345012, inlineComments: 2, fallback: false },
    selection: {
      inline: [
        finding("src/Orders/OrderRepository.cs", 42, "critical", "security"),
        finding("src/Orders/OrderService.cs", 118, "major", "efcore"),
      ],
      fingerprints: ["5a1f0c9e3b7d2a46", "c04e7a91d2b85f36"],
      unplaced: [
        finding("src/Orders/OrderMapper.cs", 7, "minor", "code-quality"),
      ],
      unplacedFingerprints: [null],
    },
    startedAt: 1000,
    now: () => 49211.4,
    deliveryId: DELIVERY_ID,
    ...change,
  };
}

const build = (change) => buildInsightsPayload(preparedRun(change));

const EMPTY_SELECTION = {
  inline: [],
  fingerprints: [],
  unplaced: [],
  unplacedFingerprints: [],
};

test("builds exactly the example of the contract for a prepared run", () => {
  const { payload, omitted } = build();

  assert.deepStrictEqual(payload, FIXTURE);
  assert.deepEqual(omitted, { overLimit: 0, longPath: 0 });
});

test("the version fields come from the code", () => {
  const { payload } = build();

  assert.equal(payload.actionVersion, ACTION_VERSION);
  assert.equal(payload.promptVersion, PROMPT_VERSION);
});

test("a finding without a fingerprint has no line", () => {
  // The model named line 7, but the diff does not show it.
  const { payload } = build();

  assert.equal(payload.findings[2].line, null);
  assert.equal(payload.findings[2].fingerprint, null);
});

test("a finding in the text with a fingerprint keeps its line", () => {
  const { payload } = build({
    selection: {
      ...EMPTY_SELECTION,
      unplaced: [finding("a.js", 9, "info", "react")],
      unplacedFingerprints: ["0123456789abcdef"],
    },
  });

  assert.deepEqual(payload.findings, [
    {
      severity: "info",
      category: "react",
      path: "a.js",
      line: 9,
      fingerprint: "0123456789abcdef",
      placement: "body",
    },
  ]);
  assert.deepEqual(validateInsightsPayload(payload), []);
});

test("a run without findings and without a review", () => {
  const { payload } = build({
    selection: EMPTY_SELECTION,
    posted: null,
    mode: "incremental",
  });

  assert.deepEqual(payload.findings, []);
  assert.equal(payload.githubReviewId, null);
  assert.equal(payload.mode, "incremental");
  assert.deepEqual(validateInsightsPayload(payload), []);
});

test("a review without an id has no id in the report", () => {
  const { payload } = build({
    posted: { reviewId: null, inlineComments: 0, fallback: false },
  });

  assert.equal(payload.githubReviewId, null);
});

test("after the fallback to a review without comments everything is body", () => {
  const { payload } = build({
    posted: { reviewId: 5, inlineComments: 0, fallback: true },
  });

  assert.deepEqual(
    payload.findings.map((entry) => entry.placement),
    ["body", "body", "body"],
  );
  // Line and fingerprint stay.
  assert.equal(payload.findings[0].line, 42);
  assert.equal(payload.findings[0].fingerprint, "5a1f0c9e3b7d2a46");
  assert.deepEqual(validateInsightsPayload(payload), []);
});

test("no text of the model and no title reaches the report", () => {
  const marked = preparedRun();
  marked.pullRequest.title = "KENNZEICHEN-TITEL";
  marked.selection.inline = marked.selection.inline.map((item, index) =>
    finding(item.path, item.line, item.severity, item.category, `KZ-${index}`),
  );
  marked.summary = "KENNZEICHEN-SUMMARY";
  marked.reviews = [{ summary: "KENNZEICHEN-SUMMARY" }];

  const text = JSON.stringify(buildInsightsPayload(marked).payload);

  for (const marker of ["KENNZEICHEN", "KZ-", "MARK", "title", "comment"]) {
    assert.ok(!text.includes(marker), `${marker} must not appear`);
  }
});

test("only the fields of the contract are in the report", () => {
  const { payload } = build();

  assert.deepEqual(validateInsightsPayload(payload), []);
  for (const entry of payload.findings) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "category",
      "fingerprint",
      "line",
      "path",
      "placement",
      "severity",
    ]);
  }
});

test("keeps at most 500 findings and counts the rest", () => {
  const many = Array.from({ length: 503 }, (_, index) =>
    finding(`f${index}.js`, 1, "info", "react"),
  );
  const { payload, omitted } = build({
    selection: {
      ...EMPTY_SELECTION,
      inline: many,
      fingerprints: many.map(() => "0123456789abcdef"),
    },
  });

  assert.equal(payload.findings.length, 500);
  assert.equal(payload.findings[0].path, "f0.js");
  assert.equal(payload.findings[499].path, "f499.js");
  assert.deepEqual(omitted, { overLimit: 3, longPath: 0 });
  assert.deepEqual(validateInsightsPayload(payload), []);
});

test("drops a finding with a path over 1024 characters and counts it", () => {
  const long = "a".repeat(1025);
  const exact = "b".repeat(1024);
  const { payload, omitted } = build({
    selection: {
      ...EMPTY_SELECTION,
      inline: [
        finding(long, 1, "major", "react"),
        finding(exact, 1, "major", "react"),
      ],
      fingerprints: ["0123456789abcdef", "0123456789abcdef"],
    },
  });

  assert.deepEqual(
    payload.findings.map((entry) => entry.path),
    [exact],
  );
  assert.deepEqual(omitted, { overLimit: 0, longPath: 1 });
  assert.deepEqual(validateInsightsPayload(payload), []);
});

test("counts the length of a path in UTF-16 units, never below code points", () => {
  // 600 emoji are 600 code points but 1200 UTF-16 units: dropped.
  const emoji = String.fromCodePoint(0x1f600).repeat(600);
  const { payload, omitted } = build({
    selection: {
      ...EMPTY_SELECTION,
      inline: [finding(emoji, 1, "major", "react")],
      fingerprints: ["0123456789abcdef"],
    },
  });

  assert.deepEqual(payload.findings, []);
  assert.equal(omitted.longPath, 1);
});

test("measures the time from the start to the finished report", () => {
  const times = [5000.4];
  const { payload } = build({ startedAt: 2000, now: () => times.shift() });

  assert.equal(payload.durationMs, 3000);
  assert.deepEqual(times, [], "the clock is read once");
});

test("a clock that runs backwards is a defect", () => {
  assert.throws(
    () => build({ startedAt: 5000, now: () => 1000 }),
    /invalid durationMs/,
  );
});

test("uses the global monotonic clock and a fresh UUID by default", () => {
  const startedAt = performance.now();
  const options = preparedRun({ startedAt });
  delete options.now;
  delete options.deliveryId;

  const first = buildInsightsPayload(options).payload;
  const second = buildInsightsPayload(options).payload;

  assert.deepEqual(validateInsightsPayload(first), []);
  assert.ok(first.durationMs >= 0 && first.durationMs < 5000);
  assert.notEqual(first.deliveryId, second.deliveryId);
});

test("rejects a delivery id that is not a UUID v4", () => {
  for (const deliveryId of [DELIVERY_ID.toUpperCase(), "abc", "7654321"]) {
    assert.throws(() => build({ deliveryId }), /invalid deliveryId/);
  }
});

test("rejects values that break the contract, naming only the field", () => {
  const long = { owner: "o".repeat(100), repo: "r".repeat(100) };
  const base = preparedRun().pullRequest;
  assert.throws(
    () => build({ pullRequest: { ...base, ...long } }),
    /invalid repository/,
  );
  assert.throws(
    () => build({ pullRequest: { ...base, pullNumber: 1.5 } }),
    /invalid prNumber/,
  );
  assert.throws(
    () =>
      build({ usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 } }),
    /invalid tokens\.input/,
  );
  assert.throws(
    () =>
      build({
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 2 ** 53 },
      }),
    /invalid tokens\.total/,
  );
});

test("does not change its arguments", () => {
  const options = preparedRun();
  const before = JSON.stringify(options);

  buildInsightsPayload(options);

  assert.equal(JSON.stringify(options), before);
});

// --- Documentation -----------------------------------------------------------

/** The flat field paths of a report: `tokens.input`, `findings[].line` ... */
function fieldPaths(value, prefix = "") {
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path);
    if (Array.isArray(child)) {
      paths.push(...fieldPaths(child[0] ?? {}, `${path}[]`));
    } else if (typeof child === "object" && child !== null) {
      paths.push(...fieldPaths(child, path));
    }
  }
  return paths;
}

test("the field table in docs/insights-payload.md equals the report", () => {
  const doc = readFileSync(fromRoot("docs/insights-payload.md"), "utf8");
  const table = doc.match(/## Fields([\s\S]*?)\n## /)[1];
  const documented = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);

  const { payload } = build();

  assert.deepEqual(documented.sort(), fieldPaths(payload).sort());
});

test("the example in docs/insights-payload.md is the fixture", () => {
  const doc = readFileSync(fromRoot("docs/insights-payload.md"), "utf8");
  const example = doc.match(/## Example[\s\S]*?```json\n([\s\S]*?)```/)[1];

  assert.deepStrictEqual(JSON.parse(example), FIXTURE);
});
