import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatch } from "../src/diff/parse.js";
import {
  NO_SECRET_TEXT,
  deliverInsightsReport,
  deliverStatusReport,
} from "../src/insights/deliver.js";
import { createFakeCore } from "./helpers/fake-core.js";
import { INSIGHTS_TEST_SECRET } from "./helpers/insights-api.js";

// Every text that the delivery of the two reports to ReviewOps Insights
// writes, held word for word (#112). The tests were written against the code
// before the two functions were merged and stayed as they were: what the log,
// the warnings and the job summary say must not change with the rebuilding.
//
// `redact` is a stand-in that marks what goes through it, so that the tests
// also hold which texts the redactor sees.

const redact = (text) => `R[${text}]`;

const URL = "https://insights.example.com/api/v1/ingest/review";
const STATUS_URL = "https://insights.example.com/api/v1/ingest/status";
const RUN = { runId: 18234567890, runAttempt: 1 };

const PULL_REQUEST = {
  owner: "octo-org",
  repo: "demo",
  pullNumber: 42,
  headSha: "9f3c1a7b2d4e6f8091a2b3c4d5e6f708192a3b4c",
};

/** Everything the core was asked to write, in order. */
const calls = (core) => core.calls.map(({ method, args }) => [method, ...args]);

// --- The report of a review ----------------------------------------------------

const finding = (path = "src/app.js", line = 3) => ({
  path,
  line,
  severity: "major",
  category: "code-quality",
  title: "A title",
  comment: "A comment",
  suggestion: "A suggestion",
});

const reviewFacts = (selection = {}) => ({
  pullRequest: PULL_REQUEST,
  context: RUN,
  model: "gpt-4.1",
  usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
  mode: "full",
  posted: { reviewId: 7, inlineComments: 1, fallback: false },
  selection: {
    inline: [finding()],
    fingerprints: ["0123456789abcdef"],
    unplaced: [],
    unplacedFingerprints: [],
    ...selection,
  },
  startedAt: performance.now() - 1000,
});

const delivered = (outcome, httpStatus = 200, attempts = 1) => ({
  delivered: true,
  outcome,
  httpStatus,
  attempts,
});
const failed = (fields) => ({ delivered: false, attempts: 1, ...fields });

/** Delivers the report of a review with the answer of `send`. */
async function review({ send, facts = reviewFacts(), secret } = {}) {
  const core = createFakeCore();
  const sent = [];
  const result = await deliverInsightsReport({
    core,
    redact,
    insights: {
      url: URL,
      secret: secret === undefined ? INSIGHTS_TEST_SECRET : secret,
    },
    send:
      typeof send === "function"
        ? async (request) => {
            sent.push(request);
            return send(request);
          }
        : async (request) => {
            sent.push(request);
            return send;
          },
    facts,
  });
  return { core, result, sent };
}

test("review report: names a stored report in the log and the summary", async () => {
  const { core, result, sent } = await review({ send: delivered("stored") });

  assert.deepEqual(calls(core), [
    [
      "info",
      "Report delivered to ReviewOps Insights: stored (HTTP 200), 1 attempt.",
    ],
  ]);
  assert.deepEqual(result, { text: "The report reached ReviewOps Insights." });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, URL);
  assert.equal(sent[0].secret, INSIGHTS_TEST_SECRET);
  assert.equal("kind" in sent[0], false);
});

test("review report: a created report is called stored as well", async () => {
  const { core, result } = await review({ send: delivered("created", 201, 2) });

  assert.deepEqual(calls(core), [
    [
      "info",
      "Report delivered to ReviewOps Insights: stored (HTTP 201), 2 attempts.",
    ],
  ]);
  assert.equal(result.text, "The report reached ReviewOps Insights.");
});

test("review report: says that Insights knew a report already", async () => {
  const { core, result } = await review({ send: delivered("duplicate") });

  assert.deepEqual(calls(core), [
    [
      "info",
      "Report delivered to ReviewOps Insights: it was known already (HTTP 200), 1 attempt.",
    ],
  ]);
  assert.deepEqual(result, {
    text: "The report reached ReviewOps Insights, which knew it already.",
  });
});

test("review report: a report that was not tried is named as not sent", async () => {
  const { core, result } = await review({
    send: failed({ reason: "too-large", attempts: 0 }),
  });

  assert.deepEqual(calls(core), [
    [
      "warning",
      "R[The report for ReviewOps Insights was not sent: report over 1 MiB.]",
    ],
  ]);
  assert.deepEqual(result, {
    text: "R[The report did not reach ReviewOps Insights (report over 1 MiB).]",
  });
});

test("review report: names a failure after one attempt and after several", async () => {
  const one = await review({ send: failed({ reason: "network" }) });
  assert.deepEqual(calls(one.core), [
    [
      "warning",
      "R[The report for ReviewOps Insights was not delivered: network error, after 1 attempt.]",
    ],
  ]);
  assert.equal(
    one.result.text,
    "R[The report did not reach ReviewOps Insights (network error).]",
  );

  const three = await review({
    send: failed({
      reason: "http",
      httpStatus: 503,
      code: "UNAVAILABLE",
      attempts: 3,
    }),
  });
  assert.deepEqual(calls(three.core), [
    [
      "warning",
      "R[The report for ReviewOps Insights was not delivered: HTTP 503, UNAVAILABLE, after 3 attempts.]",
    ],
  ]);
  assert.equal(
    three.result.text,
    "R[The report did not reach ReviewOps Insights (HTTP 503, UNAVAILABLE).]",
  );
});

test("review report: names a redirect and a timeout", async () => {
  const redirect = await review({
    send: failed({ reason: "redirect", httpStatus: 302, attempts: 1 }),
  });
  assert.deepEqual(calls(redirect.core), [
    [
      "warning",
      "R[The report for ReviewOps Insights was not delivered: redirect (HTTP 302), after 1 attempt.]",
    ],
  ]);

  const timeout = await review({
    send: failed({ reason: "timeout", attempts: 3 }),
  });
  assert.deepEqual(calls(timeout.core), [
    [
      "warning",
      "R[The report for ReviewOps Insights was not delivered: timeout, after 3 attempts.]",
    ],
  ]);
});

test("review report: adds the hint for the secret after a 401", async () => {
  const { core, result } = await review({
    send: failed({ reason: "http", httpStatus: 401 }),
  });

  assert.deepEqual(calls(core), [
    [
      "warning",
      "R[The report for ReviewOps Insights was not delivered: HTTP 401, after 1 attempt. Check that `insights-secret` has the same value as `INGEST_SECRET` at ReviewOps Insights.]",
    ],
  ]);
  assert.equal(
    result.text,
    "R[The report did not reach ReviewOps Insights (HTTP 401).]",
  );
});

test("review report: writes the detail of a failure to the debug log, redacted", async () => {
  const { core } = await review({
    send: failed({ reason: "network", detail: "ECONNRESET" }),
  });

  assert.deepEqual(calls(core), [
    ["debug", "R[Insights: network, ECONNRESET]"],
    [
      "warning",
      "R[The report for ReviewOps Insights was not delivered: network error, after 1 attempt.]",
    ],
  ]);
});

test("review report: says nothing about a secret that is missing, but names the reason", async () => {
  const { core, result, sent } = await review({
    send: delivered("stored"),
    secret: null,
  });

  assert.deepEqual(calls(core), [["notice", NO_SECRET_TEXT]]);
  assert.deepEqual(result, { text: NO_SECRET_TEXT });
  assert.deepEqual(sent, []);
  assert.equal(
    NO_SECRET_TEXT,
    "The report for ReviewOps Insights was not sent: the secret in `insights-secret` is not available in this run, because GitHub passes no repository secrets to runs of forks and of Dependabot.",
  );
});

test("review report: a run number that is no number gives a fixed warning and a redacted debug line", async () => {
  const { core, result, sent } = await review({
    send: delivered("stored"),
    facts: { ...reviewFacts(), context: { runId: "x", runAttempt: 1 } },
  });

  assert.deepEqual(calls(core), [
    ["debug", "R[GITHUB_RUN_ID is not a valid run number.]"],
    [
      "warning",
      "The report for ReviewOps Insights could not be built or sent.",
    ],
  ]);
  assert.deepEqual(result, {
    text: "The report for ReviewOps Insights could not be built or sent.",
  });
  assert.deepEqual(sent, []);
});

test("review report: any other error gives the fixed warning and no debug line", async () => {
  const { core, result } = await review({
    send: () => {
      throw new Error("boom with https://insights.example.com and a secret");
    },
  });

  assert.deepEqual(calls(core), [
    [
      "warning",
      "The report for ReviewOps Insights could not be built or sent.",
    ],
  ]);
  assert.equal(
    result.text,
    "The report for ReviewOps Insights could not be built or sent.",
  );
});

test("review report: a message that names a field is allowed into the debug log", async () => {
  const { core } = await review({
    send: delivered("stored"),
    facts: {
      ...reviewFacts(),
      usage: { inputTokens: -1, outputTokens: 1, totalTokens: 0 },
    },
  });

  const lines = calls(core);
  assert.equal(lines.length, 2);
  assert.equal(lines[0][0], "debug");
  assert.match(
    lines[0][1],
    /^R\[The insights report has an invalid [\w.]+\.\]$/,
  );
  assert.deepEqual(lines[1], [
    "warning",
    "The report for ReviewOps Insights could not be built or sent.",
  ]);
});

test("review report: names the findings that were left out, as numbers", async () => {
  const longPath = `${"d/".repeat(600)}file.js`;
  const { core } = await review({
    send: delivered("stored"),
    facts: reviewFacts({
      inline: [finding(), finding(longPath, 5)],
      fingerprints: ["0123456789abcdef", "fedcba9876543210"],
    }),
  });

  assert.deepEqual(calls(core), [
    [
      "info",
      "Findings left out of the report for Insights: 0 over the limit of 500, 1 with a path over 1024 characters.",
    ],
    [
      "info",
      "Report delivered to ReviewOps Insights: stored (HTTP 200), 1 attempt.",
    ],
  ]);
});

test("review report: names the findings over the limit", async () => {
  const many = Array.from({ length: 502 }, (_, index) =>
    finding(`src/file-${index}.js`, 1),
  );
  const { core } = await review({
    send: delivered("stored"),
    facts: reviewFacts({
      inline: many,
      fingerprints: many.map(() => "0123456789abcdef"),
    }),
  });

  assert.equal(
    calls(core)[0][1],
    "Findings left out of the report for Insights: 2 over the limit of 500, 0 with a path over 1024 characters.",
  );
});

// --- The status report ---------------------------------------------------------

/** Two earlier comments, "a" and "b", and the added lines "a" and "b". */
function statusFacts(change = {}) {
  const patch = "@@ -0,0 +1,2 @@\n+a\n+b";
  return {
    pullRequest: PULL_REQUEST,
    context: RUN,
    state: "open",
    comments: [
      { id: 1, path: "src/app.js", fingerprint: "0123456789abcdef" },
      { id: 2, path: "src/app.js", fingerprint: "fedcba9876543210" },
    ],
    diffs: [diffOf("src/app.js", patch)],
    unknownPaths: new Set(),
    listingTruncated: false,
    threads: new Map([
      [1, { resolved: false, thumbsDown: false, known: true }],
      [2, { resolved: true, thumbsDown: false, known: true }],
    ]),
    ...change,
  };
}

async function status({ send, facts = statusFacts() } = {}) {
  const core = createFakeCore();
  const sent = [];
  const result = await deliverStatusReport({
    core,
    redact,
    insights: { statusUrl: STATUS_URL, secret: INSIGHTS_TEST_SECRET },
    send:
      typeof send === "function"
        ? async (request) => {
            sent.push(request);
            return send(request);
          }
        : async (request) => {
            sent.push(request);
            return send;
          },
    facts,
  });
  return { core, result, sent };
}

function diffOf(path, patch) {
  return { path, ...parsePatch(patch) };
}

test("status report: names a delivered report in the log and the summary", async () => {
  const { core, result, sent } = await status({ send: delivered("stored") });

  assert.deepEqual(calls(core), [
    [
      "info",
      "Status report delivered to ReviewOps Insights (HTTP 200), 1 attempt.",
    ],
  ]);
  assert.deepEqual(result, {
    text: "The status report reached ReviewOps Insights.",
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, STATUS_URL);
  assert.equal(sent[0].kind, "status");
  assert.equal(sent[0].secret, INSIGHTS_TEST_SECRET);
});

test("status report: does not tell a duplicate from a stored one", async () => {
  const { core, result } = await status({
    send: delivered("duplicate", 200, 3),
  });

  assert.deepEqual(calls(core), [
    [
      "info",
      "Status report delivered to ReviewOps Insights (HTTP 200), 3 attempts.",
    ],
  ]);
  assert.equal(result.text, "The status report reached ReviewOps Insights.");
});

test("status report: a report that was not tried is named as not sent", async () => {
  const { core, result } = await status({
    send: failed({ reason: "too-large", attempts: 0 }),
  });

  assert.deepEqual(calls(core), [
    [
      "warning",
      "R[The status report for ReviewOps Insights was not sent: report over 1 MiB.]",
    ],
  ]);
  assert.deepEqual(result, {
    text: "R[The status report did not reach ReviewOps Insights (report over 1 MiB).]",
  });
});

test("status report: names a failure after one attempt and after several", async () => {
  const one = await status({ send: failed({ reason: "network" }) });
  assert.deepEqual(calls(one.core), [
    [
      "warning",
      "R[The status report for ReviewOps Insights was not delivered: network error, after 1 attempt.]",
    ],
  ]);
  assert.equal(
    one.result.text,
    "R[The status report did not reach ReviewOps Insights (network error).]",
  );

  const three = await status({
    send: failed({
      reason: "http",
      httpStatus: 503,
      code: "UNAVAILABLE",
      attempts: 3,
    }),
  });
  assert.deepEqual(calls(three.core), [
    [
      "warning",
      "R[The status report for ReviewOps Insights was not delivered: HTTP 503, UNAVAILABLE, after 3 attempts.]",
    ],
  ]);
  assert.equal(
    three.result.text,
    "R[The status report did not reach ReviewOps Insights (HTTP 503, UNAVAILABLE).]",
  );
});

test("status report: names a redirect and a timeout", async () => {
  const redirect = await status({
    send: failed({ reason: "redirect", httpStatus: 302 }),
  });
  assert.deepEqual(calls(redirect.core), [
    [
      "warning",
      "R[The status report for ReviewOps Insights was not delivered: redirect (HTTP 302), after 1 attempt.]",
    ],
  ]);

  const timeout = await status({
    send: failed({ reason: "timeout", attempts: 3 }),
  });
  assert.deepEqual(calls(timeout.core), [
    [
      "warning",
      "R[The status report for ReviewOps Insights was not delivered: timeout, after 3 attempts.]",
    ],
  ]);
});

test("status report: adds the hint for the secret after a 401", async () => {
  const { core, result } = await status({
    send: failed({ reason: "http", httpStatus: 401 }),
  });

  assert.deepEqual(calls(core), [
    [
      "warning",
      "R[The status report for ReviewOps Insights was not delivered: HTTP 401, after 1 attempt. Check that `insights-secret` has the same value as `INGEST_SECRET` at ReviewOps Insights.]",
    ],
  ]);
  assert.equal(
    result.text,
    "R[The status report did not reach ReviewOps Insights (HTTP 401).]",
  );
});

test("status report: writes the detail of a failure to the debug log, redacted", async () => {
  const { core } = await status({
    send: failed({ reason: "network", detail: "ECONNRESET" }),
  });

  assert.deepEqual(calls(core), [
    ["debug", "R[Insights: network, ECONNRESET]"],
    [
      "warning",
      "R[The status report for ReviewOps Insights was not delivered: network error, after 1 attempt.]",
    ],
  ]);
});

test("status report: a run number that is no number gives a fixed warning and a redacted debug line", async () => {
  const { core, result, sent } = await status({
    send: delivered("stored"),
    facts: { ...statusFacts(), context: { runId: 1, runAttempt: 0 } },
  });

  assert.deepEqual(calls(core), [
    ["debug", "R[GITHUB_RUN_ATTEMPT is not a valid run number.]"],
    [
      "warning",
      "The status report for ReviewOps Insights could not be built or sent.",
    ],
  ]);
  assert.deepEqual(result, {
    text: "The status report for ReviewOps Insights could not be built or sent.",
  });
  assert.deepEqual(sent, []);
});

test("status report: any other error gives the fixed warning and no debug line", async () => {
  const { core, result } = await status({
    send: () => {
      throw new Error("boom with https://insights.example.com and a secret");
    },
  });

  assert.deepEqual(calls(core), [
    [
      "warning",
      "The status report for ReviewOps Insights could not be built or sent.",
    ],
  ]);
  assert.equal(
    result.text,
    "The status report for ReviewOps Insights could not be built or sent.",
  );
});

test("status report: says that nothing is sent when no earlier finding has a known state", async () => {
  const { core, result, sent } = await status({
    send: delivered("stored"),
    facts: statusFacts({ comments: [] }),
  });

  assert.deepEqual(calls(core), [
    [
      "info",
      "No status report was sent: none of the earlier findings has a known state.",
    ],
  ]);
  assert.deepEqual(result, {
    text: "No status report was sent: none of the earlier findings has a known state.",
  });
  assert.deepEqual(sent, []);
});

test("status report: names the findings whose state is not known, and sends the others", async () => {
  const { core, sent } = await status({
    send: delivered("stored"),
    facts: statusFacts({
      threads: new Map([
        [1, { resolved: false, thumbsDown: false, known: true }],
        [2, { resolved: false, thumbsDown: false, known: false }],
      ]),
    }),
  });

  assert.deepEqual(calls(core), [
    [
      "info",
      "Findings left out of the status report: 1 whose state is not known, 0 over the limit of 1000.",
    ],
    [
      "info",
      "Status report delivered to ReviewOps Insights (HTTP 200), 1 attempt.",
    ],
  ]);
  assert.equal(sent.length, 1);
});

test("status report: names the findings over the limit", async () => {
  const comments = Array.from({ length: 1002 }, (_, index) => ({
    id: index + 1,
    path: "src/app.js",
    fingerprint: index.toString(16).padStart(16, "0"),
  }));
  const threads = new Map(
    comments.map(({ id }) => [
      id,
      { resolved: false, thumbsDown: false, known: true },
    ]),
  );
  const { core } = await status({
    send: delivered("stored"),
    facts: statusFacts({ comments, threads }),
  });

  assert.equal(
    calls(core)[0][1],
    "Findings left out of the status report: 0 whose state is not known, 2 over the limit of 1000.",
  );
});

test("status report: names the left out findings and then that nothing is sent", async () => {
  const { core, result } = await status({
    send: delivered("stored"),
    facts: statusFacts({
      threads: new Map([
        [1, { resolved: false, thumbsDown: false, known: false }],
        [2, { resolved: false, thumbsDown: false, known: false }],
      ]),
    }),
  });

  assert.deepEqual(calls(core), [
    [
      "info",
      "Findings left out of the status report: 2 whose state is not known, 0 over the limit of 1000.",
    ],
    [
      "info",
      "No status report was sent: none of the earlier findings has a known state.",
    ],
  ]);
  assert.equal(
    result.text,
    "No status report was sent: none of the earlier findings has a known state.",
  );
});

test("status report: the redactor sees no success line and no fixed warning", async () => {
  const ok = await status({ send: delivered("stored") });
  const broken = await status({
    send: () => {
      throw new Error("x");
    },
  });

  for (const core of [ok.core, broken.core]) {
    assert.ok(
      core.calls.every(({ args }) => !String(args[0]).startsWith("R[")),
    );
  }
});
