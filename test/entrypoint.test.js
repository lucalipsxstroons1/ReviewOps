import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY_POINT = fileURLToPath(new URL("../src/index.js", import.meta.url));

// Recognisable stand-ins. They must not look like real credentials.
const TOKEN = "TESTTOKEN-not-a-real-token-123456";
const API_KEY = "TESTKEY-not-a-real-key-654321";

/**
 * Starts the action the way the runner does: as its own process, configured
 * only through environment variables.
 */
function runAction(env) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(GITHUB_|INPUT_|RUNNER_)/.test(name),
    ),
  );
  const result = spawnSync(process.execPath, [ENTRY_POINT], {
    env: { ...inherited, ...env },
    encoding: "utf8",
  });
  return { ...result, output: result.stdout + result.stderr };
}

const withInputs = (env) => ({
  "INPUT_GITHUB-TOKEN": TOKEN,
  "INPUT_OPENAI-API-KEY": API_KEY,
  ...env,
});

/** Output as it reaches the log: mask commands are consumed by the runner. */
const withoutMaskCommands = (output) =>
  output
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");

test("starts and exits with code 0 on a pull_request event", () => {
  const result = runAction(withInputs({ GITHUB_EVENT_NAME: "pull_request" }));

  assert.equal(result.status, 0);
  assert.match(result.stdout, /ReviewOps started\./);
  assert.equal(result.stderr, "");
});

test("fails the step with a helpful message when the API key is missing", () => {
  const result = runAction({
    GITHUB_EVENT_NAME: "pull_request",
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
        GITHUB_EVENT_NAME: "pull_request",
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
    GITHUB_EVENT_NAME: "pull_request",
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

test("does not crash while loading when the event file is corrupt", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reviewops-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const eventPath = join(directory, "event.json");
  writeFileSync(eventPath, "{ this is not json");

  const result = runAction(
    withInputs({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
    }),
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /ReviewOps started\./);
  assert.equal(result.stderr, "");
});

test("never reports an unhandled rejection", () => {
  for (const env of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "push" },
    withInputs({ GITHUB_EVENT_NAME: "pull_request" }),
    {},
  ]) {
    const result = runAction(env);

    assert.doesNotMatch(result.output, /unhandled|UnhandledPromiseRejection/i);
    assert.notEqual(result.status, null);
  }
});
