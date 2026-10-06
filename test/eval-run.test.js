import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fromRoot } from "./helpers/run-action.js";

/**
 * Starts the evaluation as its own process with a bare environment: only
 * `PATH` and what the test adds. No key means no request can be made.
 */
function runEval(env) {
  return spawnSync(process.execPath, [fromRoot("eval/run.mjs")], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

test("ends with a notice and no failure in a pull request without secrets", () => {
  const result = runEval({ GITHUB_EVENT_NAME: "pull_request" });

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /^::notice::The evaluation was skipped: OPENAI_API_KEY is not set/m,
  );
  assert.equal(result.stderr, "");
});

for (const env of [
  { GITHUB_EVENT_NAME: "workflow_dispatch" },
  { GITHUB_EVENT_NAME: "push" },
  {},
]) {
  test(`fails without a key when the event is ${env.GITHUB_EVENT_NAME ?? "not set"}`, () => {
    const result = runEval(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /^::error::OPENAI_API_KEY is not set\./m);
    assert.match(result.stdout, /repository secret OPENAI_API_KEY/);
  });
}

test("treats an empty key like a missing one", () => {
  const result = runEval({
    OPENAI_API_KEY: "",
    GITHUB_EVENT_NAME: "workflow_dispatch",
  });

  assert.equal(result.status, 1);
});

test("refuses a model name that cannot be one before any request and keeps the key out of the output", () => {
  const key = "TESTKEY-not-a-real-key-654321";
  const result = runEval({
    OPENAI_API_KEY: key,
    EVAL_MODEL: "../secrets",
    GITHUB_EVENT_NAME: "workflow_dispatch",
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^::error::Input `openai-model` must be the name of an OpenAI model/m,
  );
  assert.equal(result.stderr, "");
  // The only place for the key is the command that makes the runner mask it.
  for (const line of result.stdout.split("\n")) {
    if (line.includes(key)) assert.ok(line.startsWith("::add-mask::"), line);
  }
});

test("refuses a language that is not one of the codes before any request and keeps the key out of the output", () => {
  const key = "TESTKEY-not-a-real-key-987654";
  const result = runEval({
    OPENAI_API_KEY: key,
    EVAL_LANGUAGE: "klingon",
    GITHUB_EVENT_NAME: "workflow_dispatch",
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^::error::Input `language` must be one of en, de,.*but is "klingon"\./m,
  );
  assert.equal(result.stderr, "");
  for (const line of result.stdout.split("\n")) {
    if (line.includes(key)) assert.ok(line.startsWith("::add-mask::"), line);
  }
});
