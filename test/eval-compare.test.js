import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getOctokit } from "@actions/github";
import {
  buildContext,
  createCountingClient,
  createReadOnlyOctokit,
  createRecordingCore,
  findingLines,
  metricsLines,
  readNumbers,
  renderTable,
  runComparison,
  runOnce,
} from "../eval/compare/lib.mjs";
import { AiError } from "../src/ai/error.js";
import { run } from "../src/main.js";
import { createFakeCore } from "./helpers/fake-core.js";
import {
  apiFile,
  apiFiles,
  apiPullRequest,
  OWN_ACCOUNT,
  startGitHubApi,
} from "./helpers/github-api.js";
import { fromRoot } from "./helpers/run-action.js";

// Unit tests of the model comparison (#80). GitHub is the local stand-in, the
// action is the real `run()`, and the model is a fake client: no request
// leaves this machine.

// A right-to-left override, made at run time: source files hold no such character.
const BIDI = String.fromCodePoint(0x202e);

// Recognisable stand-ins that do not look like real credentials.
const TOKEN = "TESTTOKEN-not-a-real-token-123456";
const KEY = "TESTKEY-not-a-real-key-654321";

const TWO_LINES = "@@ -0,0 +1,2 @@\n+let a = 1;\n+let b = 2;";
const APP = apiFile("src/app.js", {
  additions: 2,
  deletions: 0,
  patch: TWO_LINES,
});

const finding = (line, severity = "major", extra = {}) => ({
  path: "src/app.js",
  line,
  severity,
  category: "security",
  title: `Problem at ${line}`,
  comment: "It breaks.",
  suggestion: "Fix it.",
  ...extra,
});

/** A client that answers every request with these findings. */
function fakeClient(findings, { usage, error } = {}) {
  const prompts = [];
  const create = () => ({
    async complete(prompt) {
      prompts.push(prompt);
      if (error) throw error;
      return {
        content: JSON.stringify({ summary: "A summary.", findings }),
        finishReason: "stop",
        usage:
          usage === undefined
            ? { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
            : usage,
        model: "gpt-test",
        requestId: "req_test",
      };
    },
  });
  return { create, prompts };
}

async function setup(t, github, client = fakeClient([])) {
  const api = await startGitHubApi(t, github);
  const real = createFakeCore();
  const deps = {
    run,
    core: real,
    getOctokit: (token) => getOctokit(token, { baseUrl: api.url }),
    createAiClient: client.create,
  };
  return { api, real, deps, client };
}

const INPUTS = {
  "github-token": TOKEN,
  "openai-api-key": KEY,
  "openai-model": "gpt-test",
};

const contextOf = () =>
  buildContext({ owner: "octo-org", repo: "demo", pull: apiPullRequest() });

const once = (setupResult) =>
  runOnce({
    deps: setupResult.deps,
    context: contextOf(),
    label: "case run 1/1",
    inputs: INPUTS,
    token: TOKEN,
  });

// --- No write call to GitHub -------------------------------------------------

test("reads the pull request and writes nothing to GitHub", async (t) => {
  const s = await setup(t, { files: [APP] }, fakeClient([finding(2)]));

  const row = await once(s);

  assert.equal(row.error, null);
  assert.deepEqual(
    [...new Set(s.api.requests.map((request) => request.method))],
    ["GET"],
  );
  assert.deepEqual(s.api.reviews, []);
  assert.equal(row.postedReviews, 1, "the review is recorded, not sent");
});

test("the guard lets reads through and records the one review", async (t) => {
  const api = await startGitHubApi(t, { files: [APP] });
  const { octokit, posted } = createReadOnlyOctokit(
    getOctokit(TOKEN, { baseUrl: api.url }),
  );

  const { data } = await octokit.rest.pulls.get({
    owner: "o",
    repo: "r",
    pull_number: 3,
  });
  const created = await octokit.rest.pulls.createReview({
    owner: "o",
    repo: "r",
    pull_number: 3,
    body: "text",
    event: "COMMENT",
    comments: [{ path: "a.js", line: 1, side: "RIGHT", body: "c" }],
  });

  assert.equal(data.number, 3);
  assert.equal(created.data.id, 1);
  assert.deepEqual(posted, [
    {
      body: "text",
      comments: [{ path: "a.js", line: 1, side: "RIGHT", body: "c" }],
    },
  ]);
  assert.deepEqual(api.reviews, []);
});

test("the guard blocks every other request, also a write that looks harmless", async (t) => {
  const api = await startGitHubApi(t);
  const { octokit } = createReadOnlyOctokit(
    getOctokit(TOKEN, { baseUrl: api.url }),
  );
  const calls = [
    () =>
      octokit.rest.issues.createComment({
        owner: "o",
        repo: "r",
        issue_number: 1,
        body: "x",
      }),
    () =>
      octokit.rest.pulls.update({
        owner: "o",
        repo: "r",
        pull_number: 1,
        title: "x",
      }),
    () => octokit.graphql("query { viewer { login } }"),
  ];

  for (const call of calls) {
    await assert.rejects(call, /blocked a request that is not a read/);
  }
  assert.deepEqual(api.requests, []);
});

test("every run is a first review: the earlier reviews of ReviewOps are not read", async (t) => {
  const marker = "<!-- reviewops -->\nEarlier review";
  const s = await setup(
    t,
    {
      files: [APP],
      existingReviews: [
        {
          id: 5,
          commit_id: "3".repeat(40),
          body: marker,
          user: OWN_ACCOUNT,
        },
      ],
    },
    fakeClient([finding(2)]),
  );

  const row = await once(s);

  assert.equal(row.error, null);
  assert.equal(s.client.prompts.length, 1, "the file is sent in full");
  assert.ok(
    !s.real
      .messages("info")
      .some((line) => /Earlier work of ReviewOps/.test(line)),
  );
  // The lists are empty, so nothing carries the marker and the account of the
  // token is not asked for: the guard would block the query.
  assert.ok(!s.api.requests.some(({ path }) => path === "/graphql"));
});

// --- The way through the action is the one of run() --------------------------

test("filter, masks, limits and selection come from run()", async (t) => {
  const key = `gh${"p"}_${"Ab1".repeat(12)}`;
  const files = [
    APP,
    apiFile(".env", { patch: "@@ -1 +1 @@\n-A=1\n+A=2" }),
    apiFile("src/config.js", {
      additions: 1,
      deletions: 0,
      patch: `@@ -0,0 +1 @@\n+const t = "${key}";`,
    }),
    ...apiFiles(51),
  ];
  const client = fakeClient([finding(2, "critical"), finding(9, "minor")]);
  const s = await setup(t, { files }, client);

  const row = await once(s);

  assert.equal(row.error, null);
  const prompt = client.prompts.map(({ user }) => user).join("\n");
  assert.ok(
    !prompt.includes('path=".env"'),
    "a file on the block list is not sent",
  );
  assert.ok(
    !prompt.includes(key),
    "a string that looks like a secret is masked",
  );
  assert.ok(prompt.includes("[REDACTED SECRET]"));
  // 54 files with a patch, 50 allowed (max-files): the rest is left out.
  assert.equal(row.skippedByLimits, 3);
  // The finding at line 9 is not an added line, so it stays in the text.
  assert.match(row.lines.join("\n"), /> src\/app\.js:2/);
  assert.deepEqual(row.severities, {
    critical: 1,
    major: 0,
    minor: 1,
    info: 0,
  });
});

test("counts the findings over max-comments", async (t) => {
  const patch = `@@ -0,0 +1,12 @@\n${Array.from({ length: 12 }, (_, i) => `+line ${i}`).join("\n")}`;
  const s = await setup(
    t,
    { files: [apiFile("src/app.js", { additions: 12, deletions: 0, patch })] },
    fakeClient(Array.from({ length: 12 }, (_, i) => finding(i + 1))),
  );

  const row = await once(s);

  assert.equal(row.overMaxComments, 2);
  assert.equal(row.severities.major, 10);
});

// --- Figures -----------------------------------------------------------------

test("sums tokens and requests", async (t) => {
  const s = await setup(t, { files: [APP] }, fakeClient([finding(2)]));

  const row = await once(s);

  assert.equal(row.calls, 1);
  assert.deepEqual(row.tokens, {
    input: 100,
    output: 20,
    total: 120,
    withoutUsage: 0,
  });
  assert.equal(row.failedRequests, 0);
});

test("says when a request came without a token count", async (t) => {
  const s = await setup(t, { files: [APP] }, fakeClient([], { usage: null }));

  const row = await once(s);

  assert.equal(row.tokens.withoutUsage, 1);
  assert.equal(row.tokens.total, 0);
});

test("counts a failed request by kind and keeps the message of the action", async (t) => {
  const s = await setup(
    t,
    { files: [APP] },
    fakeClient([], { error: new AiError("server", "The model is busy.", 503) }),
  );

  const row = await once(s);

  assert.deepEqual(row.failed, { server: 1 });
  assert.equal(row.failedRequests, 1);
  assert.match(row.error, /busy/);
  assert.deepEqual(row.lines, []);
});

test("a request that is not an AiError counts as a defect", async () => {
  const counting = createCountingClient(() => ({
    complete: async () => {
      throw new TypeError("broken");
    },
  }));

  await assert.rejects(counting.create({}).complete({}), TypeError);

  assert.deepEqual(counting.stats.failed, { defect: 1 });
});

test("a pull request that cannot be read is a result and costs no request", async (t) => {
  const s = await setup(t, { status: 404 }, fakeClient([]));

  const rows = await runComparison({
    cases: [
      {
        id: "gone",
        pr: "octo-org/demo#7",
        focus: "react",
        defects: [
          {
            path: "a.js",
            description: "d",
            evidence: "https://example.com/e",
          },
        ],
      },
    ],
    runs: 3,
    model: "gpt-test",
    apiKey: KEY,
    token: TOKEN,
    deps: s.deps,
  });

  assert.equal(rows.length, 1);
  assert.match(rows[0].error, /could not be read \(HTTP status 404\)/);
  assert.equal(s.client.prompts.length, 0);
});

test("runs every case as often as asked, one after the other", async (t) => {
  const s = await setup(t, { files: [APP] }, fakeClient([finding(2)]));

  const rows = await runComparison({
    cases: [
      {
        id: "first",
        pr: "octo-org/demo#7",
        focus: "security",
        defects: [
          { path: "a.js", description: "d", evidence: "https://example.com/e" },
        ],
      },
    ],
    runs: 2,
    model: "gpt-test",
    apiKey: KEY,
    token: TOKEN,
    deps: s.deps,
  });

  assert.deepEqual(
    rows.map(({ id, run }) => [id, run]),
    [
      ["first", 1],
      ["first", 2],
    ],
  );
  assert.deepEqual(s.api.reviews, []);
});

// --- Wording of the log of the action ----------------------------------------

test("reads the numbers out of the lines of run()", () => {
  const numbers = readNumbers({
    info: [
      "Checked 4 findings: 1 at an added line, 0 at another line, left out 0 with an empty text, 0 for a file that was not sent, 0 duplicates, 0 outside of the new lines, 0 at lines that were commented before and 3 over the limit of 1 (max-comments).",
      "Review finished: 1 findings (0 critical, 1 major, 0 minor, 0 info) from 1 of 1 requests.",
    ],
    warnings: [
      "Files left out because of the limits: 2. They are not reviewed. The limits are max-files: 1 and max-diff-chars: 5.",
      "Files larger than one request to the model: 1. They are not reviewed.",
      "Requests to the model that failed: 1 of 3. 2 files were not reviewed.",
    ],
  });

  assert.deepEqual(numbers, {
    skippedByLimits: 3,
    overMaxComments: 3,
    failedRequests: 1,
    severities: { critical: 0, major: 1, minor: 0, info: 0 },
  });
});

test("the lines that the numbers come from still stand in src/main.js", () => {
  const source = readFileSync(fromRoot("src/main.js"), "utf8");

  for (const fragment of [
    "Files left out because of the limits: ${overLimit.length}.",
    "Files larger than one request to the model: ${tooLarge.length}.",
    "Requests to the model that failed: ${review.failed.length} of ${batches.length}.",
    "Review finished: ${shown.length} findings (${counts}) from",
    "${dropped.overLimit} over the limit of ${limits.maxComments} (max-comments).",
  ]) {
    assert.ok(source.includes(fragment), `${fragment} changed`);
  }
});

test("reads zeros and no result from a run that did not get that far", () => {
  assert.deepEqual(readNumbers({ info: [], warnings: [] }), {
    skippedByLimits: 0,
    overMaxComments: 0,
    failedRequests: 0,
    severities: null,
  });
});

// --- Secrets and output ------------------------------------------------------

test("neither the key nor the token appears in anything the run wrote", async (t) => {
  const s = await setup(t, { files: [APP] }, fakeClient([finding(2)], {}));

  const row = await once(s);

  // `setSecret` is the call that hands the runner the values to mask.
  const written = s.real.calls.filter((call) => call.method !== "setSecret");
  const everything = JSON.stringify([written, row]);
  assert.ok(!everything.includes(KEY));
  assert.ok(!everything.includes(TOKEN));
  // The runner is told to mask both.
  assert.deepEqual(s.real.messages("setSecret").sort(), [KEY, TOKEN].sort());
});

test("the recording core keeps a failure and the summary instead of passing them on", async () => {
  const real = createFakeCore();
  const { core, record } = createRecordingCore({
    real,
    label: "case run 1/1",
    inputs: INPUTS,
  });

  core.info("hello");
  core.warning("careful");
  core.setFailed("broken");
  await core.summary.addRaw("table", true).write();

  assert.deepEqual(real.messages("info"), ["[case run 1/1] hello"]);
  assert.deepEqual(real.messages("warning"), ["[case run 1/1] careful"]);
  assert.deepEqual(real.messages("setFailed"), []);
  assert.deepEqual(record.failures, ["broken"]);
  assert.deepEqual(record.summaries, ["table"]);
  assert.equal(core.getInput("openai-model"), "gpt-test");
  assert.equal(core.getInput("max-files"), "");
});

test("a finding line starts with a fixed character and shows control characters", () => {
  const lines = findingLines({
    body: "<!-- reviewops -->\nSummary\n\n::error::fake command",
    comments: [
      {
        path: "src/a\nb.js",
        line: 4,
        body:
          "<!-- reviewops -->\n<!-- reviewops-fingerprint: 0123456789abcdef severity: major -->\n\n**Major**\n   indented" +
          BIDI +
          "text",
      },
    ],
  });

  assert.ok(lines.length > 0);
  for (const line of lines) assert.ok(line.startsWith("> "), line);
  assert.ok(lines.some((line) => line === "> ::error::fake command"));
  assert.ok(lines.some((line) => line.includes("\\u202e")));
  assert.ok(lines.some((line) => line.includes("src/a\\u000ab.js:4")));
  assert.ok(!lines.some((line) => /reviewops/.test(line)));
});

test("a long line is split instead of cut", () => {
  const lines = findingLines({
    body: "x".repeat(500),
    comments: [],
  });

  assert.equal(lines.length, 5);
  assert.equal(lines.map((line) => line.slice(2)).join(""), "x".repeat(500));
});

test("the table for the summary holds figures and no text of a finding", async (t) => {
  const s = await setup(
    t,
    { files: [APP] },
    fakeClient([
      finding(2, "major", { title: "MARKERtitle", comment: "MARKERtext" }),
    ]),
  );
  const row = await once(s);
  assert.ok(row.lines.join("\n").includes("MARKERtitle"), "the log shows it");

  const table = renderTable({
    model: "gpt-test",
    rows: [{ id: "case", run: 1, ...row }],
  });

  assert.ok(!table.includes("MARKER"));
  assert.match(table, /\| case \| 1 \| 100 \/ 20 \| 1 \|/);
});

test("says that the review was recorded and not posted", async (t) => {
  const s = await setup(t, { files: [APP] }, fakeClient([finding(2)]));
  const posted = await once(s);
  const nothing = await once(await setup(t, { files: [APP] }, fakeClient([])));

  assert.ok(
    metricsLines({ id: "case", run: 1, ...posted }).some((line) =>
      /recorded and not posted to GitHub/.test(line),
    ),
  );
  assert.ok(
    !metricsLines({ id: "case", run: 1, ...nothing }).some((line) =>
      /recorded and not posted/.test(line),
    ),
  );
});
