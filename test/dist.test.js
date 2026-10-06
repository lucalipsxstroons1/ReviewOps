import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// GitHub runs the bundle, not the sources. These tests start the bundle that
// is checked in; `npm run build` refreshes it.
const BUNDLE = fromRoot("dist/index.js");
const runBundle = (env) => startAction(BUNDLE, env);

/** Environment of a complete pull_request run against the local API server. */
const pullRequestRun = (api) =>
  withInputs({ ...PULL_REQUEST_EVENT, GITHUB_API_URL: api.url });

test("the build empties dist/ before it writes the bundle", () => {
  // The bundle consists of numbered files. Without this, a file from an
  // older build would stay checked in and nothing would notice.
  const { scripts } = JSON.parse(
    readFileSync(fromRoot("package.json"), "utf8"),
  );

  assert.match(scripts.build, /^node -e ".*rmSync\('dist'.*" && ncc build /);
});

test("the bundle and the files it needs are present", () => {
  for (const file of ["index.js", "package.json", "licenses.txt"]) {
    assert.ok(existsSync(fromRoot(`dist/${file}`)), `dist/${file} is missing`);
  }
});

test("the bundle names the pull request and lists its files", async (t) => {
  const api = await startGitHubApi(t, {
    files: [...apiFiles(2), apiFile("docs/old.md", { status: "removed" })],
  });

  const result = await runBundle(pullRequestRun(api));

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
});

test("the bundle ends green with a notice when only a lockfile changed", async (t) => {
  const api = await startGitHubApi(t, {
    files: [apiFile("package-lock.json")],
  });

  const result = await runBundle(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Skipped package-lock\.json: matches the default exclude pattern "package-lock\.json"\.$/m,
  );
  assert.match(result.stdout, /^::notice::ReviewOps found no files to review/m);
  assert.equal(result.stderr, "");
});

test("the bundle applies the patterns of the exclude input", async (t) => {
  const api = await startGitHubApi(t, {
    files: [...apiFiles(1), apiFile("docs/guide.md")],
  });

  const result = await runBundle({
    ...pullRequestRun(api),
    INPUT_EXCLUDE: "docs/**",
  });

  assert.equal(result.status, 0);
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

test("the bundle fails the step when an exclude pattern cannot be used", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(1) });

  const result = await runBundle({
    ...pullRequestRun(api),
    INPUT_EXCLUDE: "!docs/**",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::Input `exclude`, line 1: /m);
  assert.deepEqual(api.requests, []);
});

test("the bundle skips a file whose diff cannot be read", async (t) => {
  const api = await startGitHubApi(t, {
    files: [...apiFiles(1), apiFile("src/odd.js", { patch: "not a diff" })],
  });

  const result = await runBundle(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Skipped src\/odd\.js: the diff could not be read\.$/m,
  );
  assert.match(result.stdout, /^::warning::Diffs that could not be read: 1\./m);
  assert.match(
    result.stdout,
    /^Parsed the diffs of 1 files: 1 added lines can receive comments\.$/m,
  );
  assert.equal(result.stderr, "");
});

test("the bundle loads more than 100 files completely", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(120) });

  // The limit is raised: this test is about loading, not about the limit.
  const result = await runBundle({
    ...pullRequestRun(api),
    "INPUT_MAX-FILES": "500",
  });

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Found 120 changed files: 120 to review, 0 skipped\.$/m,
  );
});

test("the bundle leaves out the files over the limit and names them", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(120) });

  const result = await runBundle(pullRequestRun(api));

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^Found 120 changed files: 50 to review, 70 skipped\.$/m,
  );
  assert.match(
    result.stdout,
    /^Skipped src\/file-50\.js: over the limit of 50 files \(max-files\)\.$/m,
  );
  assert.match(
    result.stdout,
    /^::warning::Files left out because of the limits: 70\./m,
  );
  assert.match(result.stdout, /^Diff size: \d+ of 200000 characters\.$/m);
  assert.equal(result.stderr, "");
});

test("the bundle fails the step when a limit is not a positive number", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(1) });

  const result = await runBundle({
    ...pullRequestRun(api),
    "INPUT_MAX-FILES": "0",
  });

  assert.equal(result.status, 1);
  assert.ok(
    result.stdout.includes(
      '::error::Input `max-files` must be a whole number from 1 to 999999999, but is "0".',
    ),
  );
  assert.deepEqual(api.requests, []);
});

test("the bundle fails the step with status and hint on an API error", async (t) => {
  const api = await startGitHubApi(t, { status: 404 });

  const result = await runBundle(pullRequestRun(api));

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^::error::GitHub API request failed \(HTTP 404\)\./m,
  );
  assert.equal(result.stderr, "");
});

test("the bundle fails the step when the API key is missing", async () => {
  const result = await runBundle({
    ...PULL_REQUEST_EVENT,
    "INPUT_GITHUB-TOKEN": TOKEN,
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::Input `openai-api-key` is missing/m);
  assert.equal(result.stderr, "");
});

test("the bundle skips other events with exit code 0", async () => {
  const result = await runBundle({ GITHUB_EVENT_NAME: "push" });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^::notice::.*was skipped/m);
});

test("the bundle keeps both credentials out of the log", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(1) });

  const result = await runBundle(pullRequestRun(api));

  const log = withoutMaskCommands(result.output);
  assert.equal(log.includes(TOKEN), false);
  assert.equal(log.includes(API_KEY), false);
});

test("the bundle turns a failure while loading into a failed step", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reviewops-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const eventPath = join(directory, "event.json");
  writeFileSync(eventPath, "{ this is not json");

  const result = await runBundle(
    withInputs({ ...PULL_REQUEST_EVENT, GITHUB_EVENT_PATH: eventPath }),
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::ReviewOps could not start: /m);
  assert.equal(result.stderr, "");
});
