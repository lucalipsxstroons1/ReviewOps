import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apiFile, apiFiles, startGitHubApi } from "./helpers/github-api.js";
import {
  apiError,
  reviewCompletion,
  startOpenAiApi,
} from "./helpers/openai-api.js";
import {
  API_KEY,
  PULL_REQUEST_EVENT,
  REVIEWING_LINE,
  TOKEN,
  fromRoot,
  startAction,
  withInputs,
  withoutMaskCommands,
} from "./helpers/run-action.js";

const runAction = (env) => startAction(fromRoot("src/index.js"), env);

/**
 * Environment of a complete pull_request run against the local API servers.
 * Without a server for OpenAI, its requests go nowhere.
 */
const pullRequestRun = (api, env = {}) =>
  withInputs({
    ...PULL_REQUEST_EVENT,
    GITHUB_API_URL: api.url,
    TEST_OPENAI_URL: api.openai?.url ?? "",
    ...env,
  });

/**
 * Starts the local GitHub API and a local stand-in for OpenAI. Without an
 * answer, the model finds nothing.
 */
async function startApis(t, github, answer = reviewCompletion()) {
  const api = await startGitHubApi(t, github);
  const openai = await startOpenAiApi(t, answer);
  return { ...api, openai };
}

/** Writes an event file with the given content and removes it after the test. */
function eventFile(t, content) {
  const directory = mkdtempSync(join(tmpdir(), "reviewops-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "event.json");
  writeFileSync(path, content);
  return path;
}

test("names the pull request and lists its files", async (t) => {
  const api = await startApis(t, {
    files: [...apiFiles(2), apiFile("docs/old.md", { status: "removed" })],
  });

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^ReviewOps started\.$/m);
  assert.ok(result.stdout.includes(REVIEWING_LINE));
  assert.match(
    result.stdout,
    /^Found 3 changed files: 2 to review, 1 skipped\.$/m,
  );
  assert.match(
    result.stdout,
    /^Skipped docs\/old\.md: the file was deleted\.$/m,
  );
  assert.match(
    result.stdout,
    /^Parsed the diffs of 2 files: 2 added lines can receive comments\.$/m,
  );
  assert.equal(result.stderr, "");
  assert.deepEqual(
    api.requests.map((request) => request.path),
    [
      "/repos/octo-org/demo/pulls/42/files?per_page=100",
      "/repos/octo-org/demo/pulls/42/reviews?per_page=100",
      "/repos/octo-org/demo/pulls/42/comments?per_page=100",
    ],
  );
});

test("loads a pull request with more than 100 files completely", async (t) => {
  const api = await startApis(t, { files: apiFiles(120) });

  // The limit is raised: this test is about loading, not about the limit.
  const result = await runAction(
    pullRequestRun(api, { "INPUT_MAX-FILES": "500" }),
  );

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Found 120 changed files: 120 to review, 0 skipped\.$/m,
  );
  // Two pages of files, then the reviews and the comments.
  assert.equal(api.requests.length, 4);
});

test("leaves out the files over the limit and names them", async (t) => {
  const api = await startApis(t, { files: apiFiles(120) });

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Found 120 changed files: 50 to review, 70 skipped\.$/m,
  );
  assert.match(
    result.stdout,
    /^Skipped src\/file-50\.js: over the limit of 50 files \(max-files\)\.$/m,
  );
  // The log names the first 50 skipped files and counts the other 20.
  assert.match(result.stdout, /^20 more skipped files are not listed\.$/m);
  assert.match(
    result.stdout,
    /^::warning::Files left out because of the limits: 70\. They are not reviewed\. The limits are max-files: 50 and max-diff-chars: 200000\.$/m,
  );
  assert.match(result.stdout, /^Diff size: \d+ of 200000 characters\.$/m);
  assert.doesNotMatch(result.stdout, /::error::/);
  assert.equal(result.stderr, "");
});

test("uses the limits from the inputs and tells how the budget is used", async (t) => {
  const api = await startApis(t, { files: apiFiles(5) });

  const result = await runAction(
    pullRequestRun(api, {
      "INPUT_MAX-FILES": "3",
      "INPUT_MAX-DIFF-CHARS": "1000",
    }),
  );

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Skipped src\/file-3\.js: over the limit of 3 files \(max-files\)\.$/m,
  );
  assert.match(result.stdout, /^Diff size: \d+ of 1000 characters\.$/m);
  assert.match(
    result.stdout,
    /The limits are max-files: 3 and max-diff-chars: 1000\./,
  );
});

test("ends green with a notice when no file fits the budget", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(2) });

  const result = await runAction(
    pullRequestRun(api, { "INPUT_MAX-DIFF-CHARS": "10" }),
  );

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Skipped src\/file-0\.js: does not fit into the budget of 10 characters \(max-diff-chars\)\.$/m,
  );
  assert.match(result.stdout, /^::notice::ReviewOps found no files to review/m);
  assert.doesNotMatch(result.stdout, /::error::/);
  assert.equal(result.stderr, "");
});

test("does not fail on a pull request with 3000 files", async (t) => {
  const api = await startApis(t, { files: apiFiles(3000) });

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Found 3000 changed files: 50 to review, 2950 skipped\.$/m,
  );
  assert.match(result.stdout, /^::warning::GitHub lists at most 3000 files/m);
  assert.doesNotMatch(result.stdout, /::error::/);
});

test("fails the step before any request when the API key has a space in it", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(1) });

  const result = await runAction(
    pullRequestRun(api, { "INPUT_OPENAI-API-KEY": "TESTKEY-not a-real-key" }),
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^::error::Input `openai-api-key` contains a character that is not allowed/m,
  );
  assert.equal(
    withoutMaskCommands(result.output).includes("not a-real"),
    false,
  );
  assert.doesNotMatch(result.stdout, /ReviewOps started\./);
  assert.deepEqual(api.requests, []);
  assert.equal(result.stderr, "");
});

test("fails the step before any request when openai-model is not a model name", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(1) });

  const result = await runAction(
    pullRequestRun(api, { "INPUT_OPENAI-MODEL": "gpt 4" }),
  );

  assert.equal(result.status, 1);
  assert.ok(
    result.stdout.includes(
      '::error::Input `openai-model` must be the name of an OpenAI model (letters, digits, ".", "-", "_" and ":", at most 100 characters), but is "gpt 4".',
    ),
  );
  assert.doesNotMatch(result.stdout, /ReviewOps started\./);
  assert.deepEqual(api.requests, []);
  assert.equal(result.stderr, "");
});

test("fails the step before any request when language is not a language code", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(1) });

  const result = await runAction(
    pullRequestRun(api, { INPUT_LANGUAGE: "klingon" }),
  );

  assert.equal(result.status, 1);
  assert.ok(
    result.stdout.includes(
      '::error::Input `language` must be one of en, de, fr, es, it, pt, nl, pl, tr, ja, zh, ko, but is "klingon".',
    ),
  );
  assert.doesNotMatch(result.stdout, /ReviewOps started\./);
  assert.deepEqual(api.requests, []);
  assert.equal(result.stderr, "");
});

test("asks the model for feedback in the language from the input", async (t) => {
  const api = await startApis(t, { files: apiFiles(1) });

  const result = await runAction(pullRequestRun(api, { INPUT_LANGUAGE: "de" }));

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /::error::/);
  assert.equal(api.openai.requests.length, 1);
  const [system] = api.openai.requests[0].body.messages;
  assert.match(system.content, /suggestion in German\./);
  assert.equal(result.stderr, "");
});

test("sends the request with the model from the input", async (t) => {
  const api = await startApis(t, { files: apiFiles(1) });

  const result = await runAction(
    pullRequestRun(api, { "INPUT_OPENAI-MODEL": "gpt-4.1" }),
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Sending 1 files to gpt-4\.1 in 1 requests\.$/m);
  assert.equal(api.openai.requests[0].body.model, "gpt-4.1");
  assert.equal(result.stderr, "");
});

test("sends the key only to the stand-in for OpenAI and reports the review", async (t) => {
  const api = await startApis(t, { files: apiFiles(2) });

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.equal(api.openai.requests.length, 1);
  const [request] = api.openai.requests;
  assert.equal(request.path, "/v1/chat/completions");
  assert.equal(request.authorization, `Bearer ${API_KEY}`);
  assert.match(
    request.body.messages[1].content,
    /^<file path="src\/file-0\.js">\n/,
  );
  assert.match(
    result.stdout,
    /^Review finished: 0 findings \(0 critical, 0 major, 0 minor, 0 info\) from 1 of 1 requests\.$/m,
  );
  assert.equal(withoutMaskCommands(result.output).includes(API_KEY), false);
  assert.equal(result.stderr, "");
});

test("spreads a large pull request over several requests", async (t) => {
  const big = (path) =>
    apiFile(path, {
      additions: 3000,
      deletions: 0,
      patch: ["@@ -0,0 +1,3000 @@", ...Array(3000).fill("+x")].join("\n"),
    });
  const api = await startApis(t, {
    files: [big("src/a.js"), big("src/b.js"), apiFile("src/c.js")],
  });

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.equal(api.openai.requests.length, 2);
  assert.match(
    result.stdout,
    /^Sending 3 files to gpt-6-luna in 2 requests\.$/m,
  );
  assert.match(result.stdout, /from 2 of 2 requests\.$/m);
  assert.equal(result.stderr, "");
});

test("ends green with a warning when one of several requests fails", async (t) => {
  const big = (path) =>
    apiFile(path, {
      additions: 3000,
      deletions: 0,
      patch: ["@@ -0,0 +1,3000 @@", ...Array(3000).fill("+x")].join("\n"),
    });
  const api = await startApis(
    t,
    { files: [big("src/a.js"), big("src/b.js")] },
    (request) =>
      request.body.messages[1].content.includes('<file path="src/b.js">')
        ? apiError(400)
        : reviewCompletion(),
  );

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^::warning::Requests to the model that failed: 1 of 2\. 1 files were not reviewed\. OpenAI rejected the request \(HTTP 400\)\./m,
  );
  assert.match(
    result.stdout,
    /^Not reviewed src\/b\.js: the request to the model failed\.$/m,
  );
  assert.doesNotMatch(result.stdout, /::error::/);
  assert.equal(result.stderr, "");
});

test("never sends a file that may hold secrets to OpenAI, also with an empty exclude input", async (t) => {
  const api = await startApis(t, {
    files: [
      apiFile(".env", { patch: "@@ -0,0 +1 @@\n+VALUE-FROM-ENV-FILE" }),
      apiFile("src/app.js"),
    ],
  });

  const result = await runAction(pullRequestRun(api, { INPUT_EXCLUDE: "" }));

  assert.equal(result.status, 0);
  assert.equal(api.openai.requests.length, 1);
  const sent = JSON.stringify(api.openai.requests[0].body);
  assert.match(sent, /src\/app\.js/);
  assert.doesNotMatch(sent, /VALUE-FROM-ENV-FILE|\.env/);
  assert.match(
    result.stdout,
    /^Skipped \.env: may hold secrets and is never sent to the model\.$/m,
  );
  assert.match(result.stdout, /^::warning::Files that may hold secrets: 1\./m);
  assert.equal(result.stderr, "");
});

test("sends a token in the diff to OpenAI only masked", async (t) => {
  // Put together at run time: no file contains anything that looks like a
  // credential.
  const token = `gh${"p"}_${"Ab1".repeat(12)}`;
  const api = await startApis(t, {
    files: [
      apiFile("src/config.js", {
        patch: `@@ -0,0 +1 @@\n+const token = "${token}";`,
      }),
    ],
  });

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0);
  const sent = JSON.stringify(api.openai.requests[0].body);
  assert.ok(!sent.includes(token));
  assert.ok(sent.includes('const token = \\"[REDACTED SECRET]\\";'));
  assert.ok(!result.output.includes(token));
  assert.match(
    result.stdout,
    /^::warning::Strings that look like secrets were masked before anything was sent to the model: 1 in 1 files\./m,
  );
});

test("fails the step when OpenAI rejects the key", async (t) => {
  const api = await startApis(t, { files: apiFiles(1) }, apiError(401));

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^::error::OpenAI rejected the API key \(HTTP 401\)\./m,
  );
  assert.equal(withoutMaskCommands(result.output).includes(API_KEY), false);
  assert.equal(result.stderr, "");
});

test("fails the step when OpenAI cannot be reached", async (t) => {
  // No stand-in for OpenAI: its requests go to an address that refuses them.
  const api = await startGitHubApi(t, { files: apiFiles(1) });

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::OpenAI could not be reached\./m);
  assert.equal(result.stderr, "");
});

for (const [input, value] of [
  ["INPUT_MAX-FILES", "0"],
  ["INPUT_MAX-FILES", "many"],
  ["INPUT_MAX-DIFF-CHARS", "-5"],
]) {
  test(`fails the step before any request when ${input} is "${value}"`, async (t) => {
    const api = await startGitHubApi(t, { files: apiFiles(1) });

    const result = await runAction(pullRequestRun(api, { [input]: value }));

    const name = input.slice("INPUT_".length).toLowerCase();
    assert.equal(result.status, 1);
    assert.ok(
      result.stdout.includes(
        `::error::Input \`${name}\` must be a whole number from 1 to 999999999, but is "${value}".`,
      ),
    );
    assert.doesNotMatch(result.stdout, /ReviewOps started\./);
    assert.deepEqual(api.requests, []);
    assert.equal(result.stderr, "");
  });
}

test("skips a file whose diff cannot be read without failing the step", async (t) => {
  const api = await startApis(t, {
    files: [
      ...apiFiles(2),
      apiFile("src/odd.js", { patch: "@@ -1,5 +1,5 @@\n CONTENT-FROM-AUTHOR" }),
    ],
  });

  const result = await runAction(pullRequestRun(api, { RUNNER_DEBUG: "1" }));

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Found 3 changed files: 2 to review, 1 skipped\.$/m,
  );
  assert.match(
    result.stdout,
    /^Skipped src\/odd\.js: the diff could not be read\.$/m,
  );
  assert.match(
    result.stdout,
    /^::warning::Diffs that could not be read: 1\. These files are not reviewed\.$/m,
  );
  assert.match(
    result.stdout,
    /^::debug::src\/odd\.js: Hunk 1 of the diff ends before all its lines were read\.$/m,
  );
  assert.match(
    result.stdout,
    /^Parsed the diffs of 2 files: 2 added lines can receive comments\.$/m,
  );
  assert.doesNotMatch(result.output, /CONTENT-FROM-AUTHOR|::error::/);
  assert.equal(result.stderr, "");
});

test("ends green with a notice when only a lockfile changed", async (t) => {
  const api = await startGitHubApi(t, {
    files: [apiFile("package-lock.json")],
  });

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Skipped package-lock\.json: matches the default exclude pattern "package-lock\.json"\.$/m,
  );
  assert.match(
    result.stdout,
    /^::notice::ReviewOps found no files to review in this pull request\./m,
  );
  assert.doesNotMatch(result.stdout, /Parsed the diffs|::error::|::warning::/);
  assert.equal(result.stderr, "");
});

test("leaves out generated files and the patterns of the exclude input", async (t) => {
  const api = await startApis(t, {
    files: [
      apiFile("src/App/Migrations/20240101120000_AddUsers.cs"),
      apiFile("src/App/Migrations/20240101120000_AddUsers.Designer.cs"),
      apiFile("src/App/Migrations/AppDbContextModelSnapshot.cs"),
      apiFile("docs/guide.md"),
    ],
  });

  const result = await runAction(
    pullRequestRun(api, { INPUT_EXCLUDE: "# documentation\ndocs/**" }),
  );

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Found 4 changed files: 1 to review, 3 skipped\.$/m,
  );
  assert.match(
    result.stdout,
    /^Skipped src\/App\/Migrations\/20240101120000_AddUsers\.Designer\.cs: matches the default exclude pattern "\*\.Designer\.cs"\.$/m,
  );
  assert.match(
    result.stdout,
    /^Skipped src\/App\/Migrations\/AppDbContextModelSnapshot\.cs: matches the default exclude pattern "\*ModelSnapshot\.cs"\.$/m,
  );
  assert.match(
    result.stdout,
    /^Skipped docs\/guide\.md: matches the exclude pattern "docs\/\*\*"\.$/m,
  );
  assert.match(
    result.stdout,
    /^Parsed the diffs of 1 files: 1 added lines can receive comments\.$/m,
  );
  assert.equal(result.stderr, "");
});

test("fails the step before any request when an exclude pattern cannot be used", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(1) });

  const result = await runAction(
    pullRequestRun(api, { INPUT_EXCLUDE: "docs/**\n*.{png,jpg}" }),
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^::error::Input `exclude`, line 2: the pattern "\*\.\{png,jpg\}" cannot be used\. Braces and parentheses are not supported\./m,
  );
  assert.doesNotMatch(result.stdout, /ReviewOps started\./);
  assert.deepEqual(api.requests, []);
  assert.equal(result.stderr, "");
});

test("writes a file name with a line break as one harmless line", async (t) => {
  const api = await startGitHubApi(t, {
    files: [apiFile("docs/a.md\n::error::injected", { status: "removed" })],
  });

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.ok(
    result.stdout.includes("Skipped docs/a.md\\u000a::error::injected: "),
  );
  assert.doesNotMatch(result.stdout, /^::error::/m);
});

for (const [status, expected] of [
  [
    401,
    /^::error::GitHub API request failed \(HTTP 401\)\. The token was rejected/m,
  ],
  [403, /^::error::GitHub API request failed \(HTTP 403\)\./m],
  [
    404,
    /^::error::GitHub API request failed \(HTTP 404\)\. The pull request was not found/m,
  ],
]) {
  test(`fails the step with status and hint on API error ${status}`, async (t) => {
    const api = await startGitHubApi(t, { status });

    const result = await runAction(pullRequestRun(api, { RUNNER_DEBUG: "1" }));

    assert.equal(result.status, 1);
    assert.match(result.stdout, expected);
    assert.equal(result.stderr, "");
    assert.equal(withoutMaskCommands(result.output).includes(TOKEN), false);
  });
}

test("fails the step when the API cannot be reached", async () => {
  // No server is started: the default address of the tests refuses connections.
  const result = await runAction(withInputs(PULL_REQUEST_EVENT));

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::GitHub could not be reached\./m);
  assert.equal(result.stderr, "");
  assert.equal(withoutMaskCommands(result.output).includes(TOKEN), false);
});

test("fails the step with a helpful message when the API key is missing", async () => {
  const result = await runAction({
    ...PULL_REQUEST_EVENT,
    "INPUT_GITHUB-TOKEN": TOKEN,
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::Input `openai-api-key` is missing/m);
  assert.equal(result.stderr, "");
});

for (const eventName of ["push", "pull_request_target"]) {
  test(`exits with code 0 and a notice on event "${eventName}"`, async () => {
    const result = await runAction({ GITHUB_EVENT_NAME: eventName });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^::notice::.*was skipped/m);
    assert.doesNotMatch(result.stdout, /::error::/);
    assert.equal(result.stderr, "");
  });
}

for (const debug of [false, true]) {
  test(`keeps both credentials out of the log (debug: ${debug})`, async (t) => {
    const api = await startGitHubApi(t, { files: apiFiles(1) });

    const result = await runAction(
      pullRequestRun(api, debug ? { RUNNER_DEBUG: "1" } : {}),
    );

    const maskCommands = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("::add-mask::"));
    assert.deepEqual(maskCommands, [
      `::add-mask::${TOKEN}`,
      `::add-mask::${API_KEY}`,
    ]);

    const log = withoutMaskCommands(result.output);
    assert.equal(log.includes(TOKEN), false);
    assert.equal(log.includes(API_KEY), false);
  });
}

test("prints a stack trace only as a debug command", async () => {
  const result = await runAction({
    ...PULL_REQUEST_EVENT,
    "INPUT_GITHUB-TOKEN": TOKEN,
  });

  // The runner encodes line breaks as %0A, so a whole stack is one line.
  const linesWithStack = result.output
    .split(/\r?\n/)
    .filter((line) => /(%0A|^)\s+at /.test(line));

  assert.ok(linesWithStack.length > 0, "expected a stack trace in the output");
  for (const line of linesWithStack) {
    assert.ok(line.startsWith("::debug::"), `stack outside debug: ${line}`);
  }
  assert.equal(withoutMaskCommands(result.output).includes(TOKEN), false);
});

test("fails the step when the event has no pull request", async (t) => {
  const result = await runAction(
    withInputs({
      ...PULL_REQUEST_EVENT,
      GITHUB_EVENT_PATH: eventFile(t, "{}"),
    }),
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::The event carries no pull request/m);
  assert.equal(result.stderr, "");
});

test("turns a failure while loading into a failed step", async (t) => {
  // @actions/github parses the event file while it is imported.
  const result = await runAction(
    withInputs({
      ...PULL_REQUEST_EVENT,
      GITHUB_EVENT_PATH: eventFile(t, "{ this is not json"),
    }),
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::ReviewOps could not start: /m);
  assert.doesNotMatch(result.stdout, /ReviewOps started\./);
  assert.equal(result.stderr, "");
});

test("never reports an unhandled rejection", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(1) });

  for (const env of [
    PULL_REQUEST_EVENT,
    { GITHUB_EVENT_NAME: "push" },
    pullRequestRun(api),
    withInputs(PULL_REQUEST_EVENT),
    {},
  ]) {
    const result = await runAction(env);

    assert.doesNotMatch(result.output, /unhandled|UnhandledPromiseRejection/i);
    assert.notEqual(result.status, null);
  }
});

// --- Posting the review ----------------------------------------------------

const finding = (path = "src/file-0.js", line = 1) => ({
  path,
  line,
  severity: "major",
  category: "code-quality",
  title: "A problem",
  comment: "It breaks.",
  suggestion: "Fix it.",
});

test("posts exactly one review of the type COMMENT with the inline comments", async (t) => {
  const api = await startApis(
    t,
    { files: apiFiles(2) },
    reviewCompletion([finding("src/file-0.js"), finding("src/file-1.js")]),
  );

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0, result.output);
  assert.equal(api.reviews.length, 1);
  const [review] = api.reviews;
  assert.equal(review.path, "/repos/octo-org/demo/pulls/42/reviews");
  assert.equal(review.authorization, `token ${TOKEN}`);
  assert.equal(review.body.event, "COMMENT");
  assert.equal(review.body.commit_id, "1".repeat(40));
  assert.deepEqual(
    review.body.comments.map(({ path, line, side }) => ({ path, line, side })),
    [
      { path: "src/file-0.js", line: 1, side: "RIGHT" },
      { path: "src/file-1.js", line: 1, side: "RIGHT" },
    ],
  );
  for (const comment of review.body.comments) {
    assert.ok(comment.body.startsWith("<!-- reviewops -->\n"));
    assert.match(comment.body, /AI-generated by ReviewOps/);
  }
  assert.match(
    result.stdout,
    /^Posted a review with 2 inline comments and 0 findings in its text: https:\/\/github\.com\/octo-org\/demo\/pull\/42#pullrequestreview-1000$/m,
  );
});

test("posts no review when the model finds nothing", async (t) => {
  const api = await startApis(t, { files: apiFiles(1) });

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0, result.output);
  assert.deepEqual(api.reviews, []);
  assert.match(result.stdout, /^No findings, so no review was posted\.$/m);
});

test("lists the findings in the review text and ends with a warning when GitHub rejects the comments", async (t) => {
  const api = await startApis(
    t,
    {
      files: apiFiles(1),
      reviews: (request, index) =>
        index === 0
          ? { status: 422, body: { message: "Validation Failed" } }
          : { status: 200, body: { id: 9 } },
    },
    reviewCompletion([finding()]),
  );

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0, result.output);
  assert.equal(api.reviews.length, 2);
  const [first, second] = api.reviews;
  assert.equal(first.body.comments.length, 1);
  assert.equal("comments" in second.body, false);
  assert.equal(second.body.event, "COMMENT");
  assert.match(second.body.body, /GitHub did not accept the inline comments/);
  assert.match(second.body.body, /A problem/);
  assert.match(
    result.stdout,
    /^::warning::GitHub did not accept the inline comments \(HTTP 422\), so all 1 findings are listed in the text of the review: https:\/\/github\.com\/octo-org\/demo\/pull\/42#pullrequestreview-9$/m,
  );
});

test("fails the step with a hint at permissions when the token may not post a review", async (t) => {
  const api = await startApis(
    t,
    {
      files: apiFiles(1),
      reviews: () => ({
        status: 403,
        body: { message: "Resource not accessible by integration" },
      }),
    },
    reviewCompletion([finding()]),
  );

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 1);
  assert.equal(api.reviews.length, 1);
  assert.match(
    result.stdout,
    /^::error::GitHub API request failed \(HTTP 403\)\. The token may not post a review\. Give the workflow the permission `pull-requests: write` under `permissions`\.$/m,
  );
  assert.doesNotMatch(withoutMaskCommands(result.output), new RegExp(TOKEN));
});
