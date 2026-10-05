import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apiFile, apiFiles, startGitHubApi } from "./helpers/github-api.js";
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

/** Environment of a complete pull_request run against the local API server. */
const pullRequestRun = (api, env = {}) =>
  withInputs({ ...PULL_REQUEST_EVENT, GITHUB_API_URL: api.url, ...env });

/** Writes an event file with the given content and removes it after the test. */
function eventFile(t, content) {
  const directory = mkdtempSync(join(tmpdir(), "reviewops-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "event.json");
  writeFileSync(path, content);
  return path;
}

test("names the pull request and lists its files", async (t) => {
  const api = await startGitHubApi(t, {
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
    ["/repos/octo-org/demo/pulls/42/files?per_page=100"],
  );
});

test("loads a pull request with more than 100 files completely", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(120) });

  const result = await runAction(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Found 120 changed files: 120 to review, 0 skipped\.$/m,
  );
  assert.equal(api.requests.length, 2);
});

test("skips a file whose diff cannot be read without failing the step", async (t) => {
  const api = await startGitHubApi(t, {
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
