import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePatch } from "../src/diff/parse.js";
import { lineFingerprint, textFingerprint } from "../src/fingerprint.js";
import { readPullRequestState } from "../src/github/context.js";
import { readHistory } from "../src/github/history.js";
import { fingerprintLine } from "../src/github/review.js";
import {
  readResolvedComments,
  readThreadStates,
  resolvedOf,
} from "../src/github/threads.js";
import { deriveStatusUrl } from "../src/insights/config.js";
import {
  NO_SECRET_TEXT,
  deliverStatusReport,
} from "../src/insights/deliver.js";
import { sendInsightsReport } from "../src/insights/send.js";
import {
  MAX_STATUS_FINDINGS,
  buildStatusPayload,
} from "../src/insights/status.js";
import { buildSummary } from "../src/summary.js";
import { createFakeCore } from "./helpers/fake-core.js";
import {
  apiThread,
  createFakeOctokit,
  OWN_ACCOUNT,
} from "./helpers/github-api.js";
import {
  INSIGHTS_TEST_SECRET,
  startInsightsApi,
} from "./helpers/insights-api.js";
import { validateStatusPayload } from "./helpers/insights-contract.js";
import { fromRoot } from "./helpers/run-action.js";

// The status report (#77): what the action reports about its earlier
// findings. No test here reaches GitHub or Insights.

const PULL_REQUEST = { owner: "octo-org", repo: "demo", pullNumber: 42 };
const RUN = { runId: 18234567890, runAttempt: 1 };

/** A parsed file of the pull request that adds the lines "a", "b" and "c". */
function diffOf(path = "src/app.js", lines = ["a", "b", "c"]) {
  const patch = `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
  return { path, ...parsePatch(patch) };
}
const fingerprintOf = (content, previous = "", path = "src/app.js") =>
  lineFingerprint(path, content, previous);

const comment = (id, content, previous = "", path = "src/app.js") => ({
  id,
  path,
  fingerprint: fingerprintOf(content, previous, path),
});
const threadsOf = (...entries) => new Map(entries);

function build(overrides = {}) {
  return buildStatusPayload({
    pullRequest: PULL_REQUEST,
    run: RUN,
    state: "open",
    comments: [],
    diffs: [diffOf()],
    unknownPaths: new Set(),
    listingTruncated: false,
    threads: new Map(),
    ...overrides,
  });
}

// --- The state of the pull request --------------------------------------------

test("reads open, merged and closed from the event", () => {
  const state = (pull_request) =>
    readPullRequestState({ payload: { pull_request } });

  assert.equal(state({ state: "open" }), "open");
  assert.equal(state({ state: "closed", merged: true }), "merged");
  assert.equal(state({ state: "closed", merged: false }), "closed");
  assert.equal(state({ state: "closed" }), "closed");
});

test("counts everything that is not exactly closed as open", () => {
  for (const payload of [
    {},
    { pull_request: null },
    { pull_request: {} },
    { pull_request: { state: "CLOSED", merged: true } },
    { pull_request: { state: ["closed"] } },
    { pull_request: { state: "open", merged: true } },
  ]) {
    assert.equal(readPullRequestState({ payload }), "open");
  }
  assert.equal(readPullRequestState({}), "open");
});

// --- The address ---------------------------------------------------------------

test("derives the address of the status report from the one of the review report", () => {
  assert.equal(
    deriveStatusUrl("https://insights.example.com/api/v1/ingest/review"),
    "https://insights.example.com/api/v1/ingest/status",
  );
  assert.equal(
    deriveStatusUrl("http://127.0.0.1:8080/review"),
    "http://127.0.0.1:8080/status",
  );
});

test("gives no address for a path that does not end on /review", () => {
  for (const url of [
    "https://insights.example.com/api/v1/ingest",
    "https://insights.example.com/api/v1/ingest/review/",
    "https://insights.example.com/api/v1/ingest/reviews",
    "https://insights.example.com/",
  ]) {
    assert.equal(deriveStatusUrl(url), null, url);
  }
});

// --- The threads ----------------------------------------------------------------

test("reads for each thread whether it is resolved and whether the comment has a thumbs down", async () => {
  const octokit = createFakeOctokit([], {
    threads: [
      apiThread(1, true),
      apiThread(2, false, { thumbsDown: true }),
      apiThread(3, true, { thumbsDown: true }),
      apiThread(4),
    ],
  });

  const states = await readThreadStates(octokit, PULL_REQUEST);

  assert.deepEqual(
    [...states],
    [
      [1, { resolved: true, thumbsDown: false, known: true }],
      [2, { resolved: false, thumbsDown: true, known: true }],
      [3, { resolved: true, thumbsDown: true, known: true }],
      [4, { resolved: false, thumbsDown: false, known: true }],
    ],
  );
});

test("takes only a thumbs down with a count above zero, and only that reaction", async () => {
  const group = (content, totalCount) => ({
    content,
    reactors: { totalCount },
  });
  const octokit = createFakeOctokit([], {
    threads: [
      apiThread(1, false, { reactionGroups: [group("THUMBS_UP", 5)] }),
      apiThread(2, false, { reactionGroups: [group("THUMBS_DOWN", 0)] }),
      apiThread(3, false, { reactionGroups: [group("THUMBS_DOWN", "2")] }),
      apiThread(4, false, { reactionGroups: [group("THUMBS_DOWN", 1)] }),
      apiThread(5, false, { reactionGroups: "THUMBS_DOWN" }),
      apiThread(6, false, { reactionGroups: [null, {}] }),
    ],
  });

  const states = await readThreadStates(octokit, PULL_REQUEST);

  assert.deepEqual(
    [...states].map(([id, { thumbsDown }]) => [id, thumbsDown]),
    [
      [1, false],
      [2, false],
      [3, false],
      [4, true],
      [5, false],
      [6, false],
    ],
  );
});

test("marks a thread whose fields have another shape as not known", async () => {
  const octokit = createFakeOctokit([], {
    threads: [
      apiThread(1, true),
      {
        isResolved: "true",
        comments: { nodes: [{ databaseId: 2, reactionGroups: [] }] },
      },
      { isResolved: true, comments: { nodes: [{ databaseId: 3 }] } },
      {
        isResolved: false,
        comments: { nodes: [{ databaseId: 4, reactionGroups: "none" }] },
      },
    ],
  });

  const states = await readThreadStates(octokit, PULL_REQUEST);

  assert.deepEqual(
    [...states].map(([id, { known }]) => [id, known]),
    [
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ],
  );
  // The count of open findings still reads them as before.
  assert.deepEqual([...resolvedOf(states)], [1, 3]);
});

test("lets nothing but two truth values leave the thread query", async () => {
  const thread = apiThread(7, true, {
    reactionGroups: [
      {
        content: "THUMBS_DOWN",
        reactors: { totalCount: 41, nodes: [{ login: "someone-secret" }] },
      },
    ],
  });
  const octokit = createFakeOctokit([], { threads: [thread] });

  const states = await readThreadStates(octokit, PULL_REQUEST);

  assert.deepEqual(states.get(7), {
    resolved: true,
    thumbsDown: true,
    known: true,
  });
  assert.doesNotMatch(JSON.stringify([...states]), /someone-secret|41/);
});

test("asks for the reactions in the same query, without names", async () => {
  const octokit = createFakeOctokit([], { threads: [apiThread(1)] });

  await readThreadStates(octokit, PULL_REQUEST);

  assert.equal(octokit.queries.length, 1);
  const { query } = octokit.queries[0];
  assert.match(query, /reactionGroups \{ content reactors \{ totalCount \} \}/);
  assert.doesNotMatch(query, /login|nodes \{ login|users|viewerHasReacted/);
});

test("still returns the resolved comments for the count of open findings", async () => {
  const octokit = createFakeOctokit([], {
    threads: [apiThread(1, true), apiThread(2), apiThread(3, true)],
  });

  assert.deepEqual(
    [...(await readResolvedComments(octokit, PULL_REQUEST))],
    [1, 3],
  );
});

// --- The earlier comments -------------------------------------------------------

const MARKER = "<!-- reviewops -->";
const ownComment = (id, fingerprint, fields = {}) => ({
  id,
  body: `${MARKER}\n${fingerprintLine(fingerprint)}\n\ntext`,
  user: OWN_ACCOUNT,
  path: "src/app.js",
  ...fields,
});

test("lists every own inline comment with a fingerprint, with or without a severity", async () => {
  const octokit = createFakeOctokit([], {
    existingComments: [
      ownComment(1, "a".repeat(16)),
      {
        id: 2,
        body: `${MARKER}\n${fingerprintLine("b".repeat(16), "major")}\n\ntext`,
        user: OWN_ACCOUNT,
        path: "src/other.js",
      },
      // Not read: written by a person, no fingerprint, no id, no path.
      ownComment(3, "c".repeat(16), { user: { type: "User", login: "x" } }),
      {
        id: 4,
        body: `${MARKER}\n\ntext`,
        user: OWN_ACCOUNT,
        path: "src/app.js",
      },
      ownComment(0, "d".repeat(16)),
      ownComment(5, "e".repeat(16), { path: "" }),
    ],
  });

  const history = await readHistory(octokit, {
    ...PULL_REQUEST,
    headSha: "1".repeat(40),
  });

  assert.deepEqual(history.inlineComments, [
    {
      id: 1,
      path: "src/app.js",
      fingerprint: "a".repeat(16),
      textFingerprint: null,
    },
    {
      id: 2,
      path: "src/other.js",
      fingerprint: "b".repeat(16),
      textFingerprint: null,
    },
  ]);
});

test("compares no commits when asked not to", async () => {
  const octokit = createFakeOctokit([], {
    existingReviews: [
      {
        id: 9,
        body: `${MARKER}\n\n### ReviewOps`,
        user: OWN_ACCOUNT,
        state: "COMMENTED",
        commit_id: "a".repeat(40),
      },
    ],
    compare: () => ({ status: "ahead", files: [] }),
  });

  const history = await readHistory(
    octokit,
    { ...PULL_REQUEST, headSha: "1".repeat(40) },
    { compare: false },
  );

  assert.equal(octokit.comparisons.length, 0);
  assert.equal(history.mode, "full");
});

// --- buildStatusPayload() -------------------------------------------------------

test("reports the three facts for a finding", () => {
  const first = comment(10, "a");
  const second = comment(11, "b", "a");
  const third = comment(12, "c", "b");

  const { payload, omitted } = build({
    comments: [first, second, third],
    // The line "b" was changed since the comment.
    diffs: [diffOf("src/app.js", ["a", "B", "c"])],
    threads: threadsOf(
      [10, { resolved: false, thumbsDown: false }],
      [11, { resolved: true, thumbsDown: false }],
      [12, { resolved: false, thumbsDown: true }],
    ),
  });

  assert.deepEqual(omitted, { unknown: 0, overLimit: 0 });
  assert.deepEqual(payload.findings, [
    {
      fingerprint: first.fingerprint,
      lineUnchanged: true,
      threadResolved: false,
      thumbsDown: false,
    },
    {
      fingerprint: second.fingerprint,
      lineUnchanged: false,
      threadResolved: true,
      thumbsDown: false,
    },
    {
      // "c" follows another line now, so its fingerprint changed as well.
      fingerprint: third.fingerprint,
      lineUnchanged: false,
      threadResolved: false,
      thumbsDown: true,
    },
  ]);
  assert.deepEqual(validateStatusPayload(payload), []);
});

test("takes the repository, the number, the run and the state from the run", () => {
  const { payload } = build({
    state: "merged",
    comments: [comment(1, "a")],
    threads: threadsOf([1, { resolved: false, thumbsDown: false }]),
  });

  assert.deepEqual(
    { ...payload, findings: undefined },
    {
      schemaVersion: 1,
      repository: "octo-org/demo",
      prNumber: 42,
      runId: 18234567890,
      runAttempt: 1,
      pullRequestState: "merged",
      findings: undefined,
    },
  );
});

test("makes one entry of two comments with one fingerprint: all threads must be resolved, one thumbs down counts", () => {
  const one = comment(1, "a");
  const two = { ...one, id: 2 };
  const threads = (a, b) => threadsOf([1, a], [2, b]);
  const open = { resolved: false, thumbsDown: false };
  const done = { resolved: true, thumbsDown: false };
  const down = { resolved: true, thumbsDown: true };

  const mixed = build({ comments: [one, two], threads: threads(open, done) });
  const resolved = build({
    comments: [one, two],
    threads: threads(done, done),
  });
  const disliked = build({
    comments: [one, two],
    threads: threads(done, down),
  });

  assert.equal(mixed.payload.findings.length, 1);
  assert.equal(mixed.payload.findings[0].threadResolved, false);
  assert.equal(resolved.payload.findings[0].threadResolved, true);
  assert.equal(disliked.payload.findings[0].thumbsDown, true);
  assert.equal(disliked.payload.findings[0].threadResolved, true);
});

test("says that the line is gone for a file that left the pull request", () => {
  const { payload } = build({
    comments: [comment(1, "x", "", "src/gone.js")],
    threads: threadsOf([1, { resolved: false, thumbsDown: false }]),
  });

  assert.equal(payload.findings[0].lineUnchanged, false);
});

test("leaves out a finding whose file is in the pull request without a diff", () => {
  const { payload, omitted } = build({
    comments: [comment(1, "a"), comment(2, "x", "", "src/secret.js")],
    unknownPaths: new Set(["src/secret.js"]),
    threads: threadsOf(
      [1, { resolved: false, thumbsDown: false, known: true }],
      [2, { resolved: false, thumbsDown: false }],
    ),
  });

  assert.equal(payload.findings.length, 1);
  assert.deepEqual(omitted, { unknown: 1, overLimit: 0 });
});

test("leaves out a finding in a file that is not among the parsed ones when the list of files was cut off", () => {
  const { payload, omitted } = build({
    comments: [comment(1, "a"), comment(2, "x", "", "src/later.js")],
    listingTruncated: true,
    threads: threadsOf(
      [1, { resolved: false, thumbsDown: false, known: true }],
      [2, { resolved: false, thumbsDown: false }],
    ),
  });

  assert.deepEqual(
    payload.findings.map(({ fingerprint }) => fingerprint),
    [fingerprintOf("a")],
  );
  assert.equal(omitted.unknown, 1);
});

test("leaves out a finding whose thread is not known", () => {
  const { payload, omitted } = build({
    comments: [comment(1, "a"), comment(2, "b", "a")],
    threads: threadsOf(
      [1, { resolved: false, thumbsDown: false, known: true }],
      [2, { resolved: false, thumbsDown: false, known: false }],
    ),
  });

  assert.equal(payload.findings.length, 1);
  assert.deepEqual(omitted, { unknown: 1, overLimit: 0 });
});

test("leaves out a finding whose thread was not read", () => {
  const { payload, omitted } = build({
    comments: [comment(1, "a"), comment(2, "b", "a")],
    threads: threadsOf([1, { resolved: true, thumbsDown: false }]),
  });

  assert.equal(payload.findings.length, 1);
  assert.deepEqual(omitted, { unknown: 1, overLimit: 0 });
});

test("sends nothing when no finding has a known state", () => {
  assert.deepEqual(build().payload, null);
  const none = build({ comments: [comment(1, "a")] });
  assert.equal(none.payload, null);
  assert.equal(none.omitted.unknown, 1);
});

test("reports the oldest 1000 findings and counts the rest", () => {
  const lines = Array.from(
    { length: MAX_STATUS_FINDINGS + 5 },
    (_, i) => `l${i}`,
  );
  const comments = lines.map((line, index) =>
    comment(index + 1, line, lines[index - 1] ?? ""),
  );
  const threads = new Map(
    comments.map(({ id }) => [id, { resolved: false, thumbsDown: false }]),
  );

  const { payload, omitted } = build({
    comments: comments.toReversed(),
    diffs: [diffOf("src/app.js", lines)],
    threads,
  });

  assert.equal(payload.findings.length, MAX_STATUS_FINDINGS);
  assert.equal(payload.findings[0].fingerprint, comments[0].fingerprint);
  assert.equal(
    payload.findings.at(-1).fingerprint,
    comments[MAX_STATUS_FINDINGS - 1].fingerprint,
  );
  assert.deepEqual(omitted, { unknown: 0, overLimit: 5 });
  assert.deepEqual(validateStatusPayload(payload), []);
});

test("copies fields one by one: nothing but the contract is in the report", () => {
  const extra = {
    ...comment(1, "a"),
    body: "secret text of a comment",
    author: "someone",
  };
  const { payload } = build({
    comments: [extra],
    threads: threadsOf([
      1,
      { resolved: true, thumbsDown: true, count: 9, by: "someone" },
    ]),
  });

  assert.deepEqual(validateStatusPayload(payload), []);
  assert.doesNotMatch(
    JSON.stringify(payload),
    /secret text|someone|count|\b9\b/,
  );
});

// --- The contract ----------------------------------------------------------------

test("the example file of the contract is valid and has the three kinds of state", () => {
  const example = JSON.parse(
    readFileSync(fromRoot("test/fixtures/insights-status-v1.json"), "utf8"),
  );

  assert.deepEqual(validateStatusPayload(example), []);
  assert.equal(example.pullRequestState, "merged");
  assert.ok(example.findings.some((f) => f.threadResolved === null));
});

test("the validator refuses what the contract refuses", () => {
  const valid = JSON.parse(
    readFileSync(fromRoot("test/fixtures/insights-status-v1.json"), "utf8"),
  );
  const broken = [
    { ...valid, schemaVersion: 2 },
    { ...valid, pullRequestState: "draft" },
    { ...valid, findings: [] },
    { ...valid, extra: 1 },
    { ...valid, findings: [{ ...valid.findings[0], thumbsDown: "true" }] },
    { ...valid, findings: [{ ...valid.findings[0], fingerprint: "ABC" }] },
    { ...valid, findings: [valid.findings[0], valid.findings[0]] },
    { ...valid, findings: [{ ...valid.findings[0], count: 3 }] },
  ];
  for (const payload of broken) {
    assert.ok(validateStatusPayload(payload).length > 0);
  }
});

// --- Sending ----------------------------------------------------------------------

test("takes 200 as the answer to a status report and 201 as an error", async (t) => {
  const payload = JSON.parse(
    readFileSync(fromRoot("test/fixtures/insights-status-v1.json"), "utf8"),
  );
  const api = await startInsightsApi(t);

  const stored = await sendInsightsReport({
    url: api.statusUrl,
    secret: INSIGHTS_TEST_SECRET,
    payload,
    kind: "status",
  });

  assert.deepEqual(stored, {
    delivered: true,
    outcome: "stored",
    httpStatus: 200,
    attempts: 1,
  });
  assert.equal(api.requests[0].path, "/api/v1/ingest/status");
  assert.equal(api.requests[0].signatureValid, true);

  const created = await sendInsightsReport({
    url: api.url,
    secret: INSIGHTS_TEST_SECRET,
    payload,
    kind: "status",
    fetch: async () => new Response(null, { status: 201 }),
  });
  assert.equal(created.delivered, false);
});

test("keeps the answers to a review report as they were", async () => {
  const fetch = async () => new Response(null, { status: 200 });
  const result = await sendInsightsReport({
    url: "http://127.0.0.1:1/review",
    secret: INSIGHTS_TEST_SECRET,
    payload: { a: 1 },
    fetch,
  });

  assert.equal(result.outcome, "duplicate");
});

// --- deliverStatusReport() ---------------------------------------------------------

const insights = {
  statusUrl: "https://insights.example.com/api/v1/ingest/status",
  secret: INSIGHTS_TEST_SECRET,
};
const facts = () => ({
  pullRequest: PULL_REQUEST,
  context: { runId: 18234567890, runAttempt: 1 },
  state: "open",
  comments: [comment(1, "a")],
  diffs: [diffOf()],
  unknownPaths: new Set(),
  listingTruncated: false,
  threads: threadsOf([1, { resolved: false, thumbsDown: false }]),
});

async function deliver({ send, factsOverride = {} } = {}) {
  const core = createFakeCore();
  const sent = [];
  const result = await deliverStatusReport({
    core,
    redact: String,
    insights,
    send:
      send ??
      (async (request) => {
        sent.push(request);
        return {
          delivered: true,
          outcome: "stored",
          httpStatus: 200,
          attempts: 1,
        };
      }),
    facts: { ...facts(), ...factsOverride },
  });
  return { core, sent, result };
}

test("sends the status report to the derived address with the kind status", async () => {
  const { core, sent, result } = await deliver();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, insights.statusUrl);
  assert.equal(sent[0].kind, "status");
  assert.deepEqual(validateStatusPayload(sent[0].payload), []);
  assert.equal(result.text, "The status report reached ReviewOps Insights.");
  assert.deepEqual(core.messages("warning"), []);
  assert.match(core.messages("info").join("\n"), /Status report delivered/);
});

test("names a failure in a warning and fails nothing", async () => {
  const { core, result } = await deliver({
    send: async () => ({
      delivered: false,
      reason: "http",
      httpStatus: 401,
      attempts: 1,
    }),
  });

  assert.equal(core.messages("setFailed").length, 0);
  assert.match(
    core.messages("warning")[0],
    /HTTP 401.*same value as `INGEST_SECRET`/,
  );
  assert.match(result.text, /did not reach/);
});

test("turns an error while sending into a fixed warning", async () => {
  const { core } = await deliver({
    send: async () => {
      throw new Error("boom with https://insights.example.com and a secret");
    },
  });

  assert.deepEqual(core.messages("warning"), [
    "The status report for ReviewOps Insights could not be built or sent.",
  ]);
  assert.doesNotMatch(
    core.calls.map((c) => c.args.join(" ")).join("\n"),
    /boom/,
  );
});

test("sends nothing when no finding has a known state, and says so", async () => {
  const { core, sent, result } = await deliver({
    factsOverride: { threads: new Map() },
  });

  assert.equal(sent.length, 0);
  assert.match(result.text, /none of the earlier findings has a known state/);
  assert.match(core.messages("info").join("\n"), /1 whose state is not known/);
});

test("puts no fingerprint, address or secret into the log", async () => {
  const { core } = await deliver({
    factsOverride: { threads: new Map() },
  });

  const log = core.calls.map((c) => c.args.join(" ")).join("\n");
  assert.doesNotMatch(log, new RegExp(fingerprintOf("a")));
  assert.doesNotMatch(log, /insights\.example\.com|TESTSECRET/);
});

test("names the missing secret in one fixed sentence", () => {
  assert.match(NO_SECRET_TEXT, /forks and of Dependabot/);
});

// --- The summary ------------------------------------------------------------------------

test("shows both reports under one heading", () => {
  const text = buildSummary({
    status: "Done.",
    insights: { text: "The report reached ReviewOps Insights." },
    insightsStatus: { text: "The status report reached ReviewOps Insights." },
  });

  assert.equal(text.match(/### ReviewOps Insights/g).length, 1);
  assert.match(text, /The report reached/);
  assert.match(text, /The status report reached/);
});

test("says nothing about Insights without a report", () => {
  assert.doesNotMatch(buildSummary({ status: "Done." }), /Insights/);
});

// --- The documentation ---------------------------------------------------------------

const DOC = readFileSync(fromRoot("docs/insights-payload.md"), "utf8");
const STATUS_DOC = DOC.slice(DOC.indexOf("## Status report (v1)"));

test("the field table of the status report in docs/insights-payload.md equals the report", () => {
  const table = STATUS_DOC.match(/### Fields([\s\S]*?)\n### /)[1];
  const documented = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
  const { payload } = build({
    comments: [comment(1, "a")],
    threads: threadsOf([1, { resolved: true, thumbsDown: false }]),
  });
  const built = Object.entries(payload).flatMap(([key, value]) =>
    Array.isArray(value)
      ? [key, ...Object.keys(value[0]).map((field) => `${key}[].${field}`)]
      : [key],
  );

  assert.deepEqual(documented.sort(), built.sort());
});

test("the example of the status report in docs/insights-payload.md is the fixture", () => {
  const example = STATUS_DOC.match(
    /### Example[\s\S]*?```json\n([\s\S]*?)```/,
  )[1];
  const fixture = JSON.parse(
    readFileSync(fromRoot("test/fixtures/insights-status-v1.json"), "utf8"),
  );

  assert.deepStrictEqual(JSON.parse(example), fixture);
});

test("the documentation names the derived address, the 1000 findings and the thumbs down", () => {
  assert.match(STATUS_DOC, /`\/review` becomes `\/status`/);
  assert.match(STATUS_DOC, new RegExp(`1 to ${MAX_STATUS_FINDINGS} entries`));
  assert.match(STATUS_DOC, /👎/);
});

// --- The text fingerprint (#107) ------------------------------------------------

const withText = (item, content) => ({
  ...item,
  textFingerprint: textFingerprint(content),
});
const OPEN = { resolved: false, thumbsDown: false };

test("says the line is unchanged after a rename, with the fingerprint of the comment", () => {
  const old = withText(comment(1, "b", "a", "src/old.js"), "b");

  const { payload } = build({
    comments: [old],
    diffs: [diffOf("src/new.js", ["a", "b", "c"])],
    threads: threadsOf([1, OPEN]),
  });

  assert.deepEqual(payload.findings, [
    {
      fingerprint: old.fingerprint,
      lineUnchanged: true,
      threadResolved: false,
      thumbsDown: false,
    },
  ]);
  assert.deepEqual(validateStatusPayload(payload), []);
});

test("says the line is unchanged after a change of the line above", () => {
  const item = withText(comment(1, "b", "a"), "b");
  const { payload } = build({
    comments: [item],
    diffs: [diffOf("src/app.js", ["a2", "b"])],
    threads: threadsOf([1, OPEN]),
  });
  assert.equal(payload.findings[0].lineUnchanged, true);
});

test("says the line changed when its own text changed", () => {
  const item = withText(comment(1, "b", "a"), "b");
  const { payload } = build({
    comments: [item],
    diffs: [diffOf("src/app.js", ["a", "b2"])],
    threads: threadsOf([1, OPEN]),
  });
  assert.equal(payload.findings[0].lineUnchanged, false);
});

test("a comment without a text fingerprint is judged as before", () => {
  const { payload } = build({
    comments: [comment(1, "b", "a")],
    diffs: [diffOf("src/app.js", ["a2", "b"])],
    threads: threadsOf([1, OPEN]),
  });
  assert.equal(payload.findings[0].lineUnchanged, false);
});

test("the report holds no text fingerprint, no path and no line text", () => {
  const item = withText(comment(1, "b", "a", "src/old.js"), "b");
  const { payload } = build({
    comments: [item],
    diffs: [diffOf("src/new.js", ["a", "b"])],
    threads: threadsOf([1, OPEN]),
  });

  const text = JSON.stringify(payload);
  assert.ok(!text.includes(item.textFingerprint));
  assert.ok(!text.includes("src/"));
  assert.deepEqual(Object.keys(payload.findings[0]).sort(), [
    "fingerprint",
    "lineUnchanged",
    "threadResolved",
    "thumbsDown",
  ]);
});
