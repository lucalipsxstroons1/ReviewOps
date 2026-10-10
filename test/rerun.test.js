import assert from "node:assert/strict";
import { test } from "node:test";
import { lineFingerprint } from "../src/fingerprint.js";
import { fingerprintLine } from "../src/github/review.js";
import { apiFile, OWN_ACCOUNT, startGitHubApi } from "./helpers/github-api.js";
import { reviewCompletion, startOpenAiApi } from "./helpers/openai-api.js";
import {
  PULL_REQUEST_EVENT,
  TOKEN,
  fromRoot,
  startAction,
  withInputs,
  withoutMaskCommands,
} from "./helpers/run-action.js";

// Process tests for a second run on the same pull request: the head of the
// example event is "1" * 40.
const HEAD = "1".repeat(40);
const EARLIER = "a".repeat(40);

const MARKER = "<!-- reviewops -->";

const viewerRequests = (api) =>
  api.requests.filter(
    ({ path, body }) => path === "/graphql" && /\bviewer\b/.test(body?.query),
  );

const run = (api) =>
  startAction(
    fromRoot("src/index.js"),
    withInputs({
      ...PULL_REQUEST_EVENT,
      GITHUB_API_URL: api.url,
      TEST_OPENAI_URL: api.openai.url,
    }),
  );

async function startApis(t, github, answer = reviewCompletion()) {
  const api = await startGitHubApi(t, github);
  return { ...api, openai: await startOpenAiApi(t, answer) };
}

// The pull request adds three lines: "a", "b" and "c".
const FILE = apiFile("src/app.js", {
  additions: 3,
  deletions: 0,
  patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c",
});
const fingerprintOf = (content, previous = "") =>
  lineFingerprint("src/app.js", content, previous);

const ownReview = (commit_id, fields = {}) => ({
  id: 5,
  body: `${MARKER}\n\n### ReviewOps`,
  user: OWN_ACCOUNT,
  state: "COMMENTED",
  commit_id,
  ...fields,
});
const ownComment = (content, fields = {}) => ({
  id: 6,
  body: `${MARKER}\n${fingerprintLine(fingerprintOf(content))}\n\ntext`,
  user: OWN_ACCOUNT,
  path: "src/app.js",
  ...fields,
});

const finding = (line, title = `Problem at ${line}`) => ({
  path: "src/app.js",
  line,
  severity: "major",
  category: "code-quality",
  title,
  comment: "It breaks.",
  suggestion: "Fix it.",
});

/** The comparison of the earlier commit with the head: line 3 is new. */
const compareWithNewLine = () => ({
  status: 200,
  body: {
    status: "ahead",
    files: [
      {
        filename: "src/app.js",
        status: "modified",
        changes: 1,
        patch: "@@ -1,2 +1,3 @@\n a\n b\n+c",
      },
    ],
  },
});

test("a second run on unchanged code posts nothing and does not ask the model", async (t) => {
  const api = await startApis(t, {
    files: [FILE],
    existingReviews: [ownReview(HEAD)],
    existingComments: [ownComment("a")],
  });

  const result = await run(api);

  assert.equal(result.status, 0, result.output);
  assert.equal(api.openai.requests.length, 0);
  assert.deepEqual(api.reviews, []);
  assert.match(
    result.stdout,
    new RegExp(
      `^::notice::ReviewOps found no new lines to review since commit ${HEAD}\\.`,
      "m",
    ),
  );
  assert.equal(result.stderr, "");
  // The own reviews are known by the account of the token: one query for it.
  assert.match(
    result.stdout,
    /Earlier work of ReviewOps on this pull request: 1 reviews, 1 comments\./,
  );
  assert.equal(viewerRequests(api).length, 1);
});

test("an empty commit after a review posts nothing and does not ask the model", async (t) => {
  const api = await startApis(t, {
    files: [FILE],
    existingReviews: [ownReview(EARLIER)],
    compare: (basehead) => {
      assert.equal(basehead, `${EARLIER}...${HEAD}`);
      return { status: 200, body: { status: "ahead", files: [] } };
    },
  });

  const result = await run(api);

  assert.equal(result.status, 0, result.output);
  assert.equal(api.openai.requests.length, 0);
  assert.deepEqual(api.reviews, []);
  assert.match(result.stdout, /^::notice::ReviewOps found no new lines/m);
});

test("a new commit with a new problem gets one comment at the new line", async (t) => {
  const api = await startApis(
    t,
    {
      files: [FILE],
      existingReviews: [ownReview(EARLIER)],
      existingComments: [ownComment("a")],
      compare: compareWithNewLine,
    },
    // The model repeats the problem at the old line and reports a new one.
    reviewCompletion([finding(1), finding(3)]),
  );

  const result = await run(api);

  assert.equal(result.status, 0, result.output);
  assert.equal(api.openai.requests.length, 1);
  // The model sees the whole change of the file, not only the new line.
  const prompt = api.openai.requests[0].body.messages[1].content;
  assert.ok(prompt.includes('<file path="src/app.js">'));
  assert.match(prompt, /\+a\b/);

  assert.equal(api.reviews.length, 1);
  const [review] = api.reviews;
  assert.equal(review.body.commit_id, HEAD);
  assert.deepEqual(
    review.body.comments.map(({ path, line }) => ({ path, line })),
    [{ path: "src/app.js", line: 3 }],
  );
  assert.equal(
    review.body.comments[0].body.split("\n")[1],
    fingerprintLine(fingerprintOf("c", "b"), "major"),
  );
  assert.match(
    review.body.body,
    new RegExp(`Reviewed the changes since \`${EARLIER.slice(0, 7)}\``),
  );
  assert.match(
    result.stdout,
    /^Checked 2 findings: 1 at an added line, 0 at another line, left out 0 with an empty text, 0 for a file that was not sent, 0 duplicates, 1 outside of the new lines, 0 at lines that were commented before and 0 over the limit of 10 \(max-comments\)\.$/m,
  );
});

test("a file without a new line is not sent again", async (t) => {
  const other = apiFile("src/other.js");
  const api = await startApis(t, {
    files: [FILE, other],
    existingReviews: [ownReview(EARLIER)],
    compare: compareWithNewLine,
  });

  const result = await run(api);

  assert.equal(result.status, 0, result.output);
  const prompt = api.openai.requests[0].body.messages[1].content;
  assert.ok(prompt.includes('<file path="src/app.js">'));
  assert.ok(!prompt.includes("src/other.js"));
  assert.match(
    result.stdout,
    new RegExp(
      `^1 files have no new line since commit ${EARLIER} and are not sent again\\.$`,
      "m",
    ),
  );
  // Not a skipped file: it was checked already.
  assert.match(
    result.stdout,
    /^Found 2 changed files: 1 to review, 0 skipped\.$/m,
  );
});

for (const [name, compare] of [
  ["the comparison answers 404", () => ({ status: 404 })],
  [
    "the comparison is diverged",
    () => ({ status: 200, body: { status: "diverged", files: [] } }),
  ],
  [
    "the comparison is behind",
    () => ({ status: 200, body: { status: "behind", files: [] } }),
  ],
]) {
  test(`after a force-push (${name}) the run reviews everything and ends green`, async (t) => {
    const api = await startApis(
      t,
      {
        files: [FILE],
        existingReviews: [ownReview(EARLIER)],
        existingComments: [ownComment("a")],
        compare,
      },
      // "a" was commented before, "b" was not.
      reviewCompletion([finding(1), finding(2)]),
    );

    const result = await run(api);

    assert.equal(result.status, 0, result.output);
    assert.equal(result.stderr, "");
    assert.equal(api.openai.requests.length, 1);
    assert.equal(api.reviews.length, 1);
    const [review] = api.reviews;
    assert.deepEqual(
      review.body.comments.map(({ line }) => line),
      [2],
    );
    assert.ok(!review.body.body.includes("Reviewed the changes since"));
    assert.match(
      result.stdout,
      /^Reviewing the whole pull request: the commit of the earlier review is no longer part of this branch/m,
    );
  });
}

test("the first run reviews everything and says nothing about earlier reviews", async (t) => {
  const api = await startApis(
    t,
    { files: [FILE] },
    reviewCompletion([finding(1)]),
  );

  const result = await run(api);

  assert.equal(result.status, 0, result.output);
  assert.equal(api.reviews.length, 1);
  assert.doesNotMatch(result.stdout, /Earlier work of ReviewOps/);
  // Without a review or comment of the action, nobody asks for the account.
  assert.equal(viewerRequests(api).length, 0);
  // Files, reviews and comments were read before the review was posted.
  assert.deepEqual(
    api.requests.map((request) => request.path),
    [
      "/repos/octo-org/demo/pulls/42/files?per_page=100",
      "/repos/octo-org/demo/pulls/42/reviews?per_page=100",
      "/repos/octo-org/demo/pulls/42/comments?per_page=100",
      "/repos/octo-org/demo/pulls/42/reviews",
    ],
  );
});

test("a review of another bot with the marker and the head does not end the run without a review", async (t) => {
  const otherBot = { type: "Bot", login: "some-other-app[bot]", id: 49699333 };
  const api = await startApis(
    t,
    {
      files: [FILE],
      existingReviews: [ownReview(HEAD, { user: otherBot })],
      existingComments: [ownComment("a", { user: otherBot })],
    },
    reviewCompletion([finding(1)]),
  );

  const result = await run(api);

  assert.equal(result.status, 0, result.output);
  assert.equal(api.openai.requests.length, 1);
  assert.equal(api.reviews.length, 1);
  // The comment of the other bot hides nothing: line 1 is commented on.
  assert.deepEqual(
    api.reviews[0].body.comments.map(({ line }) => line),
    [1],
  );
  assert.doesNotMatch(result.stdout, /no new lines/);
  assert.doesNotMatch(result.stdout, /Earlier work of ReviewOps/);
});

test("fails before the model is asked when the account of the token cannot be read", async (t) => {
  const api = await startApis(t, {
    files: [FILE],
    existingReviews: [ownReview(HEAD)],
    viewer: () => ({ status: 403, body: { message: "Forbidden" } }),
  });

  const result = await run(api);

  assert.equal(result.status, 1);
  assert.equal(api.openai.requests.length, 0);
  assert.deepEqual(api.reviews, []);
  assert.match(
    result.stdout,
    /^::error::GitHub API request failed \(HTTP 403\)\. .*`github-token`/m,
  );
  assert.doesNotMatch(withoutMaskCommands(result.output), new RegExp(TOKEN));
});

test("comments of other reviewers and bots stay untouched and are not used", async (t) => {
  const human = { type: "User", login: "octocat", id: 583231 };
  const otherBot = { type: "Bot", login: "dependabot[bot]", id: 49699333 };
  const api = await startApis(
    t,
    {
      files: [FILE],
      existingReviews: [
        // A person who copied the marker, and a bot without it.
        ownReview(HEAD, { user: human }),
        ownReview(HEAD, { user: otherBot, body: "Looks fine." }),
      ],
      existingComments: [
        ownComment("a", { user: human }),
        {
          id: 8,
          body: `${fingerprintLine(fingerprintOf("a"))}\n\ntext`,
          user: otherBot,
        },
        { id: 9, body: "A remark of a person.", user: human },
      ],
    },
    reviewCompletion([finding(1)]),
  );

  const result = await run(api);

  assert.equal(result.status, 0, result.output);
  // None of them counts: the whole pull request is reviewed and line 1 is
  // commented on.
  assert.equal(api.reviews.length, 1);
  assert.deepEqual(
    api.reviews[0].body.comments.map(({ line }) => line),
    [1],
  );
  // Apart from reading (the query for the account of the token is a POST
  // to GraphQL), the run only posts its one new review: it never edits,
  // replaces or deletes anything.
  assert.deepEqual(
    api.requests
      .filter(({ method, path }) => method !== "GET" && path !== "/graphql")
      .map(({ method }) => method),
    ["POST"],
  );
  assert.doesNotMatch(withoutMaskCommands(result.output), new RegExp(TOKEN));
});

test("fails before the model is asked when the earlier reviews cannot be read", async (t) => {
  const api = await startApis(t, { files: [FILE], status: 403 });

  const result = await run(api);

  assert.equal(result.status, 1);
  assert.equal(api.openai.requests.length, 0);
  assert.match(
    result.stdout,
    /^::error::GitHub API request failed \(HTTP 403\)/m,
  );
});

test("writes numbers and a commit to the log, never an earlier comment or a fingerprint", async (t) => {
  const api = await startApis(t, {
    files: [FILE],
    existingReviews: [ownReview(EARLIER)],
    existingComments: [ownComment("a")],
    compare: compareWithNewLine,
  });

  const result = await run(api);

  assert.equal(result.status, 0, result.output);
  assert.ok(!result.output.includes(fingerprintOf("a")));
  assert.match(
    result.stdout,
    /^Earlier work of ReviewOps on this pull request: 1 reviews, 1 comments\.$/m,
  );
  assert.match(
    result.stdout,
    new RegExp(`^Reviewing only the changes since commit ${EARLIER}\\.$`, "m"),
  );
});
