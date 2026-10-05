import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import {
  API_KEY,
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

test("the bundle and the files it needs are present", () => {
  for (const file of ["index.js", "package.json", "licenses.txt"]) {
    assert.ok(existsSync(fromRoot(`dist/${file}`)), `dist/${file} is missing`);
  }
});

test("the bundle starts on a pull_request event", () => {
  const result = runBundle(withInputs({ GITHUB_EVENT_NAME: "pull_request" }));

  assert.equal(result.status, 0);
  assert.match(result.stdout, /ReviewOps started\./);
  assert.equal(result.stderr, "");
});

test("the bundle fails the step when the API key is missing", () => {
  const result = runBundle({
    GITHUB_EVENT_NAME: "pull_request",
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
  const result = runBundle(withInputs({ GITHUB_EVENT_NAME: "pull_request" }));

  const log = withoutMaskCommands(result.output);
  assert.equal(log.includes(TOKEN), false);
  assert.equal(log.includes(API_KEY), false);
});
