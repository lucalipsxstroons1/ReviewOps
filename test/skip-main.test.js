import assert from "node:assert/strict";
import { test } from "node:test";
import { lineFingerprint } from "../src/fingerprint.js";
import { fingerprintLine } from "../src/github/review.js";
import { run } from "../src/main.js";
import { createFakeContext, loadEvent } from "./helpers/fake-context.js";
import { createFakeCore } from "./helpers/fake-core.js";
import {
  apiFailure,
  apiFile,
  createFakeOctokit,
  OWN_ACCOUNT,
} from "./helpers/github-api.js";

// Unit tests of `run()` for leaving out the review (#23): what the run does,
// and what it never does, without a process.

const INPUTS = {
  "github-token": "token-value",
  "openai-api-key": "key-value",
  "skip-label": "no-ai-review",
};

const FILES = [
  apiFile("src/app.js", {
    additions: 2,
    deletions: 0,
    patch: "@@ -0,0 +1,2 @@\n+let a = 1;\n+let b = 2;",
  }),
];

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
  commit_id: "1".repeat(40),
};

/** Runs the action; the client of the model is a trap. */
async function runWith({ inputs = {}, change = () => {}, octokit } = {}) {
  const core = createFakeCore({ ...INPUTS, ...inputs });
  const payload = loadEvent();
  change(payload);
  const client = octokit ?? createFakeOctokit(FILES);
  let modelAsked = false;

  await run({
    core,
    context: createFakeContext({ payload }),
    getOctokit: () => client,
    createAiClient: () => {
      modelAsked = true;
      throw new Error("the model must not be asked");
    },
  });
  return { core, client, modelAsked };
}

const draft = (payload) => {
  payload.pull_request.draft = true;
};
const labelled = (payload) => {
  payload.pull_request.labels = [{ name: "No-AI-Review" }];
};

test("a draft is left out: no request to the model, no review, a notice with the reason", async () => {
  const { core, client, modelAsked } = await runWith({ change: draft });

  assert.equal(modelAsked, false);
  assert.deepEqual(client.reviews, []);
  assert.deepEqual(core.messages("setFailed"), []);
  assert.deepEqual(core.messages("notice"), [
    "ReviewOps left out the review: the pull request is a draft (input review-drafts is false). A green run does not mean that this pull request was reviewed.",
  ]);
});

test("a left out run sets the outputs to zero", async () => {
  const { core } = await runWith({ change: labelled });

  assert.deepEqual(core.outputs, {
    "findings-count": "0",
    "critical-count": "0",
    "review-url": "",
  });
});

test("a left out run needs no key and does not look at it", async () => {
  const { core, modelAsked } = await runWith({
    inputs: { "openai-api-key": "" },
    change: draft,
  });

  assert.equal(modelAsked, false);
  assert.deepEqual(core.messages("setFailed"), []);
});

test("a left out run still needs the token", async () => {
  const { core } = await runWith({
    inputs: { "github-token": "" },
    change: draft,
  });

  assert.match(core.messages("setFailed")[0], /Input `github-token` is empty/);
});

test("a left out run reads the files and the earlier reviews, and nothing else", async () => {
  const { client } = await runWith({ change: labelled });

  assert.equal(client.calls.length, 3);
  assert.deepEqual(client.reviews, []);
  assert.deepEqual(client.comparisons, []);
});

test("an earlier critical finding fails the step with fail-on, also when the review is left out", async () => {
  const octokit = createFakeOctokit(FILES, {
    existingReviews: [reviewedHead],
    existingComments: [earlierComment("critical")],
  });

  const { core, modelAsked } = await runWith({
    inputs: { "fail-on": "critical" },
    change: labelled,
    octokit,
  });

  assert.equal(modelAsked, false);
  assert.equal(core.outputs["critical-count"], "1");
  assert.match(
    core.messages("setFailed")[0],
    /found 1 open findings at or above the severity "critical"/,
  );
});

test("without fail-on the same run is green and counts the finding", async () => {
  const octokit = createFakeOctokit(FILES, {
    existingReviews: [reviewedHead],
    existingComments: [earlierComment("critical")],
  });

  const { core } = await runWith({ change: labelled, octokit });

  assert.deepEqual(core.messages("setFailed"), []);
  assert.equal(core.outputs["critical-count"], "1");
});

test("the labels of the pull request never reach the log", async () => {
  const { core } = await runWith({
    change: (payload) => {
      payload.pull_request.labels = [
        { name: "No-AI-Review" },
        { name: "SECRET-LABEL-654321" },
      ];
    },
  });

  const log = JSON.stringify(core.calls);
  assert.ok(!log.includes("SECRET-LABEL-654321"));
  assert.ok(!log.includes("No-AI-Review"));
  assert.ok(log.includes('the label \\"no-ai-review\\"'));
});

test("every other pull request is reviewed as before", async () => {
  const core = createFakeCore(INPUTS);
  const client = createFakeOctokit(FILES);
  let asked = 0;

  await run({
    core,
    context: createFakeContext(),
    getOctokit: () => client,
    createAiClient: () => ({
      async complete() {
        asked += 1;
        return {
          content: JSON.stringify({
            summary: "Nothing stands out.",
            findings: [],
          }),
          finishReason: "stop",
          usage: null,
          model: "gpt-6-luna",
          requestId: null,
        };
      },
    }),
  });

  assert.equal(asked, 1);
  assert.deepEqual(core.messages("notice"), []);
});

test("a left out run fails when the account of the token cannot be read", async () => {
  const octokit = createFakeOctokit(FILES, {
    existingReviews: [reviewedHead],
    viewer: () => apiFailure(403),
  });

  const { core, modelAsked } = await runWith({ change: labelled, octokit });

  assert.equal(modelAsked, false);
  assert.match(core.messages("setFailed")[0], /HTTP 403/);
});

test("a left out run counts no finding of another bot", async () => {
  const octokit = createFakeOctokit(FILES, {
    existingReviews: [reviewedHead],
    existingComments: [
      {
        ...earlierComment("critical"),
        user: { type: "Bot", login: "other[bot]", id: 49699333 },
      },
    ],
  });

  const { core } = await runWith({
    inputs: { "fail-on": "critical" },
    change: labelled,
    octokit,
  });

  assert.equal(core.outputs["critical-count"], "0");
  assert.deepEqual(core.messages("setFailed"), []);
});
