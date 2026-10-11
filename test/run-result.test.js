import assert from "node:assert/strict";
import { test } from "node:test";
import { SEVERITIES } from "../src/ai/schema.js";
import { run } from "../src/main.js";
import { SCENARIOS } from "./helpers/run-scenarios.js";
import { recordRun } from "./helpers/transcript.js";

// What `run()` returns (#114): a result with numbers, fixed texts and file
// paths, at every way a run ends and after every error. Whoever needs the
// figures of a run (the comparison of models, later a command) reads them
// here and not from lines of the log.

const FIELDS = [
  "end",
  "error",
  "failed",
  "files",
  "findings",
  "insights",
  "insightsStatus",
  "outputs",
  "reviewUrl",
  "selection",
  "since",
  "status",
  "threshold",
  "usage",
];

/** How each run of the scenarios ends. */
const ENDS_OF = {
  "end-other-event": "other-event",
  "end-fork-without-key": "fork-without-key",
  "end-closed-without-report": "closed-without-report",
  "end-closed-with-status-report": "closed",
  "end-left-out-with-open-finding-and-fail-on": "left-out",
  "end-nothing-new": "nothing-to-review",
  "end-no-files-to-review": "nothing-to-review",
  "end-no-findings-with-report": "no-findings",
  "end-posted-with-both-reports": "posted",
  "end-posted-after-rejection-of-the-comments": "posted",
  "error-input-cannot-be-used": "failed",
  "error-earlier-work-cannot-be-read": "failed",
  "error-every-request-to-the-model-failed": "failed",
  "error-posting-the-review-is-refused": "failed",
  "error-one-of-two-requests-failed": "posted",
};

const resultOf = async (name) =>
  (await recordRun(run, SCENARIOS[name]())).result;

test("every run of the scenarios is covered by this test", () => {
  assert.deepEqual(Object.keys(ENDS_OF).sort(), Object.keys(SCENARIOS).sort());
});

for (const [name, end] of Object.entries(ENDS_OF)) {
  test(`${name}: run() returns a result that ends with "${end}"`, async () => {
    const result = await resultOf(name);

    assert.equal(typeof result, "object");
    assert.deepEqual(Object.keys(result).sort(), FIELDS);
    assert.equal(result.end, end);
    assert.equal(typeof result.status, "string");
    assert.equal(typeof result.failed, "boolean");
    // The outputs are set at every regular end and after no error.
    assert.equal(result.outputs === null, end === "failed");
  });
}

// --- What the result holds --------------------------------------------------------

test("a run that is not about this event or has no key reports zero outputs", async () => {
  for (const name of [
    "end-other-event",
    "end-fork-without-key",
    "end-closed-without-report",
  ]) {
    const result = await resultOf(name);
    assert.deepEqual(result.outputs, {
      findingsCount: 0,
      criticalCount: 0,
      reviewUrl: null,
    });
    assert.equal(result.failed, false);
    assert.equal(result.error, null);
    assert.equal(result.files, null);
    assert.equal(result.usage, null);
  }
});

test("a run that posted a review names the review, the findings and the figures", async () => {
  const result = await resultOf("end-posted-with-both-reports");

  assert.equal(
    result.reviewUrl,
    "https://github.com/octo-org/demo/pull/42#pullrequestreview-1000",
  );
  assert.deepEqual(result.outputs, {
    findingsCount: 3,
    criticalCount: 1,
    reviewUrl: result.reviewUrl,
  });
  assert.equal(result.findings.total, 3);
  assert.deepEqual(result.findings.bySeverity, {
    critical: 1,
    major: 1,
    minor: 1,
    info: 0,
  });
  assert.deepEqual(result.threshold, { failOn: "major", reached: 2 });
  // `fail-on` was reached: the step failed, without an error of the run.
  assert.equal(result.failed, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.files.skipped, []);
  assert.equal(result.files.reviewed, 2);
  assert.deepEqual(result.usage, {
    inputTokens: 900,
    outputTokens: 100,
    totalTokens: 1000,
    withoutCount: 0,
    requests: 1,
    failed: 0,
  });
  // The findings of this run that the review shows, by severity.
  assert.deepEqual(result.selection, {
    skippedByLimits: 0,
    overMaxComments: 0,
    failedRequests: 0,
    shown: { critical: 0, major: 1, minor: 1, info: 0 },
  });
  assert.equal(result.insights.text, "The report reached ReviewOps Insights.");
  assert.equal(
    result.insightsStatus.text,
    "The status report reached ReviewOps Insights.",
  );
});

test("a run that failed in part counts the failed requests and the files that were not reviewed", async () => {
  const result = await resultOf("error-one-of-two-requests-failed");

  assert.equal(result.failed, false);
  assert.equal(result.selection.failedRequests, 1);
  assert.equal(result.files.reviewed, 1);
  assert.deepEqual(result.files.skipped, [
    { path: "src/other.js", reason: "the request to the model failed" },
  ]);
  assert.equal(result.usage.requests, 2);
  assert.equal(result.usage.failed, 1);
});

test("a run that stopped at a limit counts the files at the limit", async () => {
  const result = await resultOf("end-no-files-to-review");

  assert.equal(result.selection.skippedByLimits, 0);
  assert.equal(result.selection.shown, null);
});

test("a run that ended with an error keeps what was known by then", async () => {
  const input = await resultOf("error-input-cannot-be-used");
  assert.equal(input.end, "failed");
  assert.equal(input.failed, true);
  assert.match(input.error, /^Input `openai-model` must be the name/);
  assert.equal(input.files, null);

  const history = await resultOf("error-earlier-work-cannot-be-read");
  assert.match(history.error, /HTTP 403/);
  assert.equal(history.files, null);

  const posting = await resultOf("error-posting-the-review-is-refused");
  assert.match(posting.error, /HTTP 403/);
  assert.equal(posting.files.reviewed, 1);
  assert.equal(posting.usage.requests, 1);
  assert.equal(posting.usage.inputTokens, 900);
  // A run that ends with an error sends no report.
  assert.equal(posting.insights, null);
  assert.equal(posting.insightsStatus, null);

  const model = await resultOf("error-every-request-to-the-model-failed");
  assert.match(model.error, /^OpenAI did not answer/);
  // Not one request worked: the files count as not reviewed, and there are no
  // tokens to show.
  assert.equal(model.files.reviewed, 0);
  assert.equal(model.usage, null);
});

test("the figures of the selection have one entry for each severity, or none", async () => {
  for (const name of Object.keys(SCENARIOS)) {
    const { shown } = (await resultOf(name)).selection;
    if (shown === null) continue;
    assert.deepEqual(Object.keys(shown), [...SEVERITIES], name);
  }
});

// --- What the result must not hold ---------------------------------------------------

test("no result holds the text of a finding, a line of a diff or a credential", async () => {
  const forbidden = [
    // The texts of the findings of the stand-in model.
    "A problem at line 2",
    "A problem outside of the diff",
    "What is wrong.",
    "What to change.",
    "A summary.",
    // A line of a diff and a body of a review.
    "let a = 1;",
    "let b = 2;",
    "<!-- reviewops",
    // The credentials of the stand-ins.
    "token-value",
    "key-value",
    "ssssssssss",
  ];
  for (const name of Object.keys(SCENARIOS)) {
    const text = JSON.stringify(await resultOf(name));
    for (const fragment of forbidden) {
      assert.ok(!text.includes(fragment), `${name}: ${fragment}`);
    }
  }
});

test("a result is plain data that can be written as text", async () => {
  for (const name of Object.keys(SCENARIOS)) {
    const result = await resultOf(name);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, name);
  }
});
