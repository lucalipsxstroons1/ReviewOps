import assert from "node:assert/strict";
import { test } from "node:test";
import { SKIP_REASONS } from "../src/github/files.js";
import { run } from "../src/main.js";
import { createFakeContext, loadEvent } from "./helpers/fake-context.js";
import { createFakeCore } from "./helpers/fake-core.js";
import { apiFile, apiFiles, createFakeOctokit } from "./helpers/github-api.js";
import { REVIEWING_LINE } from "./helpers/run-action.js";

const VALID_INPUTS = {
  "github-token": "token-value",
  "openai-api-key": "key-value",
};

/**
 * Runs the action with stand-ins for everything outside of it. Without an
 * explicit client, the API answers with two ordinary files.
 */
function runWith(core, { context = createFakeContext(), octokit } = {}) {
  const client = octokit ?? createFakeOctokit(apiFiles(2));
  const tokens = [];
  const getOctokit = (token) => {
    tokens.push(token);
    return client;
  };
  return run({ core, context, getOctokit }).then(() => ({ tokens, client }));
}

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

  await runWith(core);

  assert.deepEqual(core.messages("info").slice(0, 2), [
    "ReviewOps started.",
    REVIEWING_LINE,
  ]);
  assert.deepEqual(core.messages("setFailed"), []);
});

test("masks the credentials before it logs anything", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await runWith(core);

  assert.deepEqual(
    core.calls.slice(0, 2).map((call) => call.method),
    ["setSecret", "setSecret"],
  );
});

test("keeps the title of the pull request out of the log", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const payload = loadEvent();
  payload.pull_request.title = "TITLE-WRITTEN-BY-THE-AUTHOR";

  await runWith(core, { context: createFakeContext({ payload }) });

  assert.doesNotMatch(
    JSON.stringify(core.calls),
    /TITLE-WRITTEN-BY-THE-AUTHOR/,
  );
});

test("creates the API client with the token from the inputs", async () => {
  const core = createFakeCore(VALID_INPUTS);

  const { tokens, client } = await runWith(core);

  assert.deepEqual(tokens, ["token-value"]);
  assert.deepEqual(client.calls[0].parameters, {
    owner: "octo-org",
    repo: "demo",
    pull_number: 42,
    per_page: 100,
  });
});

test("logs how many files it found and why it skipped some", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    ...apiFiles(2),
    apiFile("docs/old.md", { status: "removed" }),
    apiFile("assets/logo.png", {
      status: "added",
      additions: 0,
      deletions: 0,
      patch: undefined,
    }),
  ]);

  await runWith(core, { octokit });

  assert.deepEqual(core.messages("info").slice(2), [
    "Found 4 changed files: 2 to review, 2 skipped.",
    `Skipped docs/old.md: ${SKIP_REASONS.removed}.`,
    `Skipped assets/logo.png: ${SKIP_REASONS.noPatch}.`,
  ]);
  assert.deepEqual(core.messages("warning"), []);
});

test("writes a file name with a line break as one harmless line", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("docs/a.md\n::error::injected", { status: "removed" }),
  ]);

  await runWith(core, { octokit });

  const line = core.messages("info").at(-1);
  assert.equal(
    line,
    `Skipped docs/a.md\\u000a::error::injected: ${SKIP_REASONS.removed}.`,
  );
  for (const message of core.messages("info")) {
    assert.equal(message.includes("\n"), false);
  }
});

const removedFiles = (count) =>
  Array.from({ length: count }, (_, index) =>
    apiFile(`old/file-${index}.js`, { status: "removed" }),
  );

test("lists at most 50 skipped files and counts the rest", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await runWith(core, { octokit: createFakeOctokit(removedFiles(60)) });

  const lines = core.messages("info").slice(2);
  assert.equal(lines[0], "Found 60 changed files: 0 to review, 60 skipped.");
  assert.equal(lines.filter((line) => line.startsWith("Skipped ")).length, 50);
  assert.equal(lines.at(-1), "10 more skipped files are not listed.");
});

test("lists exactly 50 skipped files without a remainder line", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await runWith(core, { octokit: createFakeOctokit(removedFiles(50)) });

  const lines = core.messages("info").slice(2);
  assert.equal(lines.filter((line) => line.startsWith("Skipped ")).length, 50);
  assert.equal(lines.length, 51);
});

test("never logs the content of a patch", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("src/a.js", { patch: "@@ -1 +1 @@\n+PATCH-CONTENT-FROM-AUTHOR" }),
  ]);

  await runWith(core, { octokit });

  assert.doesNotMatch(JSON.stringify(core.calls), /PATCH-CONTENT-FROM-AUTHOR/);
});

test("warns when GitHub's limit of 3000 files was reached", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await runWith(core, { octokit: createFakeOctokit(apiFiles(3000)) });

  assert.equal(core.messages("warning").length, 1);
  assert.match(core.messages("warning")[0], /at most 3000 files/);
});

test("fails with status and hint when the API rejects the request", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit();
  octokit.paginate = async () => {
    throw Object.assign(new Error("Not Found with token-value inside"), {
      status: 404,
      response: { headers: {} },
    });
  };

  await runWith(core, { octokit });

  assert.equal(core.messages("setFailed").length, 1);
  assert.match(core.messages("setFailed")[0], /HTTP 404.*not found/);
  // The answer from GitHub goes to the debug log, with credentials redacted.
  assert.ok(
    core.messages("debug").includes("Caused by: Not Found with *** inside"),
  );
});

for (const eventName of ["push", "pull_request_target", undefined]) {
  test(`skips the run on event "${eventName}" without failing`, async () => {
    const core = createFakeCore();

    const { tokens } = await runWith(core, {
      context: createFakeContext({ eventName }),
    });

    assert.equal(core.messages("notice").length, 1);
    assert.match(core.messages("notice")[0], /was skipped/);
    assert.deepEqual(core.messages("setFailed"), []);
    assert.deepEqual(core.messages("info"), []);
    assert.deepEqual(tokens, [], "no API client may be created");
  });
}

test("fails with a helpful message when the API key is missing", async () => {
  const core = createFakeCore({ "github-token": "token-value" });

  const { tokens } = await runWith(core);

  assert.equal(core.messages("setFailed").length, 1);
  assert.match(core.messages("setFailed")[0], /`openai-api-key` is missing/);
  assert.deepEqual(core.messages("info"), []);
  assert.deepEqual(tokens, []);
});

test("fails when the token was passed as an empty value", async () => {
  const core = createFakeCore({ "openai-api-key": "key-value" });

  await runWith(core);

  assert.match(core.messages("setFailed")[0], /`github-token` is empty/);
});

test("fails with a clear message when the event has no pull request", async () => {
  const core = createFakeCore(VALID_INPUTS);

  const { tokens } = await runWith(core, {
    context: createFakeContext({ payload: {} }),
  });

  assert.equal(core.messages("setFailed").length, 1);
  assert.match(core.messages("setFailed")[0], /carries no pull request/);
  assert.deepEqual(tokens, []);
});

test("turns an unexpected error into a failed step instead of throwing", async () => {
  const core = createFailingCore(new Error("something broke"));

  await assert.doesNotReject(runWith(core));

  assert.deepEqual(core.messages("setFailed"), ["something broke"]);
});

test("redacts credentials in the failure message and in the stack trace", async () => {
  const core = createFailingCore(
    new Error("request with token-value and key-value was rejected"),
  );

  await runWith(core);

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

  await runWith(core);

  assert.equal(core.messages("debug").length, 1);
  assert.match(core.messages("debug")[0], /something broke\n\s+at /);
  assert.doesNotMatch(core.messages("setFailed")[0], /\n\s+at /);
});

test("still fails the step when the debug log itself breaks", async () => {
  const core = createFailingCore(new Error("something broke"));
  core.debug = () => {
    throw new Error("debug log is broken");
  };

  await assert.doesNotReject(runWith(core));

  assert.deepEqual(core.messages("setFailed"), ["something broke"]);
});

test("names the error type when an error has no message", async () => {
  const core = createFailingCore(new TypeError(""));

  await runWith(core);

  assert.deepEqual(core.messages("setFailed"), ["TypeError"]);
});

test("reports a thrown string as it is", async () => {
  const core = createFailingCore("plain failure");

  await runWith(core);

  assert.deepEqual(core.messages("setFailed"), ["plain failure"]);
  assert.deepEqual(core.messages("debug"), []);
});

for (const thrown of [{ code: 500, token: "token-value" }, undefined, "  "]) {
  test(`reports a fixed message when ${JSON.stringify(thrown)} is thrown`, async () => {
    const core = createFailingCore(thrown);

    await runWith(core);

    assert.deepEqual(core.messages("setFailed"), [
      "ReviewOps failed without an error message.",
    ]);
  });
}
