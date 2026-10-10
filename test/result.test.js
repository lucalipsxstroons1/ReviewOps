import assert from "node:assert/strict";
import { test } from "node:test";
import { lineFingerprint } from "../src/fingerprint.js";
import { fingerprintLine } from "../src/github/review.js";
import {
  apiFile,
  apiThread,
  OWN_ACCOUNT,
  startGitHubApi,
} from "./helpers/github-api.js";
import { reviewCompletion, startOpenAiApi } from "./helpers/openai-api.js";
import {
  PULL_REQUEST_EVENT,
  fromRoot,
  startAction,
  withInputs,
} from "./helpers/run-action.js";

// Process tests for the job summary, the outputs and fail-on (#19). The
// action runs as its own process; GitHub and OpenAI are local stand-ins.

const HEAD = "1".repeat(40);

const run = (api, inputs = {}) =>
  startAction(
    fromRoot("src/index.js"),
    withInputs({
      ...PULL_REQUEST_EVENT,
      GITHUB_API_URL: api.url,
      TEST_OPENAI_URL: api.openai.url,
      ...inputs,
    }),
  );

async function startApis(t, github, answer = reviewCompletion()) {
  const api = await startGitHubApi(t, github);
  return { ...api, openai: await startOpenAiApi(t, answer) };
}

// The pull request adds two lines and leaves out a lockfile.
const FILES = [
  apiFile("src/app.js", {
    additions: 2,
    deletions: 0,
    patch: "@@ -0,0 +1,2 @@\n+let a = 1;\n+let b = 2;",
  }),
  apiFile("package-lock.json"),
];

const finding = (severity, line = 2) => ({
  path: "src/app.js",
  line,
  severity,
  category: "security",
  title: `A ${severity} problem`,
  comment: "It breaks.",
  suggestion: "Fix it.",
});

/** The summary as a reader sees it: without escaping backslashes. */
const shown = (summary) => summary.replace(/\\([!-/:-@[-`{-~])/g, "$1");

const REVIEW_ADDRESS =
  "https://github.com/octo-org/demo/pull/42#pullrequestreview-1000";

test("writes a job summary with files, findings by severity and tokens", async (t) => {
  const api = await startApis(
    t,
    { files: FILES },
    reviewCompletion([finding("critical"), finding("minor", 1)]),
  );

  const result = await run(api);

  assert.equal(result.status, 0, result.output);
  const summary = shown(result.summary);
  assert.match(summary, /^## ReviewOps$/m);
  assert.match(summary, /\| Reviewed \| 1 \|/);
  assert.match(summary, /\| Skipped \| 1 \|/);
  assert.match(
    summary,
    /- `package-lock.json`: matches the default exclude pattern/,
  );
  assert.match(summary, /\| 🔴 Critical \| 1 \|/);
  assert.match(summary, /\| 🟡 Minor \| 1 \|/);
  assert.match(summary, /\| \*\*Total\*\* \| \*\*2\*\* \|/);
  // The answer of the stand-in counts 120 input and 30 output tokens.
  assert.match(summary, /\| 120 \| 30 \| 150 \| 1 \|/);
  assert.ok(summary.includes(`[Open the review](${REVIEW_ADDRESS})`));
  // The text of the model is not part of the summary.
  assert.doesNotMatch(
    summary,
    /It breaks|Nothing stands out|A critical problem/,
  );
});

test("sets the outputs for later steps", async (t) => {
  const api = await startApis(
    t,
    { files: FILES },
    reviewCompletion([finding("critical"), finding("major", 1)]),
  );

  const result = await run(api);

  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.outputs, {
    "findings-count": "2",
    "critical-count": "1",
    "review-url": REVIEW_ADDRESS,
  });
});

test("fails with fail-on critical after the review is posted", async (t) => {
  const api = await startApis(
    t,
    { files: FILES },
    reviewCompletion([finding("critical")]),
  );

  const result = await run(api, { "INPUT_FAIL-ON": "critical" });

  assert.equal(result.status, 1, result.output);
  // The review was posted before the step failed.
  assert.equal(api.reviews.length, 1);
  assert.equal(api.reviews[0].body.event, "COMMENT");
  assert.match(
    result.stdout,
    /::error::ReviewOps found 1 open findings at or above the severity "critical" \(fail-on: critical\)/,
  );
  const posted = result.stdout.indexOf("Posted a review");
  const failed = result.stdout.indexOf("::error::ReviewOps found");
  assert.ok(posted !== -1 && posted < failed);
  assert.equal(result.outputs["critical-count"], "1");
  assert.match(
    shown(result.summary),
    /fail-on: critical\*\* — 1 open findings/,
  );
});

test("lets no finding fail the workflow by default", async (t) => {
  const api = await startApis(
    t,
    { files: FILES },
    reviewCompletion([finding("critical")]),
  );

  const result = await run(api);

  assert.equal(result.status, 0, result.output);
  assert.equal(api.reviews.length, 1);
  assert.doesNotMatch(result.stdout, /::error::/);
  assert.equal(result.outputs["critical-count"], "1");
});

test("says No findings in the summary when nothing was found", async (t) => {
  const api = await startApis(t, { files: FILES }, reviewCompletion([]));

  const result = await run(api, { "INPUT_FAIL-ON": "critical" });

  assert.equal(result.status, 0, result.output);
  assert.deepEqual(api.reviews, []);
  assert.match(shown(result.summary), /^No findings\.$/m);
  assert.deepEqual(result.outputs, {
    "findings-count": "0",
    "critical-count": "0",
    "review-url": "",
  });
});

// --- Earlier findings ---------------------------------------------------------

const earlierComment = (severity) => ({
  id: 77,
  body: `<!-- reviewops -->\n${fingerprintLine(lineFingerprint("src/app.js", "let b = 2;", "let a = 1;"), severity)}\n\ntext`,
  user: OWN_ACCOUNT,
  path: "src/app.js",
});
const reviewedHead = {
  id: 5,
  body: "<!-- reviewops -->\n\n### ReviewOps",
  user: OWN_ACCOUNT,
  state: "COMMENTED",
  commit_id: HEAD,
};

test("a run again on the same commit stays red while a critical finding is open", async (t) => {
  const api = await startApis(t, {
    files: FILES,
    existingReviews: [reviewedHead],
    existingComments: [earlierComment("critical")],
  });

  const result = await run(api, { "INPUT_FAIL-ON": "critical" });

  assert.equal(result.status, 1, result.output);
  assert.equal(api.openai.requests.length, 0);
  assert.deepEqual(api.reviews, []);
  assert.ok(
    api.requests.some(
      ({ path, body }) =>
        path === "/graphql" && /reviewThreads/.test(body?.query),
    ),
  );
  assert.equal(result.outputs["critical-count"], "1");
});

test("a resolved thread takes an earlier critical finding out of the count", async (t) => {
  const api = await startApis(t, {
    files: FILES,
    existingReviews: [reviewedHead],
    existingComments: [earlierComment("critical")],
    threads: [apiThread(77, true)],
  });

  const result = await run(api, { "INPUT_FAIL-ON": "critical" });

  assert.equal(result.status, 0, result.output);
  assert.equal(result.outputs["critical-count"], "0");
  assert.match(shown(result.summary), /^No findings\.$/m);
  assert.match(shown(result.summary), /1 earlier findings are left out/);
});
