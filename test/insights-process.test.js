import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { apiFile, startGitHubApi } from "./helpers/github-api.js";
import { loadEvent } from "./helpers/fake-context.js";
import { validateInsightsPayload } from "./helpers/insights-contract.js";
import {
  INSIGHTS_TEST_SECRET,
  insightsError,
  startInsightsApi,
} from "./helpers/insights-api.js";
import { reviewCompletion, startOpenAiApi } from "./helpers/openai-api.js";
import {
  PULL_REQUEST_EVENT,
  fromRoot,
  startAction,
  withInputs,
  withoutMaskCommands,
} from "./helpers/run-action.js";

// Process tests for the report to ReviewOps Insights (#76). The action runs as
// its own process, the way the runner starts it. GitHub, OpenAI and Insights
// are local stand-ins, and every test counts the requests to all three.

const FILES = [
  apiFile("src/app.js", {
    additions: 2,
    deletions: 0,
    patch: "@@ -0,0 +1,2 @@\n+let a = 1;\n+let b = 2;",
  }),
];

const finding = (severity) => ({
  path: "src/app.js",
  line: 2,
  severity,
  category: "security",
  title: "A problem",
  comment: "It breaks.",
  suggestion: "Fix it.",
});

// The event files of the tests, removed when all of them are done.
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

async function startApis(t, { findings = [finding("major")], insights } = {}) {
  const github = await startGitHubApi(t, { files: FILES });
  return {
    github,
    openai: await startOpenAiApi(t, reviewCompletion(findings)),
    insights: await startInsightsApi(t, insights),
  };
}

/** The action, with the report switched on unless `inputs` says otherwise. */
const run = (apis, { event = PULL_REQUEST_EVENT, env = {}, on = true } = {}) =>
  startAction(
    fromRoot("src/index.js"),
    withInputs({
      ...event,
      GITHUB_API_URL: apis.github.url,
      TEST_OPENAI_URL: apis.openai.url,
      // The runner sets these for every run of a workflow.
      GITHUB_RUN_ID: "18234567890",
      GITHUB_RUN_ATTEMPT: "1",
      // The runner passes the default of action.yml when a workflow sets none.
      "INPUT_SKIP-LABEL": "no-ai-review",
      ...(on && {
        "INPUT_INSIGHTS-URL": apis.insights.url,
        "INPUT_INSIGHTS-SECRET": INSIGHTS_TEST_SECRET,
      }),
      ...env,
    }),
  );

const shown = (summary) => summary.replace(/\\([!-/:-@[-`{-~])/g, "$1");

// --- Off ---------------------------------------------------------------------

test("without an address nothing goes to Insights and nothing mentions it", async (t) => {
  const apis = await startApis(t);

  const result = await run(apis, { on: false });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.github.reviews.length, 1);
  assert.equal(apis.insights.requests.length, 0);
  assert.doesNotMatch(result.output, /insights/i);
  assert.doesNotMatch(result.summary, /insights/i);
});

// --- A report per run --------------------------------------------------------

test("sends one report after a review, signed over its bytes", async (t) => {
  const apis = await startApis(t);

  const result = await run(apis);

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.insights.requests.length, 1);
  const [request] = apis.insights.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/v1/ingest/review");
  assert.equal(request.signatureValid, true, "the signature does not match");
  assert.deepEqual(validateInsightsPayload(request.body), []);
  assert.equal(request.body.repository, "octo-org/demo");
  assert.equal(request.body.prNumber, 42);
  assert.equal(request.body.runId, 18234567890);
  assert.equal(request.body.runAttempt, 1);
  assert.equal(request.body.githubReviewId, 1000);
  assert.equal(request.body.findings.length, 1);
  assert.equal(request.body.findings[0].placement, "inline");
  assert.match(
    result.stdout,
    /^Report delivered to ReviewOps Insights: stored \(HTTP 201\), 1 attempt\.$/m,
  );
  assert.match(
    shown(result.summary),
    /^The report reached ReviewOps Insights\.$/m,
  );
});

test("names the host of the address once, and never the address", async (t) => {
  const apis = await startApis(t);

  const result = await run(apis);

  const host = new URL(apis.insights.url).host;
  assert.match(
    result.stdout,
    new RegExp(
      `^The report of this run goes to ReviewOps Insights at ${host.replace(".", "\\.")}\\.$`,
      "m",
    ),
  );
  assert.equal(result.output.includes(apis.insights.url), false);
  assert.equal(result.output.includes("/api/v1/ingest"), false);
  assert.equal(result.summary.includes("127.0.0.1"), false);
});

test("a run without findings sends a report with an empty list", async (t) => {
  const apis = await startApis(t, { findings: [] });

  const result = await run(apis);

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.github.reviews.length, 0);
  assert.equal(apis.insights.requests.length, 1);
  const [{ body }] = apis.insights.requests;
  assert.deepEqual(body.findings, []);
  assert.equal(body.githubReviewId, null);
  assert.deepEqual(validateInsightsPayload(body), []);
});

test("a run that asked no model sends no report", async (t) => {
  const apis = await startApis(t);
  const event = eventWith((payload) => {
    payload.pull_request.draft = true;
  });

  const result = await run(apis, { event });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.openai.requests.length, 0);
  assert.equal(apis.insights.requests.length, 0);
  assert.doesNotMatch(result.summary, /Insights/);
});

test("a run that ends with an error sends no report", async (t) => {
  const github = await startGitHubApi(t, {
    files: FILES,
    reviews: () => ({ status: 403, body: { message: "Forbidden" } }),
  });
  const apis = {
    github,
    openai: await startOpenAiApi(t, reviewCompletion([finding("major")])),
    insights: await startInsightsApi(t),
  };

  const result = await run(apis);

  assert.equal(result.status, 1, result.output);
  assert.equal(apis.insights.requests.length, 0);
});

// --- Retries -----------------------------------------------------------------

test("delivers after two 503 answers: three requests with the same deliveryId", async (t) => {
  const apis = await startApis(t, {
    insights: {
      answer: [
        insightsError(503, "UNAVAILABLE"),
        insightsError(503, "UNAVAILABLE"),
        { status: 201, body: { id: "x" } },
      ],
    },
  });

  const result = await run(apis);

  assert.equal(result.status, 0, result.output);
  const { requests } = apis.insights;
  assert.equal(requests.length, 3);
  const ids = new Set(requests.map(({ body }) => body.deliveryId));
  assert.equal(ids.size, 1);
  assert.equal(
    new Set(requests.map(({ raw }) => raw.toString("utf8"))).size,
    1,
  );
  assert.ok(requests.every(({ signatureValid }) => signatureValid));
  assert.match(
    result.stdout,
    /Report delivered to ReviewOps Insights: stored \(HTTP 201\), 3 attempts\./,
  );
  assert.doesNotMatch(result.stdout, /::warning::/);
});

// --- A report that does not arrive: the run ends as it would have -----------

test("a rejected signature ends the run as without Insights, with a warning that names the status", async (t) => {
  const without = await run(await startApis(t), { on: false });
  const apis = await startApis(t, {
    insights: { answer: insightsError(401, "UNAUTHORIZED") },
  });

  const result = await run(apis);

  assert.equal(result.status, without.status, result.output);
  assert.deepEqual(result.outputs, without.outputs);
  assert.equal(apis.insights.requests.length, 1);
  assert.match(
    result.stdout,
    /^::warning::The report for ReviewOps Insights was not delivered: HTTP 401, UNAUTHORIZED, after 1 attempt\. Check that `insights-secret` has the same value as `INGEST_SECRET` at ReviewOps Insights\.$/m,
  );
  assert.match(
    shown(result.summary),
    /did not reach ReviewOps Insights \(HTTP 401, UNAUTHORIZED\)/,
  );
});

test("a redirect is not followed, not repeated and ends in a warning with its status", async (t) => {
  const elsewhere = await startInsightsApi(t);
  const apis = await startApis(t, {
    insights: {
      answer: { status: 301, headers: { location: elsewhere.url }, body: {} },
    },
  });

  const result = await run(apis);

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.insights.requests.length, 1);
  assert.equal(elsewhere.requests.length, 0, "the redirect was followed");
  assert.match(
    result.stdout,
    /^::warning::The report for ReviewOps Insights was not delivered: redirect \(HTTP 301\), after 1 attempt\.$/m,
  );
});

test("an address where nobody listens ends in a warning, not in an error", async (t) => {
  const apis = await startApis(t);
  const dead = "http://127.0.0.1:9/ingest";

  const result = await run(apis, {
    env: { "INPUT_INSIGHTS-URL": dead },
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.github.reviews.length, 1);
  assert.match(
    result.stdout,
    /^::warning::The report for ReviewOps Insights was not delivered: network error, after 3 attempts\.$/m,
  );
  assert.equal(result.output.includes(dead), false);
});

// --- fail-on -----------------------------------------------------------------

for (const [name, answer] of [
  ["delivered", undefined],
  ["not delivered", insightsError(401, "UNAUTHORIZED")],
]) {
  test(`fail-on critical ends the step the same way when the report is ${name}`, async (t) => {
    const options = { findings: [finding("critical")] };
    const env = { "INPUT_FAIL-ON": "critical" };
    const without = await run(await startApis(t, options), { on: false, env });
    const apis = await startApis(t, { ...options, insights: { answer } });

    const result = await run(apis, { env });

    assert.equal(without.status, 1, without.output);
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(result.outputs, without.outputs);
    assert.match(result.stdout, /^::error::ReviewOps found 1 open findings/m);
    assert.equal(apis.insights.requests.length, 1);
  });
}

// --- Before the first request ------------------------------------------------

for (const [name, address, secret, message] of [
  [
    "http",
    "http://insights.example.com/x",
    INSIGHTS_TEST_SECRET,
    /^::error::Input `insights-url` must start with `https:\/\//m,
  ],
  [
    "credentials",
    "https://admin:hunter22@insights.example.com/x",
    INSIGHTS_TEST_SECRET,
    /^::error::Input `insights-url` must not contain a user name or a password/m,
  ],
  [
    "a query",
    "https://insights.example.com/x?a=1",
    INSIGHTS_TEST_SECRET,
    /^::error::Input `insights-url` must not contain a query/m,
  ],
  [
    "no valid form",
    "not an address",
    INSIGHTS_TEST_SECRET,
    /^::error::Input `insights-url` contains a space/m,
  ],
  [
    "a secret that is too short",
    "https://insights.example.com/x",
    "hunter22-short",
    /^::error::Input `insights-secret` is too short/m,
  ],
  [
    "no secret",
    "https://insights.example.com/x",
    "",
    /^::error::Input `insights-secret` is missing\./m,
  ],
]) {
  test(`fails before any request with ${name}`, async (t) => {
    const apis = await startApis(t);

    const result = await run(apis, {
      on: false,
      env: { "INPUT_INSIGHTS-URL": address, "INPUT_INSIGHTS-SECRET": secret },
    });

    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, message);
    assert.equal(apis.github.requests.length, 0, "GitHub was asked");
    assert.equal(apis.openai.requests.length, 0, "the model was asked");
    assert.equal(apis.insights.requests.length, 0);
    assert.equal(
      withoutMaskCommands(result.output).includes("hunter22"),
      false,
    );
  });
}

// --- Forks and Dependabot ----------------------------------------------------

test("a pull request from a fork ends green with the old notice and sends nothing", async (t) => {
  const apis = await startApis(t);
  const event = eventWith((payload) => {
    payload.pull_request.head.repo.full_name = "someone/demo";
  });

  const result = await run(apis, {
    event,
    on: false,
    env: {
      // GitHub gives a fork neither secret.
      "INPUT_OPENAI-API-KEY": "",
      "INPUT_INSIGHTS-URL": apis.insights.url,
      "INPUT_INSIGHTS-SECRET": "",
    },
  });

  assert.equal(result.status, 0, result.output);
  assert.match(
    result.stdout,
    /^::notice::ReviewOps did not review this pull request: it comes from a fork/m,
  );
  assert.equal(apis.github.requests.length, 0);
  assert.equal(apis.insights.requests.length, 0);
  assert.doesNotMatch(result.output, /Insights/);
});

test("a run of Dependabot without the secret reviews, sends nothing and says why", async (t) => {
  const apis = await startApis(t);

  const result = await run(apis, {
    env: { GITHUB_ACTOR: "dependabot[bot]", "INPUT_INSIGHTS-SECRET": "" },
  });

  assert.equal(result.status, 0, result.output);
  assert.equal(apis.github.reviews.length, 1, "the review did not take place");
  assert.equal(apis.insights.requests.length, 0);
  assert.match(
    result.stdout,
    /^::notice::The report for ReviewOps Insights was not sent: the secret in `insights-secret` is not available/m,
  );
});

// --- Secrets stay out --------------------------------------------------------

test("the secret and the signature appear in no log, no summary and no output, whatever the answer", async (t) => {
  for (const answer of [
    undefined,
    insightsError(401, "UNAUTHORIZED"),
    insightsError(500, "BOOM"),
  ]) {
    const apis = await startApis(t, { insights: { answer } });

    const result = await run(apis);

    // The mask commands are consumed by the runner: they are no log.
    const seen = `${withoutMaskCommands(result.output)}\n${result.summary}\n${JSON.stringify(result.outputs)}`;
    assert.equal(seen.includes(INSIGHTS_TEST_SECRET), false, "the secret");
    for (const request of apis.insights.requests) {
      const signature = request.headers["x-reviewops-signature"];
      assert.match(signature, /^sha256=[0-9a-f]{64}$/);
      assert.equal(seen.includes(signature), false, "the signature");
      assert.equal(
        seen.includes(signature.slice("sha256=".length)),
        false,
        "the hex of the signature",
      );
    }
  }
});

test("the runner is asked to mask the secret", async (t) => {
  const apis = await startApis(t);

  const result = await run(apis);

  assert.match(
    result.stdout,
    new RegExp(`^::add-mask::${INSIGHTS_TEST_SECRET}$`, "m"),
  );
});
