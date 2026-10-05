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

test("the bundle starts on a pull_request event and names the pull request", () => {
  const result = runBundle(withInputs(PULL_REQUEST_EVENT));

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^ReviewOps started\.$/m);
  assert.ok(result.stdout.includes(REVIEWING_LINE));
  assert.equal(result.stderr, "");
});

test("the bundle fails the step when the API key is missing", () => {
  const result = runBundle({
    ...PULL_REQUEST_EVENT,
    "INPUT_GITHUB-TOKEN": TOKEN,
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::Input `openai-api-key` is missing/m);
  assert.equal(result.stderr, "");
});

test("the bundle skips other events with exit code 0", () => {
  const result = runBundle({ GITHUB_EVENT_NAME: "push" });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^::notice::.*was skipped/m);
});

test("the bundle keeps both credentials out of the log", () => {
  const result = runBundle(withInputs(PULL_REQUEST_EVENT));

  const log = withoutMaskCommands(result.output);
  assert.equal(log.includes(TOKEN), false);
  assert.equal(log.includes(API_KEY), false);
});

test("the bundle turns a failure while loading into a failed step", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reviewops-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const eventPath = join(directory, "event.json");
  writeFileSync(eventPath, "{ this is not json");

  const result = runBundle(
    withInputs({ ...PULL_REQUEST_EVENT, GITHUB_EVENT_PATH: eventPath }),
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::ReviewOps could not start: /m);
  assert.equal(result.stderr, "");
});
