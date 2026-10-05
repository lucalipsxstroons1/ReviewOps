import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const runAction = (env) => startAction(fromRoot("src/index.js"), env);

/** Writes an event file with the given content and removes it after the test. */
function eventFile(t, content) {
  const directory = mkdtempSync(join(tmpdir(), "reviewops-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "event.json");
  writeFileSync(path, content);
  return path;
}

test("starts on a pull_request event and names the pull request", () => {
  const result = runAction(withInputs(PULL_REQUEST_EVENT));

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^ReviewOps started\.$/m);
  assert.ok(result.stdout.includes(REVIEWING_LINE));
  assert.equal(result.stderr, "");
});

test("fails the step with a helpful message when the API key is missing", () => {
  const result = runAction({
    ...PULL_REQUEST_EVENT,
    "INPUT_GITHUB-TOKEN": TOKEN,
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::Input `openai-api-key` is missing/m);
  assert.equal(result.stderr, "");
});

for (const eventName of ["push", "pull_request_target"]) {
  test(`exits with code 0 and a notice on event "${eventName}"`, () => {
    const result = runAction({ GITHUB_EVENT_NAME: eventName });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^::notice::.*was skipped/m);
    assert.doesNotMatch(result.stdout, /::error::/);
    assert.equal(result.stderr, "");
  });
}

for (const debug of [false, true]) {
  test(`keeps both credentials out of the log (debug: ${debug})`, () => {
    const result = runAction(
      withInputs({
        ...PULL_REQUEST_EVENT,
        ...(debug ? { RUNNER_DEBUG: "1" } : {}),
      }),
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

test("prints a stack trace only as a debug command", () => {
  const result = runAction({
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

test("fails the step when the event has no pull request", (t) => {
  const result = runAction(
    withInputs({
      ...PULL_REQUEST_EVENT,
      GITHUB_EVENT_PATH: eventFile(t, "{}"),
    }),
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::The event carries no pull request/m);
  assert.equal(result.stderr, "");
});

test("turns a failure while loading into a failed step", (t) => {
  // @actions/github parses the event file while it is imported.
  const result = runAction(
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

test("never reports an unhandled rejection", () => {
  for (const env of [
    PULL_REQUEST_EVENT,
    { GITHUB_EVENT_NAME: "push" },
    withInputs(PULL_REQUEST_EVENT),
    {},
  ]) {
    const result = runAction(env);

    assert.doesNotMatch(result.output, /unhandled|UnhandledPromiseRejection/i);
    assert.notEqual(result.status, null);
  }
});
