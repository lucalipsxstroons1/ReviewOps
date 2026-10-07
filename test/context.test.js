import assert from "node:assert/strict";
import { test } from "node:test";
import { readPullRequest, readRun } from "../src/github/context.js";
import { createFakeContext, loadEvent } from "./helpers/fake-context.js";

/** The example payload with one change applied to its pull request. */
function contextWith(change) {
  const payload = loadEvent();
  change(payload.pull_request, payload);
  return createFakeContext({ payload });
}

test("reads the pull request from the example payload", () => {
  assert.deepEqual(readPullRequest(createFakeContext()), {
    owner: "octo-org",
    repo: "demo",
    pullNumber: 42,
    headSha: "1111111111111111111111111111111111111111",
    baseSha: "2222222222222222222222222222222222222222",
    title: "Add a greeting helper",
    isFork: false,
    isDraft: false,
  });
});

test("takes the head commit from the pull request, not from GITHUB_SHA", (t) => {
  const previous = process.env.GITHUB_SHA;
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previous;
  });
  // On a pull_request event GITHUB_SHA is the temporary merge commit.
  process.env.GITHUB_SHA = "9999999999999999999999999999999999999999";
  const context = { ...createFakeContext(), sha: process.env.GITHUB_SHA };

  assert.equal(
    readPullRequest(context).headSha,
    "1111111111111111111111111111111111111111",
  );
});

test("takes owner and repository from the run, not from the payload", () => {
  const context = createFakeContext({
    repo: { owner: "another-org", repo: "another-repo" },
  });

  const pullRequest = readPullRequest(context);

  assert.equal(pullRequest.owner, "another-org");
  assert.equal(pullRequest.repo, "another-repo");
});

test("recognises a pull request from another repository as a fork", () => {
  const context = contextWith((pullRequest) => {
    pullRequest.head.repo.full_name = "someone-else/demo";
  });

  assert.equal(readPullRequest(context).isFork, true);
});

test("treats a deleted head repository as a fork", () => {
  const context = contextWith((pullRequest) => {
    pullRequest.head.repo = null;
  });

  assert.equal(readPullRequest(context).isFork, true);
});

test("ignores letter case when comparing repositories", () => {
  const context = contextWith((pullRequest) => {
    pullRequest.head.repo.full_name = "Octo-Org/Demo";
  });

  assert.equal(readPullRequest(context).isFork, false);
});

test("recognises a draft", () => {
  const context = contextWith((pullRequest) => {
    pullRequest.draft = true;
  });

  assert.equal(readPullRequest(context).isDraft, true);
});

test("uses an empty title when the payload has none", () => {
  const context = contextWith((pullRequest) => {
    delete pullRequest.title;
  });

  assert.equal(readPullRequest(context).title, "");
});

const INVALID_PAYLOADS = [
  [
    "no payload at all",
    () => ({ payload: undefined }),
    /carries no pull request/,
  ],
  ["no pull request", () => ({ payload: {} }), /carries no pull request/],
  [
    "a pull request that is not an object",
    () => ({ payload: { pull_request: "42" } }),
    /carries no pull request/,
  ],
  [
    "no number",
    () => contextWith((pullRequest) => delete pullRequest.number),
    /no valid pull request number/,
  ],
  [
    "a number given as text",
    () => contextWith((pullRequest) => (pullRequest.number = "42")),
    /no valid pull request number/,
  ],
  [
    "no head",
    () => contextWith((pullRequest) => delete pullRequest.head),
    /no valid head commit SHA/,
  ],
  [
    "a head SHA that is too short",
    () => contextWith((pullRequest) => (pullRequest.head.sha = "abc123")),
    /no valid head commit SHA/,
  ],
  [
    "a head SHA with a line break",
    () =>
      contextWith(
        (pullRequest) =>
          (pullRequest.head.sha = `${"1".repeat(40)}\n::error::x`),
      ),
    /no valid head commit SHA/,
  ],
  [
    "no base SHA",
    () => contextWith((pullRequest) => delete pullRequest.base.sha),
    /no valid base commit SHA/,
  ],
];

for (const [name, build, expected] of INVALID_PAYLOADS) {
  test(`rejects an event with ${name}`, () => {
    const context = { ...createFakeContext(), ...build() };

    assert.throws(() => readPullRequest(context), expected);
  });
}

for (const repo of [
  undefined,
  { owner: "octo-org" },
  { owner: "", repo: "demo" },
  { owner: "octo org", repo: "demo" },
  { owner: "octo-org", repo: "demo\n::error::x" },
]) {
  test(`rejects the repository ${JSON.stringify(repo)}`, () => {
    const context = { ...createFakeContext(), repo };

    assert.throws(() => readPullRequest(context), /could not be determined/);
  });
}

test("never repeats a value from the payload in an error message", () => {
  const marker = "PAYLOAD-VALUE-THAT-MUST-NOT-LEAK";
  const contexts = [
    contextWith((pullRequest) => (pullRequest.number = marker)),
    contextWith((pullRequest) => (pullRequest.head.sha = marker)),
    contextWith((pullRequest) => (pullRequest.base.sha = marker)),
    { ...createFakeContext(), repo: { owner: marker, repo: `${marker}!` } },
  ];

  for (const context of contexts) {
    assert.throws(
      () => readPullRequest(context),
      (error) => !error.message.includes(marker),
    );
  }
});

test("reads the run number and the attempt", () => {
  assert.deepEqual(readRun({ runId: 18234567890, runAttempt: 2 }), {
    runId: 18234567890,
    runAttempt: 2,
  });
});

for (const [name, value] of [
  ["missing", undefined],
  ["NaN", Number.NaN],
  ["zero", 0],
  ["negative", -7654321],
  ["fractional", 1.7654321],
  ["above 2^53 - 1", 2 ** 53],
  ["text", "7654321"],
]) {
  test(`readRun rejects a ${name} run id and attempt without the value`, () => {
    assert.throws(
      () => readRun({ runId: value, runAttempt: 1 }),
      (error) =>
        /GITHUB_RUN_ID/.test(error.message) &&
        !error.message.includes("7654321"),
    );
    assert.throws(
      () => readRun({ runId: 1, runAttempt: value }),
      /GITHUB_RUN_ATTEMPT/,
    );
  });
}
