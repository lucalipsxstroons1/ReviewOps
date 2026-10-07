import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { lineFingerprint } from "../src/fingerprint.js";
import { fingerprintLine } from "../src/github/review.js";
import { apiFile, apiThread, startGitHubApi } from "./helpers/github-api.js";
import { reviewCompletion, startOpenAiApi } from "./helpers/openai-api.js";
import { loadEvent } from "./helpers/fake-context.js";
import {
  PULL_REQUEST_EVENT,
  fromRoot,
  startAction,
  withInputs,
} from "./helpers/run-action.js";

// Process tests for leaving out the review (#23): drafts, the skip label and
// bots. The action runs as its own process; GitHub and OpenAI are local
// stand-ins, and every test counts the requests to both.

const HEAD = "1".repeat(40);
const BOT = { type: "Bot", login: "github-actions[bot]" };

// The event files of the tests, removed when all of them are done.
const folders = [];
after(() => {
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

/** Writes the example event with a change and returns the variables for it. */
function eventWith(change) {
  const payload = loadEvent();
  change(payload);
  const folder = mkdtempSync(join(tmpdir(), "reviewops-event-"));
  folders.push(folder);
  const file = join(folder, "event.json");
  writeFileSync(file, JSON.stringify(payload));
  return { ...PULL_REQUEST_EVENT, GITHUB_EVENT_PATH: file };
}

const FILES = [
  apiFile("src/app.js", {
    additions: 2,
    deletions: 0,
    patch: "@@ -0,0 +1,2 @@\n+let a = 1;\n+let b = 2;",
  }),
];

const finding = {
  path: "src/app.js",
  line: 2,
  severity: "critical",
  category: "security",
  title: "A critical problem",
  comment: "It breaks.",
  suggestion: "Fix it.",
};

async function startApis(t, github = {}) {
  const api = await startGitHubApi(t, { files: FILES, ...github });
  return {
    ...api,
    openai: await startOpenAiApi(t, reviewCompletion([finding])),
  };
}

const run = (api, event, inputs = {}) =>
  startAction(
    fromRoot("src/index.js"),
    withInputs({
      ...event,
      GITHUB_API_URL: api.url,
      TEST_OPENAI_URL: api.openai.url,
      // The runner passes the default of action.yml when a workflow sets no
      // value. The process of a test gets none, so the default is set here.
      "INPUT_SKIP-LABEL": "no-ai-review",
      ...inputs,
    }),
  );

/** The summary as a reader sees it: without the escaping backslashes. */
const shown = (summary) => summary.replace(/\\([!-/:-@[-`{-~])/g, "$1");

/** Nothing was asked of the model, and nothing was written to GitHub. */
function assertNothingHappened(api) {
  assert.equal(api.openai.requests.length, 0, "the model was asked");
  assert.deepEqual(api.reviews, [], "a review was posted");
  assert.deepEqual(
    [...new Set(api.requests.map(({ method }) => method))].filter(
      (method) => !["GET", "POST"].includes(method),
    ),
    [],
  );
}

const LEFT_OUT =
  /^::notice::ReviewOps left out the review: (.*)\. A green run does not mean/m;

// --- Reasons -----------------------------------------------------------------

test("leaves out the review of a draft, ends green and says why", async (t) => {
  const api = await startApis(t);
  const event = eventWith((payload) => {
    payload.action = "synchronize";
    payload.pull_request.draft = true;
  });

  const result = await run(api, event);

  assert.equal(result.status, 0, result.output);
  assertNothingHappened(api);
  assert.match(result.stdout, LEFT_OUT);
  assert.match(
    result.stdout,
    /the pull request is a draft \(input review-drafts is false\)/,
  );
  assert.match(result.summary, /ReviewOps left out the review/);
  assert.match(shown(result.summary), /^No findings\.$/m);
});

test("reviews a draft when review-drafts is true", async (t) => {
  const api = await startApis(t);
  const event = eventWith((payload) => {
    payload.pull_request.draft = true;
  });

  const result = await run(api, event, { "INPUT_REVIEW-DRAFTS": "true" });

  assert.equal(result.status, 0, result.output);
  assert.equal(api.openai.requests.length, 1);
  assert.equal(api.reviews.length, 1);
});

test("the review starts when the draft is marked ready", async (t) => {
  const api = await startApis(t);
  const event = eventWith((payload) => {
    payload.action = "ready_for_review";
    payload.pull_request.draft = false;
  });

  const result = await run(api, event);

  assert.equal(result.status, 0, result.output);
  assert.equal(api.openai.requests.length, 1);
  assert.equal(api.reviews.length, 1);
  assert.doesNotMatch(result.stdout, LEFT_OUT);
});

test("leaves out a pull request with the skip label and names the label", async (t) => {
  const api = await startApis(t);
  const event = eventWith((payload) => {
    payload.pull_request.labels = [{ name: "No-AI-Review" }, { name: "bug" }];
  });

  const result = await run(api, event, { "INPUT_SKIP-LABEL": "no-ai-review" });

  assert.equal(result.status, 0, result.output);
  assertNothingHappened(api);
  assert.match(
    result.stdout,
    /the pull request has the label "no-ai-review" \(input skip-label\)/,
  );
  // The labels of the pull request are never written to the log.
  assert.doesNotMatch(result.output, /No-AI-Review|bug/);
});

test("reviews a pull request with the label when the skip label is switched off", async (t) => {
  const api = await startApis(t);
  const event = eventWith((payload) => {
    payload.pull_request.labels = [{ name: "no-ai-review" }];
  });

  const result = await run(api, event, { "INPUT_SKIP-LABEL": "" });

  assert.equal(result.status, 0, result.output);
  assert.equal(api.reviews.length, 1);
});

test("leaves out a pull request that a bot opened, also without an API key", async (t) => {
  const api = await startApis(t);
  const event = eventWith((payload) => {
    payload.pull_request.user = { login: "dependabot[bot]", type: "Bot" };
  });

  const result = await run(api, event, { "INPUT_OPENAI-API-KEY": "" });

  assert.equal(result.status, 0, result.output);
  assertNothingHappened(api);
  assert.match(
    result.stdout,
    /the pull request was opened by a bot \(input review-bots is false\)/,
  );
});

test("reviews a pull request of a bot when review-bots is true", async (t) => {
  const api = await startApis(t);
  const event = eventWith((payload) => {
    payload.pull_request.user = { login: "dependabot[bot]", type: "Bot" };
  });

  const result = await run(api, event, { "INPUT_REVIEW-BOTS": "true" });

  assert.equal(result.status, 0, result.output);
  assert.equal(api.reviews.length, 1);
});

test("a person who pushes to the branch of a bot changes nothing: the author counts", async (t) => {
  const api = await startApis(t);
  const event = eventWith((payload) => {
    payload.pull_request.user = { login: "octocat", type: "User" };
    payload.sender = { login: "dependabot[bot]", type: "Bot" };
  });

  const result = await run(api, event);

  assert.equal(result.status, 0, result.output);
  assert.equal(api.reviews.length, 1);
});

test("a draft from a fork is left out with the reason draft, not with the missing secret", async (t) => {
  const api = await startApis(t);
  const event = eventWith((payload) => {
    payload.pull_request.draft = true;
    payload.pull_request.head.repo.full_name = "someone/demo";
  });

  const result = await run(api, event, { "INPUT_OPENAI-API-KEY": "" });

  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /the pull request is a draft/);
  assert.doesNotMatch(result.stdout, /fork/i);
});

test("a pull request that is reviewed still needs the key", async (t) => {
  const api = await startApis(t);

  const result = await run(api, PULL_REQUEST_EVENT, {
    "INPUT_OPENAI-API-KEY": "",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Input `openai-api-key` is missing/);
});

// --- Labels as an event ------------------------------------------------------

test("takes the skip label off: the review starts", async (t) => {
  const api = await startApis(t);
  const event = eventWith((payload) => {
    payload.action = "unlabeled";
    payload.label = { name: "no-ai-review" };
    payload.pull_request.labels = [];
  });

  const result = await run(api, event);

  assert.equal(result.status, 0, result.output);
  assert.equal(api.openai.requests.length, 1);
  assert.equal(api.reviews.length, 1);
});

test("takes another label off: the run is left out", async (t) => {
  const api = await startApis(t);
  const event = eventWith((payload) => {
    payload.action = "unlabeled";
    payload.label = { name: "bug" };
    payload.pull_request.labels = [];
  });

  const result = await run(api, event);

  assert.equal(result.status, 0, result.output);
  assertNothingHappened(api);
  assert.match(result.stdout, /a label was removed that is not the skip label/);
});

// --- fail-on stays in force --------------------------------------------------

const earlierComment = (severity) => ({
  id: 77,
  body: `<!-- reviewops -->\n${fingerprintLine(lineFingerprint("src/app.js", "let b = 2;", "let a = 1;"), severity)}\n\ntext`,
  user: BOT,
  path: "src/app.js",
});
const reviewedHead = {
  id: 5,
  body: "<!-- reviewops -->\n\n### ReviewOps",
  user: BOT,
  state: "COMMENTED",
  commit_id: HEAD,
};

const labelled = (payload) => {
  payload.pull_request.labels = [{ name: "no-ai-review" }];
};

test("a label does not turn a red check green: fail-on counts the open finding", async (t) => {
  const api = await startApis(t, {
    existingReviews: [reviewedHead],
    existingComments: [earlierComment("critical")],
  });

  const result = await run(api, eventWith(labelled), {
    "INPUT_FAIL-ON": "critical",
  });

  assert.equal(result.status, 1, result.output);
  assertNothingHappened(api);
  assert.match(shown(result.summary), /\| 🔴 Critical \| 1 \|/);
  assert.match(result.stdout, LEFT_OUT);
  assert.match(result.stdout, /^::error::ReviewOps found 1 open findings/m);
});

test("takes another label off after a red run: the check stays red", async (t) => {
  const api = await startApis(t, {
    existingReviews: [reviewedHead],
    existingComments: [earlierComment("critical")],
  });
  const event = eventWith((payload) => {
    payload.action = "unlabeled";
    payload.label = { name: "bug" };
  });

  const result = await run(api, event, { "INPUT_FAIL-ON": "critical" });

  assert.equal(result.status, 1, result.output);
  assertNothingHappened(api);
});

test("without fail-on the left out run is green, with the open finding counted", async (t) => {
  const api = await startApis(t, {
    existingReviews: [reviewedHead],
    existingComments: [earlierComment("critical")],
  });

  const result = await run(api, eventWith(labelled));

  assert.equal(result.status, 0, result.output);
  assertNothingHappened(api);
  assert.match(shown(result.summary), /\| 🔴 Critical \| 1 \|/);
});

test("a resolved thread takes the finding out of the count of a left out run", async (t) => {
  const api = await startApis(t, {
    existingReviews: [reviewedHead],
    existingComments: [earlierComment("critical")],
    threads: [apiThread(77, true)],
  });

  const result = await run(api, eventWith(labelled), {
    "INPUT_FAIL-ON": "critical",
  });

  assert.equal(result.status, 0, result.output);
  assert.match(shown(result.summary), /^No findings\.$/m);
});

// --- Log ---------------------------------------------------------------------

test("a left out run logs no line about files, limits or masked strings", async (t) => {
  const api = await startApis(t);

  const result = await run(api, eventWith(labelled));

  assert.doesNotMatch(
    result.stdout,
    /Found \d+ changed files|Diff size|Skipped |Masked /,
  );
  assert.doesNotMatch(result.stdout, /Sending \d+ files/);
});

// --- Inputs that cannot be used ----------------------------------------------

for (const [name, inputs] of [
  ["review-drafts", { "INPUT_REVIEW-DRAFTS": "yes" }],
  ["review-bots", { "INPUT_REVIEW-BOTS": "1" }],
  ["skip-label", { "INPUT_SKIP-LABEL": "x".repeat(51) }],
]) {
  test(`fails before any request when ${name} cannot be used`, async (t) => {
    const api = await startApis(t);

    const result = await run(api, PULL_REQUEST_EVENT, inputs);

    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`^::error::Input \`${name}\``, "m"));
    assert.deepEqual(api.requests, []);
    assert.deepEqual(api.openai.requests, []);
  });
}
