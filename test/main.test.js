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
function runWith(
  core,
  { context = createFakeContext(), octokit, parsePatch } = {},
) {
  const client = octokit ?? createFakeOctokit(apiFiles(2));
  const tokens = [];
  const getOctokit = (token) => {
    tokens.push(token);
    return client;
  };
  return run({ core, context, getOctokit, parsePatch }).then(() => ({
    tokens,
    client,
  }));
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
    "Parsed the diffs of 2 files: 2 added lines can receive comments.",
  ]);
  assert.deepEqual(core.messages("warning"), []);
});

test("counts the added lines of all files as comment targets", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("src/new.js", {
      status: "added",
      additions: 3,
      deletions: 0,
      patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c",
    }),
    apiFile("src/changed.js", {
      additions: 1,
      deletions: 2,
      patch: "@@ -4,4 +4,3 @@\n a\n-b\n-c\n+d\n e",
    }),
    apiFile("src/shorter.js", {
      additions: 0,
      deletions: 1,
      patch: "@@ -7,3 +7,2 @@\n a\n-b\n c",
    }),
  ]);

  await runWith(core, { octokit });

  assert.deepEqual(core.messages("info").slice(2), [
    "Found 3 changed files: 3 to review, 0 skipped.",
    "Parsed the diffs of 3 files: 4 added lines can receive comments.",
  ]);
});

test("skips a file whose diff cannot be read and reviews the others", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("src/good.js"),
    apiFile("src/odd.js", { patch: "@@ -1,5 +1,5 @@\n CONTENT-FROM-AUTHOR" }),
    apiFile("src/odder.js", { patch: "CONTENT-FROM-AUTHOR" }),
  ]);

  await runWith(core, { octokit });

  assert.deepEqual(core.messages("setFailed"), []);
  assert.deepEqual(core.messages("info").slice(2), [
    "Found 3 changed files: 1 to review, 2 skipped.",
    "Skipped src/odd.js: the diff could not be read.",
    "Skipped src/odder.js: the diff could not be read.",
    "Parsed the diffs of 1 files: 1 added lines can receive comments.",
  ]);
  assert.deepEqual(core.messages("warning"), [
    "Diffs that could not be read: 2. These files are not reviewed.",
  ]);
  // Where the patch is broken goes to the debug log, its content does not.
  assert.deepEqual(core.messages("debug"), [
    "src/odd.js: Hunk 1 of the diff ends before all its lines were read.",
    "src/odder.js: Row 1 of the diff is not a hunk header.",
  ]);
  assert.doesNotMatch(JSON.stringify(core.calls), /CONTENT-FROM-AUTHOR/);
});

test("names an unreadable file even when many other files are skipped", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    ...removedFiles(60),
    apiFile("src/odd.js", { patch: "not a diff" }),
  ]);

  await runWith(core, { octokit });

  const lines = core.messages("info").slice(2);
  assert.equal(lines[0], "Found 61 changed files: 0 to review, 61 skipped.");
  assert.equal(lines[1], "Skipped src/odd.js: the diff could not be read.");
  assert.equal(lines.filter((line) => line.startsWith("Skipped ")).length, 50);
  assert.equal(lines.at(-1), "11 more skipped files are not listed.");
});

test("fails the step when the parser breaks for another reason", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const parsePatch = () => {
    throw new TypeError("the parser itself is broken");
  };

  await runWith(core, { parsePatch });

  // Only a patch with a wrong format is skipped. Hiding a defect of the
  // parser behind "skipped" would silently review nothing.
  assert.deepEqual(core.messages("setFailed"), ["the parser itself is broken"]);
  assert.deepEqual(core.messages("warning"), []);
  assert.doesNotMatch(core.messages("info").join("\n"), /Skipped|Parsed/);
});

test("writes the name of an unreadable file as one harmless line", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("src/a.js\n::error::injected", { patch: "not a diff" }),
  ]);

  await runWith(core, { octokit });

  const lines = [...core.messages("info"), ...core.messages("debug")];
  assert.ok(
    lines.includes(
      "src/a.js\\u000a::error::injected: Row 1 of the diff is not a hunk header.",
    ),
  );
  for (const line of lines) {
    assert.equal(line.includes("\n"), false);
  }
});

test("writes a file name with a line break as one harmless line", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("docs/a.md\n::error::injected", { status: "removed" }),
  ]);

  await runWith(core, { octokit });

  assert.ok(
    core
      .messages("info")
      .includes(
        `Skipped docs/a.md\\u000a::error::injected: ${SKIP_REASONS.removed}.`,
      ),
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

// --- Files that are left out -------------------------------------------------

const NOTHING_TO_REVIEW =
  "ReviewOps found no files to review in this pull request. The log lists the skipped files.";

test("ends green with a notice when only a lockfile changed", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const parsed = [];
  const parsePatch = (patch) => {
    parsed.push(patch);
    return { hunks: [], commentableLines: [] };
  };

  await runWith(core, {
    octokit: createFakeOctokit([apiFile("package-lock.json")]),
    parsePatch,
  });

  assert.deepEqual(core.messages("info").slice(2), [
    "Found 1 changed files: 0 to review, 1 skipped.",
    'Skipped package-lock.json: matches the default exclude pattern "package-lock.json".',
  ]);
  assert.deepEqual(core.messages("notice"), [NOTHING_TO_REVIEW]);
  assert.deepEqual(core.messages("setFailed"), []);
  assert.deepEqual(core.messages("warning"), []);
  // The run stops at the notice. Nothing was parsed, and nothing that a
  // later step adds, such as a request to the model, can run after it.
  assert.equal(core.calls.at(-1).method, "notice");
  assert.deepEqual(parsed, []);
});

test("ends with the same notice when every file was skipped for another reason", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await runWith(core, { octokit: createFakeOctokit(removedFiles(3)) });

  assert.deepEqual(core.messages("notice"), [NOTHING_TO_REVIEW]);
  assert.deepEqual(core.messages("setFailed"), []);
  assert.doesNotMatch(core.messages("info").join("\n"), /Parsed the diffs/);
});

test("ends with the notice when the pull request has no files at all", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await runWith(core, { octokit: createFakeOctokit([]) });

  assert.deepEqual(core.messages("info").slice(2), [
    "Found 0 changed files: 0 to review, 0 skipped.",
  ]);
  assert.deepEqual(core.messages("notice"), [NOTHING_TO_REVIEW]);
});

test("reviews an EF Core migration without its generated files", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("src/App/Migrations/20240101120000_AddUsers.cs"),
    apiFile("src/App/Migrations/20240101120000_AddUsers.Designer.cs"),
    apiFile("src/App/Migrations/AppDbContextModelSnapshot.cs"),
  ]);

  await runWith(core, { octokit });

  assert.deepEqual(core.messages("info").slice(2), [
    "Found 3 changed files: 1 to review, 2 skipped.",
    'Skipped src/App/Migrations/20240101120000_AddUsers.Designer.cs: matches the default exclude pattern "*.Designer.cs".',
    'Skipped src/App/Migrations/AppDbContextModelSnapshot.cs: matches the default exclude pattern "*ModelSnapshot.cs".',
    "Parsed the diffs of 1 files: 1 added lines can receive comments.",
  ]);
  assert.deepEqual(core.messages("notice"), []);
});

test("adds the patterns of the exclude input to the default list", async () => {
  const core = createFakeCore({
    ...VALID_INPUTS,
    exclude: "# generated\ndocs/**\n\n*.txt",
  });
  const octokit = createFakeOctokit([
    apiFile("src/main.js"),
    apiFile("docs/guide/intro.md"),
    apiFile("notes/todo.txt"),
    apiFile("dist/index.js"),
    apiFile("src/docs/kept.md"),
  ]);

  await runWith(core, { octokit });

  assert.deepEqual(core.messages("info").slice(2), [
    "Found 5 changed files: 2 to review, 3 skipped.",
    'Skipped docs/guide/intro.md: matches the exclude pattern "docs/**".',
    'Skipped notes/todo.txt: matches the exclude pattern "*.txt".',
    'Skipped dist/index.js: matches the default exclude pattern "**/dist/**".',
    "Parsed the diffs of 2 files: 2 added lines can receive comments.",
  ]);
});

test("does not parse a file that is left out", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("src/main.js"),
    apiFile("dist/index.js", { patch: "not a diff" }),
  ]);

  await runWith(core, { octokit });

  assert.deepEqual(core.messages("warning"), []);
  assert.deepEqual(core.messages("info").slice(2), [
    "Found 2 changed files: 1 to review, 1 skipped.",
    'Skipped dist/index.js: matches the default exclude pattern "**/dist/**".',
    "Parsed the diffs of 1 files: 1 added lines can receive comments.",
  ]);
});

test("lists unreadable files first, then excluded ones, then the rest", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("docs/old.md", { status: "removed" }),
    apiFile("yarn.lock"),
    apiFile("src/odd.js", { patch: "not a diff" }),
    apiFile("src/main.js"),
  ]);

  await runWith(core, { octokit });

  assert.deepEqual(
    core
      .messages("info")
      .filter((line) => line.startsWith("Skipped "))
      .map((line) => line.split(":")[0]),
    ["Skipped src/odd.js", "Skipped yarn.lock", "Skipped docs/old.md"],
  );
});

test("fails before any request when an exclude pattern cannot be used", async () => {
  const core = createFakeCore({
    ...VALID_INPUTS,
    exclude: "docs/**\n!documentation/**",
  });

  const { tokens } = await runWith(core);

  // The pattern is shown as it is: it is a setting, not a credential.
  assert.deepEqual(core.messages("setFailed"), [
    'Input `exclude`, line 2: the pattern "!documentation/**" cannot be used. Negation with "!" is not supported. List only the files to leave out.',
  ]);
  assert.deepEqual(core.messages("info"), []);
  assert.deepEqual(tokens, [], "no API client may be created");
});

test("does not treat the exclude input as a credential", async () => {
  const core = createFakeCore({ ...VALID_INPUTS, exclude: "documentation/**" });

  await runWith(core, {
    octokit: createFakeOctokit([apiFile("documentation/a.md")]),
  });

  assert.deepEqual(core.messages("setSecret"), ["token-value", "key-value"]);
  assert.ok(
    core
      .messages("info")
      .includes(
        'Skipped documentation/a.md: matches the exclude pattern "documentation/**".',
      ),
  );
});

test("lists exactly 50 skipped files without a remainder line", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await runWith(core, { octokit: createFakeOctokit(removedFiles(50)) });

  const lines = core.messages("info").slice(2);
  assert.equal(lines.filter((line) => line.startsWith("Skipped ")).length, 50);
  assert.doesNotMatch(lines.join("\n"), /more skipped files/);
});

test("never logs the content of a patch", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("src/a.js", {
      patch: "@@ -1 +1 @@\n-old\n+PATCH-CONTENT-FROM-AUTHOR",
    }),
  ]);

  await runWith(core, { octokit });

  assert.deepEqual(core.messages("warning"), []);
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
