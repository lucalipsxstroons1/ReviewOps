import assert from "node:assert/strict";
import { test } from "node:test";
import { AiError } from "../src/ai/error.js";
import { PROMPT_VERSION } from "../src/ai/prompt.js";
import { run } from "../src/main.js";
import { ACTION_VERSION } from "../src/version.js";
import { createFakeContext, loadEvent } from "./helpers/fake-context.js";
import { createFakeCore } from "./helpers/fake-core.js";
import { apiFile, createFakeOctokit } from "./helpers/github-api.js";
import { validateInsightsPayload } from "./helpers/insights-contract.js";

// Unit tests of `run()` for the report to ReviewOps Insights (#76): when it is
// built, when it is sent, and that it never changes how the run ends. The
// sender is a stand-in; the process tests send to a local server.

const SECRET = `TESTSECRET-not-a-real-secret-${"0123456789abcdef"}`;
const ADDRESS = "https://insights.example.com/api/v1/ingest/review";
const INPUTS = {
  "github-token": "token-value",
  "openai-api-key": "key-value",
  "skip-label": "no-ai-review",
};
const ON = { "insights-url": ADDRESS, "insights-secret": SECRET };

const FILES = [
  apiFile("src/app.js", {
    additions: 2,
    deletions: 0,
    patch: "@@ -0,0 +1,2 @@\n+let a = 1;\n+let b = 2;",
  }),
];

const finding = (severity = "major", line = 2) => ({
  path: "src/app.js",
  line,
  severity,
  category: "security",
  title: "A problem",
  comment: "It breaks.",
  suggestion: "Fix it.",
});

const modelAnswer = (findings = []) => ({
  content: JSON.stringify({ summary: "A summary.", findings }),
  finishReason: "stop",
  usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
  model: "gpt-6-luna",
  requestId: null,
});

const DELIVERED = {
  delivered: true,
  outcome: "created",
  httpStatus: 201,
  attempts: 1,
};

/**
 * A stand-in for `sendInsightsReport()`. It records what it was given and
 * which outputs were set at that moment, then answers with `result`, or throws
 * it when it is an error.
 */
function fakeSender(core, result = DELIVERED) {
  const sent = [];
  const send = async (options) => {
    sent.push({ ...options, outputsAtCall: { ...core.outputs } });
    if (result instanceof Error) throw result;
    return result;
  };
  return { send, sent };
}

/** Runs the action with the report switched on, unless `inputs` says else. */
async function runWith({
  inputs = ON,
  change = () => {},
  files = FILES,
  respond = () => modelAnswer([finding()]),
  result,
  context = {},
  octokit,
} = {}) {
  const core = createFakeCore({ ...INPUTS, ...inputs });
  const payload = loadEvent();
  change(payload);
  const client = octokit ?? createFakeOctokit(files);
  const { send, sent } = fakeSender(core, result);
  const requests = [];
  const tokens = [];

  await run({
    core,
    context: createFakeContext({
      payload,
      runId: 18234567890,
      runAttempt: 2,
      ...context,
    }),
    getOctokit: (token) => {
      tokens.push(token);
      return client;
    },
    createAiClient: () => ({
      async complete(request) {
        const answer = respond(request, requests.length);
        requests.push(request);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    }),
    sendInsightsReport: send,
  });
  return { core, client, sent, requests, tokens };
}

/** Everything the run wrote: log lines, notices, warnings, summary, outputs. */
const everythingWritten = (core) =>
  JSON.stringify([
    core.calls.filter((call) => call.method !== "setSecret"),
    core.summaries,
  ]);

// The summary as a reader sees it: without the escaping backslashes.
const summaryOf = (core) =>
  core.summaries.join("\n").replace(/\\([!-/:-@[-`{-~])/g, "$1");

// --- Off ---------------------------------------------------------------------

test("without an address it sends nothing and never mentions Insights", async () => {
  const { core, sent } = await runWith({ inputs: {} });

  assert.deepEqual(sent, []);
  assert.doesNotMatch(everythingWritten(core), /insights/i);
  assert.deepEqual(core.messages("setFailed"), []);
});

test("a secret without an address changes nothing", async () => {
  const { core, sent } = await runWith({
    inputs: { "insights-secret": SECRET },
  });

  assert.deepEqual(sent, []);
  assert.doesNotMatch(everythingWritten(core), /insights/i);
});

// --- One report per run ------------------------------------------------------

test("sends one report after a review, built from the run", async () => {
  const { core, sent } = await runWith();

  assert.equal(sent.length, 1);
  const [{ url, secret, payload }] = sent;
  assert.equal(url, ADDRESS);
  assert.equal(secret, SECRET);
  assert.deepEqual(validateInsightsPayload(payload), []);
  assert.equal(payload.repository, "octo-org/demo");
  assert.equal(payload.prNumber, 42);
  assert.equal(payload.runId, 18234567890);
  assert.equal(payload.runAttempt, 2);
  assert.equal(payload.model, "gpt-6-luna");
  assert.deepEqual(payload.tokens, { input: 1200, output: 300, total: 1500 });
  assert.equal(payload.mode, "full");
  assert.equal(payload.actionVersion, ACTION_VERSION);
  assert.equal(payload.promptVersion, PROMPT_VERSION);
  assert.equal(payload.githubReviewId, 1000);
  assert.equal(payload.findings.length, 1);
  assert.equal(payload.findings[0].severity, "major");
  assert.equal(payload.findings[0].placement, "inline");
  assert.deepEqual(core.messages("setFailed"), []);
});

test("the report holds no text of the model and no title", async () => {
  const { sent } = await runWith({
    respond: () =>
      modelAnswer([
        {
          ...finding(),
          title: "TITLE-OF-THE-MODEL",
          comment: "COMMENT-OF-THE-MODEL",
          suggestion: "SUGGESTION-OF-THE-MODEL",
        },
      ]),
  });

  const text = JSON.stringify(sent[0].payload);
  for (const word of [
    "TITLE-OF-THE-MODEL",
    "COMMENT-OF-THE-MODEL",
    "SUGGESTION-OF-THE-MODEL",
    "A summary.",
    "Update the thing",
  ]) {
    assert.equal(text.includes(word), false, word);
  }
});

test("sends a report with no findings after a run that found none", async () => {
  const { core, sent } = await runWith({ respond: () => modelAnswer([]) });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload.findings, []);
  assert.equal(sent[0].payload.githubReviewId, null);
  assert.deepEqual(validateInsightsPayload(sent[0].payload), []);
  assert.ok(
    core.messages("info").includes("No findings, so no review was posted."),
  );
});

test("names the host before anything else happens, once", async () => {
  const { core } = await runWith();

  const lines = core
    .messages("info")
    .filter((line) => line.includes("ReviewOps Insights at"));
  assert.deepEqual(lines, [
    "The report of this run goes to ReviewOps Insights at insights.example.com.",
  ]);
  assert.equal(core.messages("info")[0], "ReviewOps started.");
  assert.equal(core.messages("info")[1], lines[0]);
});

test("sets the outputs before it sends, and writes the summary after", async () => {
  const { core, sent } = await runWith();

  assert.equal(sent[0].outputsAtCall["findings-count"], "1");
  assert.equal(sent[0].outputsAtCall["review-url"].length > 0, true);
  assert.equal(core.summaries.length, 1);
  assert.match(
    summaryOf(core),
    /### ReviewOps Insights\n\nThe report reached ReviewOps Insights\./,
  );
});

test("says in the summary and the log that a known report was known", async () => {
  const { core } = await runWith({
    result: {
      delivered: true,
      outcome: "duplicate",
      httpStatus: 200,
      attempts: 1,
    },
  });

  assert.match(summaryOf(core), /which knew it already/);
  assert.ok(
    core
      .messages("info")
      .includes(
        "Report delivered to ReviewOps Insights: it was known already (HTTP 200), 1 attempt.",
      ),
  );
});

// --- Runs that send nothing --------------------------------------------------

for (const [name, options] of [
  ["a draft", { change: (payload) => (payload.pull_request.draft = true) }],
  ["a pull request without files to review", { files: [] }],
  [
    "a run whose requests all failed",
    { respond: () => new AiError("auth", "OpenAI rejected the API key.", 401) },
  ],
]) {
  test(`sends nothing after ${name}`, async () => {
    const { core, sent } = await runWith(options);

    assert.deepEqual(sent, []);
    assert.doesNotMatch(summaryOf(core), /Insights/);
  });
}

test("a run that left out the review does not ask the model and sends nothing", async () => {
  const { sent, requests } = await runWith({
    change: (payload) => (payload.pull_request.draft = true),
  });

  assert.deepEqual(requests, []);
  assert.deepEqual(sent, []);
});

test("sends nothing after an error, also one that comes after the model answered", async () => {
  const { core, sent } = await runWith({
    octokit: createFakeOctokit(FILES, {
      createReview: () =>
        Object.assign(new Error("Forbidden"), { status: 403 }),
    }),
  });

  assert.equal(core.messages("setFailed").length, 1);
  assert.deepEqual(sent, []);
  assert.doesNotMatch(summaryOf(core), /Insights/);
});

test("sends nothing on another event", async () => {
  const core = createFakeCore({ ...INPUTS, ...ON });
  const { send, sent } = fakeSender(core);

  await run({
    core,
    context: createFakeContext({ eventName: "push" }),
    sendInsightsReport: send,
  });

  assert.deepEqual(sent, []);
});

// --- The result of the run stays what it was ---------------------------------

const FAILURES = [
  [
    "a rejected signature",
    {
      delivered: false,
      reason: "http",
      httpStatus: 401,
      code: "UNAUTHORIZED",
      attempts: 1,
    },
  ],
  ["a timeout", { delivered: false, reason: "timeout", attempts: 3 }],
  [
    "a redirect",
    { delivered: false, reason: "redirect", httpStatus: 301, attempts: 1 },
  ],
  [
    "a network error",
    {
      delivered: false,
      reason: "network",
      detail: "ECONNREFUSED",
      attempts: 3,
    },
  ],
  [
    "a sender that throws",
    new Error(
      "boom with the address https://insights.example.com and a secret",
    ),
  ],
];

for (const [name, result] of FAILURES) {
  test(`${name} ends the run as it would have ended without Insights`, async () => {
    const without = await runWith({ inputs: {} });
    const withIt = await runWith({ result });

    assert.deepEqual(withIt.core.outputs, without.core.outputs);
    assert.deepEqual(
      withIt.core.messages("setFailed"),
      without.core.messages("setFailed"),
    );
    assert.equal(withIt.sent.length, 1);
    assert.equal(withIt.core.messages("warning").length, 1);
  });
}

test("names the status and the attempts in the warning for a rejected signature", async () => {
  const { core } = await runWith({ result: FAILURES[0][1] });

  assert.deepEqual(core.messages("warning"), [
    "The report for ReviewOps Insights was not delivered: HTTP 401, UNAUTHORIZED, after 1 attempt. Check that `insights-secret` has the same value as `INGEST_SECRET` at ReviewOps Insights.",
  ]);
  assert.match(
    summaryOf(core),
    /did not reach ReviewOps Insights \(HTTP 401, UNAUTHORIZED\)/,
  );
});

test("names a timeout with the number of attempts", async () => {
  const { core } = await runWith({ result: FAILURES[1][1] });

  assert.deepEqual(core.messages("warning"), [
    "The report for ReviewOps Insights was not delivered: timeout, after 3 attempts.",
  ]);
});

test("names a redirect with its status", async () => {
  const { core } = await runWith({ result: FAILURES[2][1] });

  assert.match(
    core.messages("warning")[0],
    /redirect \(HTTP 301\), after 1 attempt\./,
  );
});

test("a sender that throws ends in a warning with a fixed text", async () => {
  const { core } = await runWith({ result: FAILURES[4][1] });

  assert.deepEqual(core.messages("warning"), [
    "The report for ReviewOps Insights could not be built or sent.",
  ]);
  assert.doesNotMatch(
    everythingWritten(core),
    /boom|insights\.example\.com\/api/,
  );
});

test("a run id that is not valid ends in a warning, not in an error", async () => {
  const { core, sent } = await runWith({
    context: { runId: Number.NaN },
  });

  assert.deepEqual(sent, []);
  assert.deepEqual(core.messages("warning"), [
    "The report for ReviewOps Insights could not be built or sent.",
  ]);
  assert.deepEqual(core.messages("setFailed"), []);
  assert.ok(
    core.messages("debug").includes("GITHUB_RUN_ID is not a valid run number."),
  );
});

for (const failOn of ["critical", "major"]) {
  for (const [name, result] of [
    ["delivered", DELIVERED],
    ["not delivered", FAILURES[0][1]],
  ]) {
    test(`fail-on ${failOn} fails the step the same way when the report is ${name}`, async () => {
      const inputs = { ...ON, "fail-on": failOn };
      const respond = () => modelAnswer([finding("critical")]);
      const without = await runWith({ inputs: { "fail-on": failOn }, respond });
      const withIt = await runWith({ inputs, respond, result });

      assert.equal(withIt.core.messages("setFailed").length, 1);
      assert.deepEqual(
        withIt.core.messages("setFailed"),
        without.core.messages("setFailed"),
      );
      assert.deepEqual(withIt.core.outputs, without.core.outputs);
      // A run that fails on its findings still reports them.
      assert.equal(withIt.sent.length, 1);
    });
  }
}

// --- Before the first request ------------------------------------------------

for (const [name, url] of [
  ["http", "http://insights.example.com/x"],
  ["credentials", "https://admin:hunter22@insights.example.com/x"],
  ["a query", "https://insights.example.com/x?a=1"],
  ["a fragment", "https://insights.example.com/x#a"],
  ["no valid form", "not an address"],
]) {
  test(`an address with ${name} fails the run before any request`, async () => {
    const { core, tokens, requests, sent } = await runWith({
      inputs: { "insights-url": url, "insights-secret": SECRET },
    });

    assert.equal(core.messages("setFailed").length, 1);
    assert.match(core.messages("setFailed")[0], /^Input `insights-url`/);
    assert.deepEqual(tokens, []);
    assert.deepEqual(requests, []);
    assert.deepEqual(sent, []);
    assert.doesNotMatch(everythingWritten(core), /hunter22/);
  });
}

test("a secret that cannot be used fails the run before any request", async () => {
  const { core, tokens, sent } = await runWith({
    inputs: { "insights-url": ADDRESS, "insights-secret": "hunter22-short" },
  });

  assert.match(
    core.messages("setFailed")[0],
    /^Input `insights-secret` is too short/,
  );
  assert.deepEqual(tokens, []);
  assert.deepEqual(sent, []);
  assert.doesNotMatch(everythingWritten(core), /hunter22/);
});

test("an address without a secret fails the run and says what to do", async () => {
  const { core, tokens, sent } = await runWith({
    inputs: { "insights-url": ADDRESS },
  });

  assert.equal(core.messages("setFailed").length, 1);
  assert.match(
    core.messages("setFailed")[0],
    /^Input `insights-secret` is missing\./,
  );
  assert.match(core.messages("setFailed")[0], /secrets\.INSIGHTS_SECRET/);
  assert.deepEqual(tokens, []);
  assert.deepEqual(sent, []);
});

test("an address is checked also when the review is left out", async () => {
  const { core, tokens } = await runWith({
    inputs: {
      "insights-url": "http://insights.example.com/x",
      "insights-secret": SECRET,
    },
    change: (payload) => (payload.pull_request.draft = true),
  });

  assert.match(core.messages("setFailed")[0], /^Input `insights-url`/);
  assert.deepEqual(tokens, []);
});

test("names the host also in a run that leaves out the review, and sends nothing", async () => {
  const { core, sent } = await runWith({
    change: (payload) => (payload.pull_request.draft = true),
  });

  assert.deepEqual(sent, []);
  assert.ok(
    core
      .messages("info")
      .includes(
        "The report of this run goes to ReviewOps Insights at insights.example.com.",
      ),
  );
  assert.doesNotMatch(summaryOf(core), /Insights/);
});

// --- Forks and Dependabot ----------------------------------------------------

test("a run of Dependabot without the secret reviews, sends nothing and says why", async () => {
  const { core, sent, requests } = await runWith({
    inputs: { "insights-url": ADDRESS },
    context: { actor: "dependabot[bot]" },
  });

  assert.deepEqual(core.messages("setFailed"), []);
  assert.equal(requests.length, 1, "the review did not take place");
  assert.deepEqual(sent, []);
  const notices = core.messages("notice");
  assert.equal(notices.length, 1);
  assert.match(
    notices[0],
    /was not sent: the secret in `insights-secret` is not available/,
  );
  assert.match(summaryOf(core), /not available in this run/);
});

test("a pull request from a fork without any secret still ends green with the old notice", async () => {
  const core = createFakeCore({
    "github-token": "token-value",
    "insights-url": ADDRESS,
  });
  const payload = loadEvent();
  payload.pull_request.head.repo.full_name = "someone/demo";
  const { send, sent } = fakeSender(core);

  await run({
    core,
    context: createFakeContext({ payload }),
    getOctokit: () => assert.fail("no request to GitHub"),
    sendInsightsReport: send,
  });

  assert.deepEqual(core.messages("setFailed"), []);
  assert.match(core.messages("notice")[0], /it comes from a fork/);
  assert.deepEqual(sent, []);
  assert.doesNotMatch(everythingWritten(core), /Insights/);
});

// --- Secrets stay out --------------------------------------------------------

test("the secret and the address appear in no line, warning or summary", async () => {
  for (const result of [DELIVERED, ...FAILURES.map(([, r]) => r)]) {
    const { core } = await runWith({ result });

    const text = everythingWritten(core);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(ADDRESS), false);
    assert.equal(text.includes("/api/v1/ingest"), false);
  }
});

test("registers the secret for masking, but not the address", async () => {
  const { core } = await runWith();

  assert.ok(core.messages("setSecret").includes(SECRET));
  assert.equal(core.messages("setSecret").includes(ADDRESS), false);
});

test("redacts a secret that a result would carry into a warning", async () => {
  // A code that happens to contain the secret is no identifier and is dropped
  // by the sender; the redactor is the second net under it.
  const { core } = await runWith({
    result: {
      delivered: false,
      reason: "http",
      httpStatus: 400,
      code: SECRET,
      attempts: 1,
    },
  });

  assert.equal(everythingWritten(core).includes(SECRET), false);
  assert.match(
    summaryOf(core),
    /did not reach ReviewOps Insights \(HTTP 400, \*\*\*\)/,
  );
});
