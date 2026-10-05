import "./helpers/no-proxy.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getOctokit } from "@actions/github";
import { SKIP_REASONS, listChangedFiles } from "../src/github/files.js";
import {
  apiFile,
  apiFiles,
  createFakeOctokit,
  startGitHubApi,
} from "./helpers/github-api.js";
import { TOKEN, fromRoot } from "./helpers/run-action.js";

const PULL_REQUEST = { owner: "octo-org", repo: "demo", pullNumber: 42 };

/** The real Octokit client, pointed at the local test server. */
const octokitFor = (api) => getOctokit(TOKEN, { baseUrl: api.url });

// --- With a mocked Octokit ---------------------------------------------------

test("asks for the files of the pull request, 100 per page", async () => {
  const octokit = createFakeOctokit();

  await listChangedFiles(octokit, PULL_REQUEST);

  assert.equal(octokit.calls.length, 1);
  assert.equal(octokit.calls[0].endpoint, octokit.rest.pulls.listFiles);
  assert.deepEqual(octokit.calls[0].parameters, {
    owner: "octo-org",
    repo: "demo",
    pull_number: 42,
    per_page: 100,
  });
});

test("returns each file in the model of the action", async () => {
  const octokit = createFakeOctokit([
    apiFile("src/main.js", {
      status: "added",
      additions: 3,
      deletions: 0,
      patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c",
      sha: "abc",
      blob_url: "https://example.invalid/blob",
    }),
  ]);

  const result = await listChangedFiles(octokit, PULL_REQUEST);

  assert.deepEqual(result, {
    files: [
      {
        path: "src/main.js",
        status: "added",
        additions: 3,
        deletions: 0,
        patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c",
      },
    ],
    skipped: [],
    truncated: false,
  });
});

test("keeps a renamed file that also changed", async () => {
  const octokit = createFakeOctokit([
    apiFile("src/new-name.js", { status: "renamed" }),
  ]);

  const { files, skipped } = await listChangedFiles(octokit, PULL_REQUEST);

  assert.deepEqual(
    files.map((file) => file.path),
    ["src/new-name.js"],
  );
  assert.deepEqual(skipped, []);
});

const SKIPPED_CASES = [
  ["a deleted file", { status: "removed" }, SKIP_REASONS.removed],
  [
    "a file that was only renamed",
    { status: "renamed", additions: 0, deletions: 0, patch: undefined },
    SKIP_REASONS.unchanged,
  ],
  [
    "a file whose mode changed",
    { status: "changed", additions: 0, deletions: 0, patch: undefined },
    SKIP_REASONS.unchanged,
  ],
  [
    "a new binary file",
    { status: "added", additions: 0, deletions: 0, patch: undefined },
    SKIP_REASONS.noPatch,
  ],
  [
    "a changed binary file",
    { status: "modified", additions: 0, deletions: 0, patch: undefined },
    SKIP_REASONS.noPatch,
  ],
  [
    "a file whose diff is too large",
    { status: "added", additions: 5866, deletions: 0, patch: undefined },
    SKIP_REASONS.noPatch,
  ],
  [
    "a file with an empty patch",
    { status: "modified", patch: "" },
    SKIP_REASONS.noPatch,
  ],
];

for (const [name, fields, reason] of SKIPPED_CASES) {
  test(`skips ${name} and says why`, async () => {
    const octokit = createFakeOctokit([apiFile("some/file", fields)]);

    const result = await listChangedFiles(octokit, PULL_REQUEST);

    assert.deepEqual(result.files, []);
    assert.deepEqual(result.skipped, [{ path: "some/file", reason }]);
  });
}

test("reports when GitHub's limit of 3000 files was reached", async () => {
  const below = await listChangedFiles(
    createFakeOctokit(apiFiles(2999)),
    PULL_REQUEST,
  );
  const reached = await listChangedFiles(
    createFakeOctokit(apiFiles(3000)),
    PULL_REQUEST,
  );

  assert.equal(below.truncated, false);
  assert.equal(reached.truncated, true);
});

test("rejects an answer that has a file without a name", async () => {
  const octokit = createFakeOctokit([{ status: "modified", patch: "x" }]);

  await assert.rejects(
    listChangedFiles(octokit, PULL_REQUEST),
    /changed file without a name/,
  );
});

test("passes on an error that is not an API answer", async () => {
  const octokit = createFakeOctokit();
  const failure = new TypeError("something else broke");
  octokit.paginate = async () => {
    throw failure;
  };

  await assert.rejects(listChangedFiles(octokit, PULL_REQUEST), failure);
});

// --- With the real Octokit against a local server ----------------------------

test("loads more than 100 files completely, page by page", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(120) });

  const { files } = await listChangedFiles(octokitFor(api), PULL_REQUEST);

  assert.equal(files.length, 120);
  assert.equal(files.at(0).path, "src/file-0.js");
  assert.equal(files.at(-1).path, "src/file-119.js");
  assert.deepEqual(
    api.requests.map((request) => request.path),
    [
      "/repos/octo-org/demo/pulls/42/files?per_page=100",
      "/repos/octo-org/demo/pulls/42/files?per_page=100&page=2",
    ],
  );
});

test("sends the token to the API", async (t) => {
  const api = await startGitHubApi(t, { files: apiFiles(1) });

  await listChangedFiles(octokitFor(api), PULL_REQUEST);

  assert.equal(api.requests[0].authorization, `token ${TOKEN}`);
});

const API_ERRORS = [
  [401, {}, /HTTP 401.*token was rejected.*`github-token`/],
  [403, {}, /HTTP 403.*may not read this pull request.*`pull-requests`/],
  [
    403,
    {
      headers: { "x-ratelimit-remaining": "0" },
      message: "API rate limit exceeded",
    },
    /HTTP 403.*rate limit/,
  ],
  [
    403,
    {
      headers: { "retry-after": "60" },
      message: "You have exceeded a secondary limit",
    },
    /HTTP 403.*rate limit/,
  ],
  [429, {}, /HTTP 429.*rate limit/],
  [404, {}, /HTTP 404.*not found.*no access/],
  [500, { message: "Server Error" }, /HTTP 500.*could not answer/],
  [422, { message: "Unprocessable" }, /HTTP 422.*debug logging/],
];

for (const [status, answer, expected] of API_ERRORS) {
  const kind = answer.headers ? ` (${Object.keys(answer.headers)[0]})` : "";

  test(`explains an API error with status ${status}${kind}`, async (t) => {
    const api = await startGitHubApi(t, { status, ...answer });

    await assert.rejects(
      listChangedFiles(octokitFor(api), PULL_REQUEST),
      (error) => {
        assert.match(error.message, expected);
        assert.equal(error.cause.status, status);
        return true;
      },
    );
  });
}

test("keeps the token out of every API error", async (t) => {
  for (const status of [401, 403, 404, 500]) {
    const api = await startGitHubApi(t, { status });

    await assert.rejects(
      listChangedFiles(octokitFor(api), PULL_REQUEST),
      (error) => {
        const everything = [
          error.message,
          error.stack,
          error.cause.message,
          JSON.stringify(error.cause),
        ].join("\n");
        assert.equal(everything.includes(TOKEN), false);
        return true;
      },
    );
  }
});

test("says that GitHub was not reached when there was no answer at all", async (t) => {
  const api = await startGitHubApi(t);
  const unreachable = getOctokit(TOKEN, { baseUrl: "http://127.0.0.1:9" });

  await assert.rejects(listChangedFiles(unreachable, PULL_REQUEST), (error) => {
    assert.match(error.message, /^GitHub could not be reached\./);
    assert.doesNotMatch(error.message, /HTTP \d/);
    return true;
  });
  assert.deepEqual(api.requests, []);
});

// --- No checkout needed ------------------------------------------------------

test("reads nothing from the working tree", () => {
  const source = readFileSync(fromRoot("src/github/files.js"), "utf8");

  assert.doesNotMatch(source, /node:fs|node:child_process|["']fs["']|git /);
  assert.doesNotMatch(source, /^import /m);
});
