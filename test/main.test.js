import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REQUEST_CHARS } from "../src/ai/batch.js";
import { AiError } from "../src/ai/error.js";
import { buildSystemPrompt } from "../src/ai/prompt.js";
import { SENSITIVE_REASON } from "../src/exclude.js";
import { MAX_OUTPUT_TOKENS, REVIEW_FORMAT } from "../src/ai/schema.js";
import {
  UNUSABLE_PATH_REASON,
  buildUserPrompt,
} from "../src/ai/user-prompt.js";
import { annotateDiff } from "../src/diff/annotate.js";
import { parsePatch } from "../src/diff/parse.js";
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

/** The result of `complete()` for an answer with these findings. */
const modelAnswer = (findings = [], summary = "Nothing stands out.") => ({
  content: JSON.stringify({ summary, findings }),
  finishReason: "stop",
  usage: null,
  model: "gpt-4o-mini",
  requestId: null,
});

/**
 * A stand-in for `createAiClient()`. `respond(request, index)` returns the
 * result of a request or an error to throw; without it, the model finds
 * nothing.
 */
function createFakeAi(respond = () => modelAnswer()) {
  const ai = { options: [], requests: [] };
  ai.createAiClient = (options) => {
    ai.options.push(options);
    return {
      async complete(request) {
        const index = ai.requests.length;
        ai.requests.push(request);
        const result = respond(request, index);
        if (result instanceof Error) throw result;
        return result;
      },
    };
  };
  return ai;
}

/**
 * Runs the action with stand-ins for everything outside of it. Without an
 * explicit client, the API answers with two ordinary files and the model
 * finds nothing.
 */
function runWith(
  core,
  {
    context = createFakeContext(),
    octokit,
    parsePatch,
    ai = createFakeAi(),
  } = {},
) {
  const client = octokit ?? createFakeOctokit(apiFiles(2));
  const tokens = [];
  const getOctokit = (token) => {
    tokens.push(token);
    return client;
  };
  return run({
    core,
    context,
    getOctokit,
    parsePatch,
    createAiClient: ai.createAiClient,
  }).then(() => ({
    tokens,
    client,
    ai,
  }));
}

// The patch of an ordinary file from `apiFile()`.
const DEFAULT_PATCH = apiFile("x").patch;

/** A patch that adds `lines` lines to a new file. */
const addedPatch = (lines) =>
  [`@@ -0,0 +1,${lines} @@`, ...Array(lines).fill("+x")].join("\n");

/**
 * The progress lines after "ReviewOps started." and "Reviewing …", up to the
 * request to the model: everything about choosing the files.
 */
function selectionLines(core) {
  const lines = core.messages("info").slice(2);
  const sending = lines.findIndex((line) => line.startsWith("Sending "));
  return sending === -1 ? lines : lines.slice(0, sending);
}

/** The log line about the size of the selected diffs, worked out from the patches. */
function diffSizeLine(patches, maxDiffChars = 200000) {
  const used = patches
    .map((patch) => annotateDiff(parsePatch(patch).hunks).length)
    .reduce((sum, size) => sum + size, 0);
  return `Diff size: ${used} of ${maxDiffChars} characters.`;
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

  assert.deepEqual(selectionLines(core), [
    "Found 4 changed files: 2 to review, 2 skipped.",
    `Skipped docs/old.md: ${SKIP_REASONS.removed}.`,
    `Skipped assets/logo.png: ${SKIP_REASONS.noPatch}.`,
    "Parsed the diffs of 2 files: 2 added lines can receive comments.",
    diffSizeLine([DEFAULT_PATCH, DEFAULT_PATCH]),
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

  assert.deepEqual(selectionLines(core), [
    "Found 3 changed files: 3 to review, 0 skipped.",
    "Parsed the diffs of 3 files: 4 added lines can receive comments.",
    diffSizeLine([
      "@@ -0,0 +1,3 @@\n+a\n+b\n+c",
      "@@ -4,4 +4,3 @@\n a\n-b\n-c\n+d\n e",
      "@@ -7,3 +7,2 @@\n a\n-b\n c",
    ]),
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
  assert.deepEqual(selectionLines(core), [
    "Found 3 changed files: 1 to review, 2 skipped.",
    "Skipped src/odd.js: the diff could not be read.",
    "Skipped src/odder.js: the diff could not be read.",
    "Parsed the diffs of 1 files: 1 added lines can receive comments.",
    diffSizeLine([DEFAULT_PATCH]),
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

  const lines = selectionLines(core);
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

test("leaves out a file whose name cannot be put into the prompt, as one harmless line", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("src/a.js\n::error::injected", { patch: "not a diff" }),
  ]);
  let parsed = 0;

  await runWith(core, {
    octokit,
    parsePatch: (patch) => {
      parsed += 1;
      return parsePatch(patch);
    },
  });

  // The name is checked before the patch is parsed.
  assert.equal(parsed, 0);
  assert.deepEqual(core.messages("warning"), [
    'Files whose name cannot be put into the prompt: 1. They are not reviewed. A name with a double quote, "<", ">" or a control character cannot be sent.',
  ]);
  const lines = [...core.messages("info"), ...core.messages("debug")];
  assert.ok(
    lines.includes(
      `Skipped src/a.js\\u000a::error::injected: ${UNUSABLE_PATH_REASON}.`,
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

  const lines = selectionLines(core);
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

  assert.deepEqual(selectionLines(core), [
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

  assert.deepEqual(selectionLines(core), [
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

  assert.deepEqual(selectionLines(core), [
    "Found 3 changed files: 1 to review, 2 skipped.",
    'Skipped src/App/Migrations/20240101120000_AddUsers.Designer.cs: matches the default exclude pattern "*.Designer.cs".',
    'Skipped src/App/Migrations/AppDbContextModelSnapshot.cs: matches the default exclude pattern "*ModelSnapshot.cs".',
    "Parsed the diffs of 1 files: 1 added lines can receive comments.",
    diffSizeLine([DEFAULT_PATCH]),
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

  assert.deepEqual(selectionLines(core), [
    "Found 5 changed files: 2 to review, 3 skipped.",
    'Skipped docs/guide/intro.md: matches the exclude pattern "docs/**".',
    'Skipped notes/todo.txt: matches the exclude pattern "*.txt".',
    'Skipped dist/index.js: matches the default exclude pattern "**/dist/**".',
    "Parsed the diffs of 2 files: 2 added lines can receive comments.",
    diffSizeLine([DEFAULT_PATCH, DEFAULT_PATCH]),
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
  assert.deepEqual(selectionLines(core), [
    "Found 2 changed files: 1 to review, 1 skipped.",
    'Skipped dist/index.js: matches the default exclude pattern "**/dist/**".',
    "Parsed the diffs of 1 files: 1 added lines can receive comments.",
    diffSizeLine([DEFAULT_PATCH]),
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

  const lines = selectionLines(core);
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
  // The limits are raised, so that only the limit of GitHub applies.
  const core = createFakeCore({ ...VALID_INPUTS, "max-files": "5000" });

  await runWith(core, { octokit: createFakeOctokit(apiFiles(3000)) });

  assert.equal(core.messages("warning").length, 1);
  assert.match(core.messages("warning")[0], /at most 3000 files/);
});

// --- Limits for large pull requests ------------------------------------------

const FILE_LIMIT_REASON = "over the limit of 50 files (max-files)";

test("reviews the first 50 files and names the others", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await runWith(core, { octokit: createFakeOctokit(apiFiles(60)) });

  const lines = selectionLines(core);
  assert.equal(lines[0], "Found 60 changed files: 50 to review, 10 skipped.");
  assert.deepEqual(
    lines.filter((line) => line.startsWith("Skipped ")),
    Array.from(
      { length: 10 },
      (_, index) => `Skipped src/file-${index + 50}.js: ${FILE_LIMIT_REASON}.`,
    ),
  );
  assert.ok(
    lines.includes(
      "Parsed the diffs of 50 files: 50 added lines can receive comments.",
    ),
  );
  assert.deepEqual(core.messages("warning"), [
    "Files left out because of the limits: 10. They are not reviewed. The limits are max-files: 50 and max-diff-chars: 200000.",
  ]);
  assert.deepEqual(core.messages("setFailed"), []);
});

test("takes exactly 50 files without a warning", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await runWith(core, { octokit: createFakeOctokit(apiFiles(50)) });

  assert.ok(
    core
      .messages("info")
      .includes("Found 50 changed files: 50 to review, 0 skipped."),
  );
  assert.deepEqual(core.messages("warning"), []);
});

test("uses the limits from the inputs", async () => {
  const core = createFakeCore({ ...VALID_INPUTS, "max-files": "2" });

  await runWith(core, { octokit: createFakeOctokit(apiFiles(4)) });

  const lines = selectionLines(core);
  assert.equal(lines[0], "Found 4 changed files: 2 to review, 2 skipped.");
  assert.equal(
    lines[1],
    "Skipped src/file-2.js: over the limit of 2 files (max-files).",
  );
  assert.deepEqual(core.messages("warning"), [
    "Files left out because of the limits: 2. They are not reviewed. The limits are max-files: 2 and max-diff-chars: 200000.",
  ]);
});

test("leaves out a file that does not fit the budget and takes later ones", async () => {
  const small = (path) => apiFile(path, { patch: addedPatch(1) });
  const octokit = createFakeOctokit([
    small("a.js"),
    apiFile("big.js", { status: "added", patch: addedPatch(500) }),
    small("c.js"),
    small("d.js"),
  ]);
  const budget = annotateDiff(parsePatch(addedPatch(1)).hunks).length * 3;
  const core = createFakeCore({
    ...VALID_INPUTS,
    "max-diff-chars": String(budget),
  });

  await runWith(core, { octokit });

  const lines = selectionLines(core);
  assert.equal(lines[0], "Found 4 changed files: 3 to review, 1 skipped.");
  assert.equal(
    lines[1],
    `Skipped big.js: does not fit into the budget of ${budget} characters (max-diff-chars).`,
  );
  assert.equal(lines.at(-1), `Diff size: ${budget} of ${budget} characters.`);
});

test("lists files left out by a limit before excluded and other skipped ones", async () => {
  const core = createFakeCore({ ...VALID_INPUTS, "max-files": "1" });
  const octokit = createFakeOctokit([
    apiFile("docs/old.md", { status: "removed" }),
    apiFile("yarn.lock"),
    apiFile("src/a.js"),
    apiFile("src/b.js"),
    apiFile("src/odd.js", { patch: "not a diff" }),
  ]);

  await runWith(core, { octokit });

  assert.deepEqual(
    core
      .messages("info")
      .filter((line) => line.startsWith("Skipped "))
      .map((line) => line.split(":")[0]),
    [
      "Skipped src/odd.js",
      "Skipped src/b.js",
      "Skipped yarn.lock",
      "Skipped docs/old.md",
    ],
  );
});

test("ends green with a notice when no file fits the budget", async () => {
  const core = createFakeCore({ ...VALID_INPUTS, "max-diff-chars": "10" });

  await runWith(core, { octokit: createFakeOctokit(apiFiles(2)) });

  assert.deepEqual(core.messages("setFailed"), []);
  assert.deepEqual(core.messages("notice"), [NOTHING_TO_REVIEW]);
  assert.equal(core.messages("warning").length, 1);
  assert.match(
    core.messages("warning")[0],
    /^Files left out because of the limits: 2\./,
  );
  assert.doesNotMatch(
    core.messages("info").join("\n"),
    /Parsed the diffs|Diff size/,
  );
  // The run stops at the notice, before anything that costs money.
  assert.equal(core.calls.at(-1).method, "notice");
});

test("does not fail on a very large pull request", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    ...apiFiles(2999),
    apiFile("src/huge.js", { status: "added", patch: addedPatch(300000) }),
  ]);

  const started = performance.now();
  await runWith(core, { octokit });
  const elapsed = performance.now() - started;

  assert.deepEqual(core.messages("setFailed"), []);
  assert.equal(core.messages("warning").length, 2);
  assert.ok(
    core
      .messages("info")
      .includes("Found 3000 changed files: 50 to review, 2950 skipped."),
  );
  assert.equal(
    core.messages("info").filter((line) => line.startsWith("Skipped ")).length,
    50,
  );
  assert.ok(elapsed < 5000, `the run took ${Math.round(elapsed)} ms`);
});

test("never logs the diff that is selected for the model", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("src/a.js", { patch: "@@ -1 +1 @@\n-old\n+SELECTED-CONTENT" }),
  ]);

  await runWith(core, { octokit });

  assert.doesNotMatch(JSON.stringify(core.calls), /SELECTED-CONTENT/);
});

const INVALID_LIMITS = [
  ["max-files", "0"],
  ["max-files", "-3"],
  ["max-files", "ten"],
  ["max-files", "2.5"],
  ["max-diff-chars", "0"],
  ["max-diff-chars", "-1"],
  ["max-diff-chars", "lots"],
  ["max-diff-chars", "1e6"],
];

for (const [input, value] of INVALID_LIMITS) {
  test(`fails before any request when ${input} is "${value}"`, async () => {
    const core = createFakeCore({ ...VALID_INPUTS, [input]: value });

    const { tokens } = await runWith(core);

    assert.deepEqual(core.messages("setFailed"), [
      `Input \`${input}\` must be a whole number from 1 to 999999999, but is "${value}".`,
    ]);
    assert.deepEqual(core.messages("info"), []);
    assert.deepEqual(tokens, [], "no API client may be created");
  });
}

test("fails before any request when the API key has a character that is not allowed", async () => {
  const core = createFakeCore({
    ...VALID_INPUTS,
    "openai-api-key": "sk-abcdef ghijkl",
  });

  const { tokens } = await runWith(core);

  assert.equal(core.messages("setFailed").length, 1);
  assert.match(
    core.messages("setFailed")[0],
    /^Input `openai-api-key` contains a character that is not allowed/,
  );
  assert.equal(core.messages("setFailed")[0].includes("abcdef"), false);
  assert.deepEqual(core.messages("info"), []);
  assert.deepEqual(tokens, [], "no API client may be created");
});

const INVALID_MODELS = ["gpt 4", "../secrets", "gpt`4`", "a".repeat(101)];

for (const value of INVALID_MODELS) {
  test(`fails before any request when openai-model is "${value.slice(0, 20)}"`, async () => {
    const core = createFakeCore({ ...VALID_INPUTS, "openai-model": value });

    const { tokens } = await runWith(core);

    assert.equal(core.messages("setFailed").length, 1);
    assert.match(
      core.messages("setFailed")[0],
      /^Input `openai-model` must be the name of an OpenAI model/,
    );
    assert.deepEqual(core.messages("info"), []);
    assert.deepEqual(tokens, [], "no API client may be created");
  });
}

const INVALID_LANGUAGES = ["xx", "german", "de-DE", "__proto__"];

for (const value of INVALID_LANGUAGES) {
  test(`fails before any request when language is "${value}"`, async () => {
    const core = createFakeCore({ ...VALID_INPUTS, language: value });

    const { tokens } = await runWith(core);

    assert.equal(core.messages("setFailed").length, 1);
    assert.match(
      core.messages("setFailed")[0],
      /^Input `language` must be one of en, de, fr, es, it, pt, nl, pl, tr, ja, zh, ko, but is /,
    );
    assert.deepEqual(core.messages("info"), []);
    assert.deepEqual(tokens, [], "no API client may be created");
  });
}

test("accepts every language code and the default without a message", async () => {
  for (const language of ["en", "DE", " fr ", "ko", ""]) {
    const core = createFakeCore({ ...VALID_INPUTS, language });

    await runWith(core);

    assert.deepEqual(core.messages("setFailed"), [], language);
  }
});

test("accepts a valid model name and the default without a message", async () => {
  for (const model of ["gpt-4.1", "", "ft:gpt-4o-mini:org::id"]) {
    const core = createFakeCore({ ...VALID_INPUTS, "openai-model": model });

    await runWith(core);

    assert.deepEqual(core.messages("setFailed"), [], model);
  }
});

// --- Files that may hold secrets ----------------------------------------------

const SENSITIVE_WARNING =
  "Files that may hold secrets: 2. They are never sent to the model and are not reviewed. Check that no real secret is part of this pull request.";

test("never sends a file that may hold secrets, also with an empty exclude input", async () => {
  const core = createFakeCore({ ...VALID_INPUTS, exclude: "" });
  const octokit = createFakeOctokit([
    apiFile(".env", { patch: "@@ -0,0 +1 @@\n+VALUE-FROM-ENV-FILE" }),
    apiFile("certs/server.pem", { patch: "@@ -0,0 +1 @@\n+VALUE-FROM-PEM" }),
    apiFile("src/app.js"),
  ]);

  const { ai } = await runWith(core, { octokit });

  assert.deepEqual(ai.requests.map(pathsIn), [["src/app.js"]]);
  const sent = JSON.stringify(ai.requests);
  assert.doesNotMatch(sent, /VALUE-FROM|\.env|server\.pem/);
  assert.ok(
    selectionLines(core).includes(`Skipped .env: ${SENSITIVE_REASON}.`),
  );
  assert.ok(
    selectionLines(core).includes(
      `Skipped certs/server.pem: ${SENSITIVE_REASON}.`,
    ),
  );
  assert.deepEqual(core.messages("warning"), [SENSITIVE_WARNING]);
});

test("leaves out a file that was renamed from a sensitive name", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("config/settings.txt", {
      status: "renamed",
      previous_filename: ".env",
    }),
    apiFile("config/other.txt", {
      status: "renamed",
      previous_filename: "id_rsa",
    }),
    apiFile("src/app.js", {
      status: "renamed",
      previous_filename: "src/old.js",
    }),
  ]);

  const { ai } = await runWith(core, { octokit });

  assert.deepEqual(ai.requests.map(pathsIn), [["src/app.js"]]);
  assert.deepEqual(core.messages("warning"), [SENSITIVE_WARNING]);
});

test("does not parse a file that may hold secrets", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([apiFile(".env"), apiFile("src/a.js")]);
  const parsed = [];

  await runWith(core, {
    octokit,
    parsePatch: (patch) => {
      parsed.push(patch);
      return parsePatch(patch);
    },
  });

  assert.equal(parsed.length, 1);
});

test("ends with the notice and no request when only sensitive files changed", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([apiFile(".env"), apiFile(".npmrc")]);

  const { ai } = await runWith(core, { octokit });

  assert.equal(ai.options.length, 0);
  assert.equal(core.messages("notice").length, 1);
  assert.deepEqual(core.messages("warning"), [SENSITIVE_WARNING]);
  assert.deepEqual(core.messages("setFailed"), []);
});

test("lists files that may hold secrets right after unreadable ones", async () => {
  const core = createFakeCore({ ...VALID_INPUTS, "max-files": "1" });
  const octokit = createFakeOctokit([
    apiFile("src/odd.js", { patch: "not a diff" }),
    apiFile("src/a.js"),
    apiFile("src/b.js"),
    apiFile("package-lock.json"),
    apiFile(".env"),
  ]);

  await runWith(core, { octokit });

  const reasons = selectionLines(core)
    .filter((line) => line.startsWith("Skipped "))
    .map((line) => line.split(": ")[0]);
  assert.deepEqual(reasons, [
    "Skipped src/odd.js",
    "Skipped .env",
    "Skipped src/b.js",
    "Skipped package-lock.json",
  ]);
});

// --- Strings that look like secrets -------------------------------------------

// A stand-in in the shape of a GitHub token, put together at run time so that
// no file contains anything that looks like a credential.
const FAKE_TOKEN = `gh${"p"}_${"Ab1".repeat(12)}`;

test("masks a token before it reaches the model and keeps the line numbers", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const patch = `@@ -0,0 +1,2 @@\n+const token = "${FAKE_TOKEN}";\n+run(token);`;
  const octokit = createFakeOctokit([apiFile("src/config.js", { patch })]);

  const { ai } = await runWith(core, { octokit });

  const [request] = ai.requests;
  assert.ok(!request.user.includes(FAKE_TOKEN));
  assert.match(
    request.user,
    /^ {3}1 \| \+const token = "\[REDACTED SECRET\]";$/m,
  );
  assert.match(request.user, /^ {3}2 \| \+run\(token\);$/m);
  assert.deepEqual(core.messages("warning"), [
    "Strings that look like secrets were masked before anything was sent to the model: 1 in 1 files. Check that no real secret is part of this pull request.",
  ]);
  assert.ok(
    core
      .messages("info")
      .includes("Masked 1 possible secrets in src/config.js."),
  );
  assert.ok(!JSON.stringify(core.calls).includes(FAKE_TOKEN));
});

test("warns about no secrets when there are none", async () => {
  const core = createFakeCore(VALID_INPUTS);

  await runWith(core);

  assert.deepEqual(core.messages("warning"), []);
});

// --- The request to the model ------------------------------------------------

/** A finding as the model returns it. */
const modelFinding = (path, severity = "major", text = "x") => ({
  path,
  line: 1,
  severity,
  category: "code-quality",
  title: text,
  comment: text,
  suggestion: text,
});

/** A file with `lines` added lines, about 11 characters each once annotated. */
const bigFile = (path, lines) =>
  apiFile(path, { additions: lines, deletions: 0, patch: addedPatch(lines) });

/** The paths in the user message of one request. */
const pathsIn = (request) =>
  [...request.user.matchAll(/^<file path="([^"]*)">$/gm)].map(
    (match) => match[1],
  );

test("sends the files to the model with the system prompt of the language", async () => {
  const core = createFakeCore({
    ...VALID_INPUTS,
    "openai-model": "gpt-4.1",
    language: "de",
  });

  const { ai } = await runWith(core);

  assert.equal(ai.options.length, 1);
  assert.equal(ai.options[0].apiKey, "key-value");
  assert.equal(ai.options[0].model, "gpt-4.1");
  assert.equal(ai.options[0].core, core);
  assert.equal(ai.requests.length, 1);
  const [request] = ai.requests;
  assert.equal(request.system, buildSystemPrompt({ language: "de" }));
  assert.equal(
    request.user,
    buildUserPrompt({
      files: ["src/file-0.js", "src/file-1.js"].map((path) => ({
        path,
        annotated: annotateDiff(parsePatch(DEFAULT_PATCH).hunks),
      })),
    }),
  );
  assert.equal(request.responseFormat, REVIEW_FORMAT);
  assert.equal(request.maxOutputTokens, MAX_OUTPUT_TOKENS);
});

test("uses the default model and English without inputs", async () => {
  const core = createFakeCore(VALID_INPUTS);

  const { ai } = await runWith(core);

  assert.equal(ai.options[0].model, "gpt-4o-mini");
  assert.equal(ai.requests[0].system, buildSystemPrompt({ language: "en" }));
});

test("logs the requests and the findings per severity, nothing else", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const ai = createFakeAi(() =>
    modelAnswer([
      modelFinding("src/file-0.js", "critical"),
      modelFinding("src/file-0.js", "minor"),
      modelFinding("src/file-1.js", "minor"),
    ]),
  );

  await runWith(core, { ai });

  assert.deepEqual(core.messages("info").slice(-2), [
    "Sending 2 files to gpt-4o-mini in 1 requests.",
    "Review finished: 3 findings (1 critical, 0 major, 2 minor, 0 info) from 1 of 1 requests.",
  ]);
  assert.deepEqual(core.messages("warning"), []);
  assert.deepEqual(core.messages("setFailed"), []);
});

test("spreads a pull request over the budget of one request and merges the findings", async () => {
  const core = createFakeCore(VALID_INPUTS);
  // About 33000 characters each: no two of them fit into one request.
  const octokit = createFakeOctokit([
    bigFile("src/a.js", 3000),
    bigFile("src/b.js", 3000),
    bigFile("src/c.js", 3000),
    apiFile("src/small.js"),
  ]);
  const ai = createFakeAi((request) =>
    modelAnswer(pathsIn(request).map((path) => modelFinding(path))),
  );

  await runWith(core, { octokit, ai });

  assert.deepEqual(core.messages("setFailed"), []);
  assert.deepEqual(ai.requests.map(pathsIn), [
    ["src/a.js"],
    ["src/b.js"],
    ["src/c.js", "src/small.js"],
  ]);
  for (const request of ai.requests) {
    assert.ok(request.user.length <= MAX_REQUEST_CHARS);
    assert.match(request.user, /^<file path="/);
  }
  assert.deepEqual(core.messages("info").slice(-2), [
    "Sending 4 files to gpt-4o-mini in 3 requests.",
    "Review finished: 4 findings (0 critical, 4 major, 0 minor, 0 info) from 3 of 3 requests.",
  ]);
});

test("leaves out a file larger than one request and reviews the others", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    bigFile("src/huge.js", 6000),
    apiFile("src/small.js"),
  ]);

  const { ai } = await runWith(core, { octokit });

  assert.deepEqual(ai.requests.map(pathsIn), [["src/small.js"]]);
  assert.ok(
    selectionLines(core).includes(
      `Skipped src/huge.js: larger than one request to the model (${MAX_REQUEST_CHARS} characters).`,
    ),
  );
  // It counts against neither limit.
  assert.ok(selectionLines(core).includes(diffSizeLine([DEFAULT_PATCH])));
  assert.deepEqual(core.messages("warning"), [
    `Files larger than one request to the model: 1. They are not reviewed. One request holds at most ${MAX_REQUEST_CHARS} characters.`,
  ]);
  assert.deepEqual(core.messages("setFailed"), []);
});

test("does not warn about the name of a file that is excluded anyway", async () => {
  const core = createFakeCore({ ...VALID_INPUTS, exclude: "*.lock" });
  const octokit = createFakeOctokit([
    apiFile('odd"name.lock'),
    apiFile("src/<odd>.js"),
    apiFile("src/good.js"),
  ]);

  const { ai } = await runWith(core, { octokit });

  assert.deepEqual(core.messages("warning"), [
    'Files whose name cannot be put into the prompt: 1. They are not reviewed. A name with a double quote, "<", ">" or a control character cannot be sent.',
  ]);
  assert.deepEqual(ai.requests.map(pathsIn), [["src/good.js"]]);
});

test("ends with the notice when the only file is larger than one request", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([bigFile("src/huge.js", 6000)]);

  const { ai } = await runWith(core, { octokit });

  assert.equal(ai.options.length, 0);
  assert.equal(core.messages("notice").length, 1);
  assert.deepEqual(core.messages("setFailed"), []);
});

test("keeps the other findings and ends green with a warning when one request fails", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    bigFile("src/a.js", 3000),
    bigFile("src/b.js", 3000),
    bigFile("src/c.js", 3000),
  ]);
  const failure = new AiError(
    "server",
    "OpenAI could not answer (HTTP 500), also after 2 retries. Run the workflow again later.",
    500,
  );
  const ai = createFakeAi((request) =>
    pathsIn(request)[0] === "src/b.js"
      ? failure
      : modelAnswer([modelFinding(pathsIn(request)[0])]),
  );

  await runWith(core, { octokit, ai });

  assert.deepEqual(core.messages("setFailed"), []);
  assert.deepEqual(core.messages("warning"), [
    `Requests to the model that failed: 1 of 3. 1 files were not reviewed. ${failure.message}`,
  ]);
  assert.deepEqual(core.messages("info").slice(-3), [
    "Sending 3 files to gpt-4o-mini in 3 requests.",
    "Not reviewed src/b.js: the request to the model failed.",
    "Review finished: 2 findings (0 critical, 2 major, 0 minor, 0 info) from 2 of 3 requests.",
  ]);
});

test("names each reason of a failed request once", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    bigFile("src/a.js", 3000),
    bigFile("src/b.js", 3000),
    bigFile("src/c.js", 3000),
    bigFile("src/d.js", 3000),
  ]);
  const ai = createFakeAi((request, index) =>
    index === 0 ? modelAnswer() : new AiError("timeout", "Too slow."),
  );

  await runWith(core, { octokit, ai });

  assert.deepEqual(core.messages("warning"), [
    "Requests to the model that failed: 3 of 4. 3 files were not reviewed. Too slow.",
  ]);
});

test("fails the step with the message of the client when every request fails", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const message =
    "OpenAI rejected the API key (HTTP 401). Check that the repository secret `OPENAI_API_KEY` holds a valid key of an active project.";
  const ai = createFakeAi(() => new AiError("auth", message, 401));

  await runWith(core, { ai });

  assert.deepEqual(core.messages("setFailed"), [message]);
  assert.equal(ai.requests.length, 1);
});

test("fails the step when the answer does not fit the review format", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const ai = createFakeAi(() => ({
    ...modelAnswer(),
    content: "ANSWER-OF-THE-MODEL",
  }));

  await runWith(core, { ai });

  assert.deepEqual(core.messages("setFailed"), [
    "The answer of the model is not valid JSON. Run the workflow again.",
  ]);
  assert.doesNotMatch(JSON.stringify(core.calls), /ANSWER-OF-THE-MODEL/);
});

test("fails the step on a defect of the client and posts nothing", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const ai = createFakeAi(() => new TypeError("a defect"));

  await runWith(core, { ai });

  assert.deepEqual(core.messages("setFailed"), ["a defect"]);
});

test("puts the title of the pull request neither into the prompt nor into the log", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const payload = loadEvent();
  payload.pull_request.title = "TITLE-WRITTEN-BY-THE-AUTHOR";

  const { ai } = await runWith(core, {
    context: createFakeContext({ payload }),
  });

  assert.equal(ai.requests.length, 1);
  for (const request of ai.requests) {
    assert.doesNotMatch(request.system + request.user, /TITLE-WRITTEN/);
  }
  assert.doesNotMatch(JSON.stringify(core.calls), /TITLE-WRITTEN/);
});

test("never logs the summary, the findings or the prompt", async () => {
  const core = createFakeCore(VALID_INPUTS);
  const ai = createFakeAi(() =>
    modelAnswer(
      [modelFinding("src/file-0.js", "critical", "FINDING-TEXT")],
      "SUMMARY-TEXT",
    ),
  );

  await runWith(core, { ai });

  const log = JSON.stringify(core.calls);
  assert.doesNotMatch(log, /FINDING-TEXT|SUMMARY-TEXT/);
  assert.doesNotMatch(log, /<file path=|pull_request_title|experienced/);
});

test("fails with the same message for a limit that is a secret-looking value", async () => {
  // A limit is a setting. A value that equals a credential is still shown
  // as the redactor of the run knows it.
  const core = createFakeCore({
    ...VALID_INPUTS,
    "max-files": "key-value",
  });

  await runWith(core);

  assert.deepEqual(core.messages("setFailed"), [
    'Input `max-files` must be a whole number from 1 to 999999999, but is "***".',
  ]);
});

test("falls back to the defaults when a limit is empty", async () => {
  const core = createFakeCore({
    ...VALID_INPUTS,
    "max-files": "",
    "max-diff-chars": "",
  });

  await runWith(core, { octokit: createFakeOctokit(apiFiles(60)) });

  assert.ok(
    core
      .messages("info")
      .includes("Found 60 changed files: 50 to review, 10 skipped."),
  );
  assert.deepEqual(core.messages("setFailed"), []);
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

test("keeps no unmasked patch once the diffs are parsed", async () => {
  // A stand-in in the shape of a GitHub token, put together at run time.
  const token = `gh${"p"}_${"Ab1".repeat(12)}`;
  const core = createFakeCore(VALID_INPUTS);
  const octokit = createFakeOctokit([
    apiFile("src/config.js", { patch: `@@ -0,0 +1 @@\n+"${token}"` }),
  ]);
  const seen = [];
  const ai = createFakeAi((request) => {
    seen.push(request);
    return modelAnswer();
  });

  await runWith(core, { octokit, ai });

  assert.equal(seen.length, 1);
  assert.ok(!JSON.stringify(seen).includes(token));
  assert.ok(!JSON.stringify(core.calls).includes(token));
});
