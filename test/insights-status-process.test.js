import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { lineFingerprint } from "../src/fingerprint.js";
import { fingerprintLine } from "../src/github/review.js";
import { loadEvent } from "./helpers/fake-context.js";
import {
  apiFile,
  apiThread,
  OWN_ACCOUNT,
  startGitHubApi,
} from "./helpers/github-api.js";
import {
  INSIGHTS_TEST_SECRET,
  insightsError,
  startInsightsApi,
} from "./helpers/insights-api.js";
import { validateStatusPayload } from "./helpers/insights-contract.js";
import { reviewCompletion, startOpenAiApi } from "./helpers/openai-api.js";
import {
  PULL_REQUEST_EVENT,
  fromRoot,
  startAction,
  withInputs,
} from "./helpers/run-action.js";

// Process tests for the status report (#77). The action runs as its own
// process; GitHub, OpenAI and Insights are local stand-ins, and every test
// counts the requests to all three.

const HEAD = "1".repeat(40);
const MARKER = "<!-- reviewops -->";

// The pull request adds three lines: "a", "b" and "c".
const FILE = apiFile("src/app.js", {
  additions: 3,
  deletions: 0,
  patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c",
});
const fingerprintOf = (content, previous = "") =>
  lineFingerprint("src/app.js", content, previous);

const ownReview = (commit_id) => ({
  id: 5,
  body: `${MARKER}\n\n### ReviewOps`,
  user: OWN_ACCOUNT,
  state: "COMMENTED",
  commit_id,
});
const ownComment = (id, content, previous = "", severity = "major") => ({
  id,
  body: `${MARKER}\n${fingerprintLine(fingerprintOf(content, previous), severity)}\n\ntext`,
  user: OWN_ACCOUNT,
  path: "src/app.js",
});

const folders = [];
after(() => {
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

function eventWith(change) {
  const payload = loadEvent();
  change(payload);
  const folder = mkdtempSync(join(tmpdir(), "reviewops-event-"));
  folders.push(folder);
  const file = join(folder, "event.json");
  writeFileSync(file, JSON.stringify(payload));
  return { ...PULL_REQUEST_EVENT, GITHUB_EVENT_PATH: file };
}

const closedEvent = (merged) =>
  eventWith((payload) => {
    payload.pull_request.state = "closed";
    payload.pull_request.merged = merged;
  });

async function startApis(t, { github = {}, answer, insights } = {}) {
  return {
    github: await startGitHubApi(t, { files: [FILE], ...github }),
    openai: await startOpenAiApi(t, answer ?? reviewCompletion()),
    insights: await startInsightsApi(t, insights),
  };
}

const run = (apis, { event = PULL_REQUEST_EVENT, env = {}, on = true } = {}) =>
  startAction(
    fromRoot("src/index.js"),
    withInputs({
      ...event,
      GITHUB_API_URL: apis.github.url,
      TEST_OPENAI_URL: apis.openai.url,
      GITHUB_RUN_ID: "18234567890",
      GITHUB_RUN_ATTEMPT: "1",
      "INPUT_SKIP-LABEL": "no-ai-review",
      ...(on && {
        "INPUT_INSIGHTS-URL": apis.insights.url,
        "INPUT_INSIGHTS-SECRET": INSIGHTS_TEST_SECRET,
      }),
      ...env,
    }),
  );

/** The summary as a reader sees it: without escaping backslashes. */
const shown = (summary) => summary.replace(/\\([!-/:-@[-`{-~])/g, "$1");

// The queries for the review threads. The one for the account of the token
// (`viewer`) is asked for apart from them.
const graphqlRequests = (apis) =>
  apis.github.requests.filter(
    (request) =>
      request.path === "/graphql" && !/\bviewer\b/.test(request.body?.query),
  );
const statusRequests = (apis) =>
  apis.insights.requests.filter((request) => request.path.endsWith("/status"));

/** An earlier review of the head with three comments; "b" has a thumbs down. */
const EARLIER = {
  existingReviews: [ownReview(HEAD)],
  existingComments: [
    ownComment(10, "a"),
    ownComment(11, "b", "a"),
    ownComment(12, "c", "b"),
  ],
  threads: [
    apiThread(10, false),
    apiThread(11, true, { thumbsDown: true }),
    apiThread(12, false),
  ],
};

// --- The report ---------------------------------------------------------------

test("sends the state of the earlier findings, signed, and nothing else", async (t) => {
  const apis = await startApis(t, {
    github: {
      ...EARLIER,
      // The line "c" was changed since the comment.
      files: [
        apiFile("src/app.js", {
          additions: 3,
          deletions: 0,
          patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+C",
        }),
      ],
    },
  });

  const result = await run(apis);

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.openai.requests.length, 0);
  assert.equal(statusRequests(apis).length, 1);
  const request = statusRequests(apis)[0];
  assert.equal(request.signatureValid, true);
  assert.deepEqual(validateStatusPayload(request.body), []);
  assert.deepEqual(request.body, {
    schemaVersion: 1,
    repository: "octo-org/demo",
    prNumber: 42,
    runId: 18234567890,
    runAttempt: 1,
    pullRequestState: "open",
    findings: [
      {
        fingerprint: fingerprintOf("a"),
        lineUnchanged: true,
        threadResolved: false,
        thumbsDown: false,
      },
      {
        fingerprint: fingerprintOf("b", "a"),
        lineUnchanged: true,
        threadResolved: true,
        thumbsDown: true,
      },
      {
        fingerprint: fingerprintOf("c", "b"),
        lineUnchanged: false,
        threadResolved: false,
        thumbsDown: false,
      },
    ],
  });
  assert.match(result.stdout, /Status report delivered to ReviewOps Insights/);
  assert.match(result.summary, /The status report reached ReviewOps Insights/);
});

test("reports also for a comment of the run without a severity in its fingerprint line", async (t) => {
  const old = {
    id: 10,
    body: `${MARKER}\n${fingerprintLine(fingerprintOf("a"))}\n\ntext`,
    user: OWN_ACCOUNT,
    path: "src/app.js",
  };
  const apis = await startApis(t, {
    github: {
      ...EARLIER,
      existingComments: [old],
      threads: [apiThread(10)],
    },
  });

  const result = await run(apis);

  assert.equal(result.status, 0, result.output);
  assert.equal(statusRequests(apis)[0].body.findings.length, 1);
});

test("sends the status report after the review report and the outputs", async (t) => {
  const apis = await startApis(t, {
    github: {
      files: [FILE],
      existingComments: [ownComment(10, "a")],
      threads: [apiThread(10)],
    },
    answer: reviewCompletion([
      {
        path: "src/app.js",
        line: 3,
        severity: "major",
        category: "code-quality",
        title: "A problem",
        comment: "It breaks.",
        suggestion: "Fix it.",
      },
    ]),
  });

  const result = await run(apis);

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.github.reviews.length, 1);
  assert.deepEqual(
    apis.insights.requests.map((request) => request.path),
    ["/api/v1/ingest/review", "/api/v1/ingest/status"],
  );
  assert.equal(result.outputs["findings-count"], "2");
});

test("asks the model for nothing and posts nothing when only the status is reported", async (t) => {
  const apis = await startApis(t, { github: EARLIER });

  await run(apis);

  assert.equal(apis.openai.requests.length, 0);
  assert.deepEqual(apis.github.reviews, []);
});

// --- Off ---------------------------------------------------------------------------

test("without an address, the requests to GitHub are those of before: no query for the threads", async (t) => {
  const apis = await startApis(t, {
    github: {
      ...EARLIER,
      // No comment names a severity: no earlier finding to count.
      existingComments: [
        ownComment(10, "a", "", ""),
        ownComment(11, "b", "a", ""),
      ].map((comment) => ({
        ...comment,
        body: comment.body.replace(/ severity: [a-z]*/, ""),
      })),
    },
  });

  const result = await run(apis, { on: false });

  assert.equal(result.status, 0, result.output);
  assert.equal(graphqlRequests(apis).length, 0);
  assert.equal(apis.insights.requests.length, 0);
  assert.doesNotMatch(result.output, /insights/i);
  assert.doesNotMatch(result.summary, /insights/i);
});

test("with an address, one query answers both the count and the status", async (t) => {
  const apis = await startApis(t, { github: EARLIER });

  const result = await run(apis);

  assert.equal(result.status, 0, result.output);
  assert.equal(graphqlRequests(apis).length, 1);
});

// --- It never fails the run -----------------------------------------------------------

for (const [name, answer] of [
  ["a wrong secret", insightsError(401, "UNAUTHORIZED")],
  [
    "a redirect",
    { status: 302, headers: { location: "https://elsewhere.example/x" } },
  ],
  ["a refusal of the report", insightsError(400, "VALIDATION_ERROR")],
]) {
  test(`${name} fails no run and changes no output`, async (t) => {
    const reference = await startApis(t, { github: EARLIER });
    const failing = await startApis(t, {
      github: EARLIER,
      insights: { answer },
    });
    const env = { "INPUT_FAIL-ON": "major" };

    const without = await run(reference, { on: false, env });
    const withReport = await run(failing, { env });

    assert.equal(withReport.status, without.status, withReport.output);
    assert.deepEqual(withReport.outputs, without.outputs);
    assert.match(
      withReport.stdout,
      /::warning::The status report for ReviewOps Insights/,
    );
    assert.equal(withReport.stderr, "");
    // The `fail-on` of the open finding "a" (major) decides, as without report.
    assert.equal(withReport.status, 1);
  });
}

test("a failed query for the threads, made for the report alone, is a warning and no report, also with fail-on", async (t) => {
  const apis = await startApis(t, {
    github: {
      ...EARLIER,
      // No earlier finding with a severity: the count needs no threads.
      existingComments: [
        {
          ...ownComment(10, "a"),
          body: ownComment(10, "a").body.replace(/ severity: [a-z]*/, ""),
        },
      ],
      threads: () => ({ status: 500, body: { message: "Server Error" } }),
    },
  });

  const result = await run(apis, { env: { "INPUT_FAIL-ON": "major" } });

  assert.equal(result.status, 0, result.output);
  assert.equal(statusRequests(apis).length, 0);
  assert.match(
    result.stdout,
    /::warning::.*The status report for ReviewOps Insights is not sent\./,
  );
});

test("a failed query that the count needs keeps the behavior of before and sends no report", async (t) => {
  const apis = await startApis(t, {
    github: {
      ...EARLIER,
      threads: () => ({ status: 500, body: { message: "Server Error" } }),
    },
  });

  const result = await run(apis);

  assert.equal(result.status, 0, result.output);
  assert.equal(statusRequests(apis).length, 0);
  assert.match(
    result.stdout,
    /Every earlier finding of ReviewOps counts as open\. The status report for ReviewOps Insights is not sent\./,
  );
});

test("names a path that does not end on /review and sends the review report as before", async (t) => {
  const apis = await startApis(t, { github: { files: [FILE] } });
  const url = apis.insights.url.replace("/ingest/review", "/ingest/reports");

  const result = await run(apis, { env: { "INPUT_INSIGHTS-URL": url } });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.insights.requests.length, 1);
  assert.match(
    result.stdout,
    /::notice::The status report for ReviewOps Insights is not sent: the path of `insights-url` does not end on `\/review`/,
  );
});

const forkEvent = () =>
  eventWith((payload) => {
    payload.pull_request.head.repo.full_name = "someone/demo";
  });

test("a fork that has no secret for Insights says so once and sends no report", async (t) => {
  const apis = await startApis(t, { github: EARLIER });

  const result = await run(apis, {
    event: forkEvent(),
    env: { "INPUT-INSIGHTS-SECRET": "", "INPUT_INSIGHTS-SECRET": "" },
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.insights.requests.length, 0);

  assert.equal(
    result.stdout.match(/the secret in `insights-secret` is not available/g)
      .length,
    1,
  );
  assert.match(
    shown(result.summary),
    /secret in `insights-secret` is not available/,
  );
});

test("a missing secret outside of forks stays an error, as for the review report", async (t) => {
  const apis = await startApis(t, { github: EARLIER });

  const result = await run(apis, { env: { "INPUT_INSIGHTS-SECRET": "" } });

  assert.equal(result.status, 1, result.output);
  assert.equal(apis.github.requests.length, 0);
});

// --- Nothing from the people on GitHub reaches Insights, log or summary ----------------

test("no name and no number of reactions leaves the action", async (t) => {
  const apis = await startApis(t, {
    github: {
      ...EARLIER,
      threads: [
        apiThread(10, false, {
          reactionGroups: [
            {
              content: "THUMBS_DOWN",
              reactors: {
                totalCount: 4177,
                nodes: [{ login: "reactor-login-xyz" }],
              },
            },
          ],
        }),
        apiThread(11),
        apiThread(12),
      ],
    },
  });

  const result = await run(apis);

  assert.equal(result.status, 0, result.output);
  const seen = [
    statusRequests(apis)[0].raw.toString("utf8"),
    result.output,
    result.summary,
  ].join("\n");
  assert.doesNotMatch(seen, /4177|reactor-login-xyz/);
  assert.equal(statusRequests(apis)[0].body.findings[0].thumbsDown, true);
});

test("puts no fingerprint into the log or the summary", async (t) => {
  const apis = await startApis(t, { github: EARLIER });

  const result = await run(apis);

  for (const content of [
    fingerprintOf("a"),
    fingerprintOf("b", "a"),
    fingerprintOf("c", "b"),
  ]) {
    assert.ok(!result.output.includes(content));
    assert.ok(!result.summary.includes(content));
  }
});

// --- A closed pull request ----------------------------------------------------------------

test("a closed pull request without an address does nothing: no request at all", async (t) => {
  const apis = await startApis(t, { github: EARLIER });

  const result = await run(apis, {
    event: closedEvent(true),
    on: false,
    env: { "INPUT_OPENAI-API-KEY": "", "INPUT_FAIL-ON": "major" },
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.github.requests.length, 0);
  assert.equal(apis.openai.requests.length, 0);
  assert.equal(apis.insights.requests.length, 0);
  assert.match(
    result.stdout,
    /::notice::ReviewOps left out the review: the pull request is merged\./,
  );
  assert.deepEqual(result.outputs, {
    "findings-count": "0",
    "critical-count": "0",
    "review-url": "",
  });
});

test("a closed pull request of a fork, without the secret, does nothing: no request at all", async (t) => {
  const apis = await startApis(t, { github: EARLIER });
  const event = eventWith((payload) => {
    payload.pull_request.state = "closed";
    payload.pull_request.merged = true;
    payload.pull_request.head.repo.full_name = "someone/demo";
  });

  const result = await run(apis, {
    event,
    env: { "INPUT_INSIGHTS-SECRET": "", "INPUT_OPENAI-API-KEY": "" },
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.github.requests.length, 0);
  assert.equal(apis.insights.requests.length, 0);
  assert.match(result.stdout, /::notice::ReviewOps left out the review/);
});

for (const [merged, state] of [
  [true, "merged"],
  [false, "closed"],
]) {
  test(`a ${state} pull request sends the final state once, with no review and no model`, async (t) => {
    const apis = await startApis(t, { github: EARLIER });

    const result = await run(apis, {
      event: closedEvent(merged),
      env: { "INPUT_OPENAI-API-KEY": "", "INPUT_FAIL-ON": "major" },
    });

    assert.equal(result.status, 0, result.output);
    assert.equal(statusRequests(apis).length, 1);
    assert.equal(apis.insights.requests.length, 1);
    assert.match(result.stdout, /Reporting the state of octo-org\/demo#42/);
    assert.doesNotMatch(result.stdout, /Reviewing octo-org/);
    assert.equal(statusRequests(apis)[0].body.pullRequestState, state);
    assert.deepEqual(validateStatusPayload(statusRequests(apis)[0].body), []);
    assert.equal(apis.openai.requests.length, 0);
    assert.deepEqual(apis.github.reviews, []);
    // Nothing but reading: no write, no comparison of commits.
    assert.deepEqual(
      [...new Set(apis.github.requests.map((request) => request.method))],
      ["GET", "POST"],
    );
    assert.ok(apis.github.requests.every((r) => !r.path.includes("/compare/")));
    assert.deepEqual(result.outputs, {
      "findings-count": "0",
      "critical-count": "0",
      "review-url": "",
    });
  });
}

test("an unlabeled event on a closed pull request no longer starts a review", async (t) => {
  const apis = await startApis(t, { github: EARLIER });
  const event = eventWith((payload) => {
    payload.action = "unlabeled";
    payload.pull_request.state = "closed";
    payload.pull_request.merged = false;
    payload.label = { name: "other" };
  });

  const result = await run(apis, { event, on: false });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.openai.requests.length, 0);
  assert.equal(apis.github.requests.length, 0);
});

test("a closed pull request without earlier comments sends nothing and asks for no threads", async (t) => {
  const apis = await startApis(t, { github: { files: [FILE] } });

  const result = await run(apis, {
    event: closedEvent(true),
    env: { "INPUT_OPENAI-API-KEY": "" },
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.insights.requests.length, 0);
  assert.equal(graphqlRequests(apis).length, 0);
});

test("a closed pull request whose files cannot be read is a warning, and the run stays green", async (t) => {
  const apis = await startApis(t, {
    github: { status: 500, message: "Server Error" },
  });

  const result = await run(apis, {
    event: closedEvent(true),
    env: { "INPUT_OPENAI-API-KEY": "", "INPUT_FAIL-ON": "major" },
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.insights.requests.length, 0);
  assert.match(
    result.stdout,
    /::warning::.*The status report for ReviewOps Insights is not sent\./,
  );
});

test("a closed pull request leaves out a finding in a file whose diff is not available", async (t) => {
  const apis = await startApis(t, {
    github: {
      ...EARLIER,
      files: [
        FILE,
        // No patch: binary or too large for GitHub to show.
        apiFile("src/big.js", { patch: undefined }),
      ],
      existingComments: [
        ownComment(10, "a"),
        { ...ownComment(11, "x"), path: "src/big.js" },
      ],
      threads: [apiThread(10), apiThread(11)],
    },
  });

  const result = await run(apis, {
    event: closedEvent(true),
    env: { "INPUT_OPENAI-API-KEY": "" },
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(statusRequests(apis)[0].body.findings.length, 1);
  assert.match(result.stdout, /1 whose state is not known/);
});

// --- The account of the token (#106) -----------------------------------------

test("a comment of another bot with the marker and a fingerprint is not in the status report", async (t) => {
  const otherBot = { type: "Bot", login: "some-other-app[bot]", id: 49699333 };
  const apis = await startApis(t, {
    github: {
      ...EARLIER,
      existingComments: [
        ownComment(10, "a"),
        { ...ownComment(11, "b", "a"), user: otherBot },
      ],
      threads: [apiThread(10, false), apiThread(11, false)],
    },
  });

  const result = await run(apis);

  assert.equal(result.status, 0, result.output);
  assert.deepEqual(
    statusRequests(apis)[0].body.findings.map(({ fingerprint }) => fingerprint),
    [fingerprintOf("a")],
  );
});

test("a closed pull request whose account cannot be read is a warning without a status report", async (t) => {
  const apis = await startApis(t, {
    github: {
      ...EARLIER,
      viewer: () => ({ status: 403, body: { message: "Forbidden" } }),
    },
  });

  const result = await run(apis, {
    event: closedEvent(true),
    env: { "INPUT_OPENAI-API-KEY": "", "INPUT_FAIL-ON": "major" },
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.insights.requests.length, 0);
  assert.equal(apis.openai.requests.length, 0);
  assert.match(
    result.stdout,
    /::warning::GitHub API request failed \(HTTP 403\)\..*The status report for ReviewOps Insights is not sent\./,
  );
});

test("a run with a review whose account cannot be read fails and sends nothing", async (t) => {
  const apis = await startApis(t, {
    github: {
      ...EARLIER,
      viewer: () => ({ status: 403, body: { message: "Forbidden" } }),
    },
  });

  const result = await run(apis);

  assert.equal(result.status, 1);
  assert.equal(apis.insights.requests.length, 0);
  assert.equal(apis.openai.requests.length, 0);
});
