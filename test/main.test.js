import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/main.js";
import { createFakeContext, loadEvent } from "./helpers/fake-context.js";
import { createFakeCore } from "./helpers/fake-core.js";
import { REVIEWING_LINE } from "./helpers/run-action.js";

const VALID_INPUTS = {
  "github-token": "token-value",
  "openai-api-key": "key-value",
};

/** A core whose first log call fails, to simulate an unexpected error. */
function createFailingCore(thrown, inputs = VALID_INPUTS) {
  const core = createFakeCore(inputs);
  core.info = () => {
    throw thrown;
  };
  return core;
}

test("starts on a pull_request event and names the pull request", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await run({ core, context: createFakeContext() });

  assert.deepEqual(core.messages("info"), [
    "ReviewOps started.",
    REVIEWING_LINE,
  ]);
  assert.deepEqual(core.messages("setFailed"), []);
});

test("masks the credentials before it logs anything", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await run({ core, context: createFakeContext() });

  assert.deepEqual(
    core.calls.slice(0, 2).map((call) => call.method),
    ["setSecret", "setSecret"],
  );
});

test("keeps the title of the pull request out of the log", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const payload = loadEvent();
  payload.pull_request.title = "TITLE-WRITTEN-BY-THE-AUTHOR";

  await run({ core, context: createFakeContext({ payload }) });

  assert.doesNotMatch(
    JSON.stringify(core.calls),
    /TITLE-WRITTEN-BY-THE-AUTHOR/,
  );
});

for (const eventName of ["push", "pull_request_target", undefined]) {
  test(`skips the run on event "${eventName}" without failing`, async () => {
    const core = createFakeCore();

    await run({ core, context: createFakeContext({ eventName }) });

    assert.equal(core.messages("notice").length, 1);
    assert.match(core.messages("notice")[0], /was skipped/);
    assert.deepEqual(core.messages("setFailed"), []);
    assert.deepEqual(core.messages("info"), []);
  });
}

test("fails with a helpful message when the API key is missing", async () => {
  const core = createFakeCore({ "github-token": "token-value" });

  await run({ core, context: createFakeContext() });

  assert.equal(core.messages("setFailed").length, 1);
  assert.match(core.messages("setFailed")[0], /`openai-api-key` is missing/);
  assert.deepEqual(core.messages("info"), []);
});

test("fails when the token was passed as an empty value", async () => {
  const core = createFakeCore({ "openai-api-key": "key-value" });

  await run({ core, context: createFakeContext() });

  assert.match(core.messages("setFailed")[0], /`github-token` is empty/);
});

test("fails with a clear message when the event has no pull request", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await run({ core, context: createFakeContext({ payload: {} }) });

  assert.equal(core.messages("setFailed").length, 1);
  assert.match(core.messages("setFailed")[0], /carries no pull request/);
});

test("turns an unexpected error into a failed step instead of throwing", async () => {
  const core = createFailingCore(new Error("something broke"));

  await assert.doesNotReject(run({ core, context: createFakeContext() }));

  assert.deepEqual(core.messages("setFailed"), ["something broke"]);
});

test("redacts credentials in the failure message and in the stack trace", async () => {
  const core = createFailingCore(
    new Error("request with token-value and key-value was rejected"),
  );

  await run({ core, context: createFakeContext() });

  assert.deepEqual(core.messages("setFailed"), [
    "request with *** and *** was rejected",
  ]);
  const everything = JSON.stringify(
    core.calls.filter((call) => call.method !== "setSecret"),
  );
  assert.doesNotMatch(everything, /token-value|key-value/);
});

test("sends the stack trace to the debug log only", async () => {
  const core = createFailingCore(new Error("something broke"));

  await run({ core, context: createFakeContext() });

  assert.equal(core.messages("debug").length, 1);
  assert.match(core.messages("debug")[0], /something broke\n\s+at /);
  assert.doesNotMatch(core.messages("setFailed")[0], /\n\s+at /);
});

test("still fails the step when the debug log itself breaks", async () => {
  const core = createFailingCore(new Error("something broke"));
  core.debug = () => {
    throw new Error("debug log is broken");
  };

  await assert.doesNotReject(run({ core, context: createFakeContext() }));

  assert.deepEqual(core.messages("setFailed"), ["something broke"]);
});

test("names the error type when an error has no message", async () => {
  const core = createFailingCore(new TypeError(""));

  await run({ core, context: createFakeContext() });

  assert.deepEqual(core.messages("setFailed"), ["TypeError"]);
});

test("reports a thrown string as it is", async () => {
  const core = createFailingCore("plain failure");

  await run({ core, context: createFakeContext() });

  assert.deepEqual(core.messages("setFailed"), ["plain failure"]);
  assert.deepEqual(core.messages("debug"), []);
});

for (const thrown of [{ code: 500, token: "token-value" }, undefined, "  "]) {
  test(`reports a fixed message when ${JSON.stringify(thrown)} is thrown`, async () => {
    const core = createFailingCore(thrown);

    await run({ core, context: createFakeContext() });

    assert.deepEqual(core.messages("setFailed"), [
      "ReviewOps failed without an error message.",
    ]);
  });
}
