import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatch } from "../src/diff/parse.js";
import { lineFingerprint } from "../src/fingerprint.js";
import {
  FULL_REASONS,
  readHistory,
  scopeDiffs,
} from "../src/github/history.js";
import {
  REVIEW_MARKER,
  commentBody,
  fingerprintLine,
  INCOMPLETE_LINE,
} from "../src/github/review.js";
import { apiFailure, createFakeOctokit } from "./helpers/github-api.js";

const HEAD = "b".repeat(40);
const FIRST = "a".repeat(40);
const SECOND = "c".repeat(40);
const PULL_REQUEST = {
  owner: "octo-org",
  repo: "demo",
  pullNumber: 42,
  headSha: HEAD,
};

const BOT = { type: "Bot", login: "github-actions[bot]" };
const HUMAN = { type: "User", login: "octocat" };

const ownReview = (commit_id, fields = {}) => ({
  body: `${REVIEW_MARKER}\n\n### ReviewOps`,
  user: BOT,
  state: "COMMENTED",
  commit_id,
  ...fields,
});
const ownComment = (fingerprint, fields = {}) => ({
  body: `${REVIEW_MARKER}\n${fingerprintLine(fingerprint)}\n\ntext`,
  user: BOT,
  ...fields,
});

const FP = "0123456789abcdef";
const FP2 = "fedcba9876543210";

const read = (options) =>
  readHistory(createFakeOctokit([], options), PULL_REQUEST);

const ahead = (files = []) => ({ status: "ahead", files });
const comparedFile = (filename, patch, fields = {}) => ({
  filename,
  status: "modified",
  changes: 1,
  patch,
  ...fields,
});

test("reviews everything when there is no earlier review", async () => {
  const history = await read({});
  assert.equal(history.mode, "full");
  assert.equal(history.since, null);
  assert.equal(history.reason, FULL_REASONS.noReview);
  assert.equal(history.newLines, null);
  assert.equal(history.ownReviews, 0);
});

test("does not call the comparison without an earlier review", async () => {
  const octokit = createFakeOctokit([]);
  await readHistory(octokit, PULL_REQUEST);
  assert.deepEqual(octokit.comparisons, []);
});

test("reads reviews and comments of the pull request with pagination", async () => {
  const octokit = createFakeOctokit([]);
  await readHistory(octokit, PULL_REQUEST);
  assert.deepEqual(
    octokit.calls.map((call) => call.endpoint),
    [octokit.rest.pulls.listReviews, octokit.rest.pulls.listReviewComments],
  );
  for (const { parameters } of octokit.calls) {
    assert.deepEqual(parameters, {
      owner: "octo-org",
      repo: "demo",
      pull_number: 42,
      per_page: 100,
    });
  }
});

test("takes the commit of the newest own review as the starting point", async () => {
  const history = await read({
    existingReviews: [ownReview(FIRST), ownReview(SECOND)],
    compare: () => ahead(),
  });
  assert.equal(history.mode, "incremental");
  assert.equal(history.since, SECOND);
  assert.equal(history.ownReviews, 2);
});

test("compares the earlier commit with the head", async () => {
  const octokit = createFakeOctokit([], {
    existingReviews: [ownReview(FIRST)],
    compare: () => ahead(),
  });
  await readHistory(octokit, PULL_REQUEST);
  assert.equal(octokit.comparisons.length, 1);
  assert.equal(octokit.comparisons[0].basehead, `${FIRST}...${HEAD}`);
  assert.equal(octokit.comparisons[0].owner, "octo-org");
  assert.equal(octokit.comparisons[0].repo, "demo");
});

test("has nothing new and no comparison when the head was reviewed already", async () => {
  const octokit = createFakeOctokit([], {
    existingReviews: [ownReview(HEAD)],
  });
  const history = await readHistory(octokit, PULL_REQUEST);
  assert.equal(history.mode, "incremental");
  assert.equal(history.since, HEAD);
  assert.equal(history.newLines.size, 0);
  assert.deepEqual(octokit.comparisons, []);
});

test("has nothing new when the comparison is identical", async () => {
  const history = await read({
    existingReviews: [ownReview(FIRST)],
    compare: () => ({ status: "identical" }),
  });
  assert.equal(history.mode, "incremental");
  assert.equal(history.newLines.size, 0);
});

test("ignores reviews of a person that carry the marker", async () => {
  const history = await read({
    existingReviews: [ownReview(FIRST, { user: HUMAN })],
  });
  assert.equal(history.mode, "full");
  assert.equal(history.ownReviews, 0);
});

test("ignores reviews of a bot without the marker", async () => {
  const history = await read({
    existingReviews: [
      ownReview(FIRST, { body: "Looks good." }),
      ownReview(FIRST, { body: `text\n${REVIEW_MARKER}` }),
    ],
  });
  assert.equal(history.mode, "full");
  assert.equal(history.ownReviews, 0);
});

test("ignores reviews without an author, a body or a valid commit", async () => {
  const history = await read({
    existingReviews: [
      ownReview(FIRST, { user: null }),
      ownReview(FIRST, { body: null }),
      ownReview("not-a-sha"),
      ownReview(undefined),
      null,
    ],
  });
  assert.equal(history.mode, "full");
});

test("skips a review that was never submitted and takes the one before", async () => {
  const history = await read({
    existingReviews: [
      ownReview(FIRST),
      ownReview(SECOND, { state: "PENDING" }),
    ],
    compare: () => ahead(),
  });
  assert.equal(history.since, FIRST);
});

test("falls back to the newest review that has a usable commit", async () => {
  const history = await read({
    existingReviews: [ownReview(FIRST), ownReview("short")],
    compare: () => ahead(),
  });
  assert.equal(history.since, FIRST);
});

test("collects the fingerprints of own comments", async () => {
  const history = await read({
    existingComments: [ownComment(FP), ownComment(FP2)],
  });
  assert.deepEqual([...history.fingerprints].sort(), [FP, FP2].sort());
  assert.equal(history.ownComments, 2);
});

test("reads back the fingerprint that commentBody() writes", async () => {
  const fingerprint = lineFingerprint("a.js", "let x = 1;");
  const body = commentBody(
    {
      severity: "major",
      category: "bug",
      path: "a.js",
      line: 1,
      title: "Title",
      comment: "Comment",
      suggestion: "Suggestion",
    },
    "gpt-4.1",
    fingerprint,
  );
  const history = await read({
    existingComments: [{ body, user: BOT }],
  });
  assert.deepEqual([...history.fingerprints], [fingerprint]);
});

test("ignores comments of a person, even with the marker and a fingerprint", async () => {
  const history = await read({
    existingComments: [ownComment(FP, { user: HUMAN })],
  });
  assert.equal(history.fingerprints.size, 0);
  assert.equal(history.ownComments, 0);
});

test("ignores comments of another bot without the marker", async () => {
  const history = await read({
    existingComments: [
      {
        body: `${fingerprintLine(FP)}\n\ntext`,
        user: { type: "Bot", login: "other[bot]" },
      },
    ],
  });
  assert.equal(history.fingerprints.size, 0);
});

test("reads a fingerprint only from the second line and only in its exact shape", async () => {
  const bodies = [
    // On the first line, behind the marker.
    `${REVIEW_MARKER}${fingerprintLine(FP)}\n\ntext`,
    // On the third line.
    `${REVIEW_MARKER}\n\n${fingerprintLine(FP)}`,
    // Too short, too long, upper case, extra text, other name.
    `${REVIEW_MARKER}\n<!-- reviewops-fingerprint: 0123456789abcde -->`,
    `${REVIEW_MARKER}\n<!-- reviewops-fingerprint: 0123456789abcdef0 -->`,
    `${REVIEW_MARKER}\n<!-- reviewops-fingerprint: 0123456789ABCDEF -->`,
    `${REVIEW_MARKER}\n${fingerprintLine(FP)} more`,
    `${REVIEW_MARKER}\n<!-- other: ${FP} -->`,
    `${REVIEW_MARKER}`,
  ];
  const history = await read({
    existingComments: bodies.map((body) => ({ body, user: BOT })),
  });
  assert.equal(history.fingerprints.size, 0);
  assert.equal(history.ownComments, bodies.length);
});

test("keeps the fingerprints of old comments", async () => {
  const history = await read({
    existingComments: [
      ownComment(FP, { position: null, original_position: 3, line: null }),
    ],
  });
  assert.ok(history.fingerprints.has(FP));
});

// --- the comparison -----------------------------------------------------------

test("collects the added lines of the comparison by path", async () => {
  const history = await read({
    existingReviews: [ownReview(FIRST)],
    compare: () =>
      ahead([
        comparedFile("a.js", "@@ -1,2 +1,4 @@\n one\n+two\n+three\n four"),
        comparedFile("b.js", "@@ -0,0 +1 @@\n+x"),
      ]),
  });
  assert.deepEqual([...history.newLines.get("a.js")], [2, 3]);
  assert.deepEqual([...history.newLines.get("b.js")], [1]);
  assert.equal(history.newLines.has("c.js"), false);
});

test("reads every page of the comparison", async () => {
  const files = Array.from({ length: 250 }, (_, index) =>
    comparedFile(`f${index}.js`, "@@ -0,0 +1 @@\n+x"),
  );
  const octokit = createFakeOctokit([], {
    existingReviews: [ownReview(FIRST)],
    compare: () => ahead(files),
  });
  const history = await readHistory(octokit, PULL_REQUEST);
  assert.equal(history.mode, "incremental");
  assert.equal(history.newLines.size, 250);
  assert.deepEqual(
    octokit.comparisons.map((parameters) => parameters.page),
    [1, 2, 3],
  );
});

test("treats a file with an unreadable patch as changed in every line", async () => {
  const history = await read({
    existingReviews: [ownReview(FIRST)],
    compare: () => ahead([comparedFile("a.js", "this is not a patch")]),
  });
  assert.equal(history.newLines.get("a.js"), null);
});

test("treats a file without a patch as changed in every line", async () => {
  const history = await read({
    existingReviews: [ownReview(FIRST)],
    compare: () =>
      ahead([
        comparedFile("big.js", undefined),
        comparedFile("logo.png", undefined, { status: "added" }),
      ]),
  });
  assert.equal(history.newLines.get("big.js"), null);
  assert.equal(history.newLines.get("logo.png"), null);
});

test("has no new line in a file that was only renamed or deleted", async () => {
  const history = await read({
    existingReviews: [ownReview(FIRST)],
    compare: () =>
      ahead([
        comparedFile("new-name.js", undefined, {
          status: "renamed",
          changes: 0,
        }),
        comparedFile("gone.js", undefined, { status: "removed" }),
      ]),
  });
  assert.equal(history.newLines.get("new-name.js").size, 0);
  assert.equal(history.newLines.get("gone.js").size, 0);
});

test("reviews everything again when the comparison answers 404", async () => {
  const history = await read({
    existingReviews: [ownReview(FIRST)],
    compare: () => apiFailure(404),
  });
  assert.equal(history.mode, "full");
  assert.equal(history.reason, FULL_REASONS.notComparable);
  assert.equal(history.newLines, null);
});

for (const status of ["diverged", "behind", "something-new", undefined]) {
  test(`reviews everything again when the comparison is ${status}`, async () => {
    const history = await read({
      existingReviews: [ownReview(FIRST)],
      compare: () => ({ status }),
    });
    assert.equal(history.mode, "full");
    assert.equal(history.reason, FULL_REASONS.notComparable);
  });
}

test("keeps the fingerprints when the whole pull request is reviewed again", async () => {
  const history = await read({
    existingReviews: [ownReview(FIRST)],
    existingComments: [ownComment(FP)],
    compare: () => ({ status: "diverged" }),
  });
  assert.equal(history.mode, "full");
  assert.ok(history.fingerprints.has(FP));
});

test("reviews everything again when GitHub does not list every file", async () => {
  const files = Array.from({ length: 3000 }, (_, index) =>
    comparedFile(`f${index}.js`, "@@ -0,0 +1 @@\n+x"),
  );
  const history = await read({
    existingReviews: [ownReview(FIRST)],
    compare: () => ahead(files),
  });
  assert.equal(history.mode, "full");
  assert.equal(history.reason, FULL_REASONS.incomplete);
});

test("has nothing new when the comparison lists no files at all", async () => {
  const history = await read({
    existingReviews: [ownReview(FIRST)],
    compare: () => ({ status: "ahead" }),
  });
  assert.equal(history.mode, "incremental");
  assert.equal(history.newLines.size, 0);
});

test("fails with a hint when the comparison is not allowed", async () => {
  await assert.rejects(
    read({
      existingReviews: [ownReview(FIRST)],
      compare: () => apiFailure(403),
    }),
    /HTTP 403.*contents: read/,
  );
});

test("fails when the comparison breaks for another reason", async () => {
  await assert.rejects(
    read({
      existingReviews: [ownReview(FIRST)],
      compare: () => apiFailure(500),
    }),
    /HTTP 500/,
  );
});

// --- errors when the history is read ------------------------------------------

test("fails with a hint when the reviews cannot be read", async () => {
  const octokit = createFakeOctokit([]);
  octokit.paginate = async () => {
    throw apiFailure(403);
  };
  await assert.rejects(
    readHistory(octokit, PULL_REQUEST),
    /HTTP 403.*`pull-requests` permission/,
  );
});

test("fails with a hint when the comments cannot be read", async () => {
  const octokit = createFakeOctokit([]);
  octokit.paginate = async (endpoint) => {
    if (endpoint === octokit.rest.pulls.listReviewComments) {
      throw apiFailure(404);
    }
    return [];
  };
  await assert.rejects(readHistory(octokit, PULL_REQUEST), /HTTP 404/);
});

// --- scopeDiffs() -------------------------------------------------------------

const diffOf = (path, patch) => ({ path, ...parsePatch(patch) });

test("keeps a file with a new line and lists only the lines that are new", () => {
  const diffs = [diffOf("a.js", "@@ -0,0 +1,3 @@\n+one\n+two\n+three")];
  const result = scopeDiffs(diffs, new Map([["a.js", new Set([3, 9])]]));
  assert.deepEqual(result.diffs, diffs);
  assert.deepEqual([...result.newLines.get("a.js")], [3]);
});

test("drops a file that the comparison does not list", () => {
  const diffs = [diffOf("a.js", "@@ -0,0 +1 @@\n+one")];
  const result = scopeDiffs(diffs, new Map());
  assert.deepEqual(result.diffs, []);
  assert.equal(result.newLines.size, 0);
});

test("drops a file whose changed lines are not part of the pull request", () => {
  // The comparison shows line 5, for example from a merge of the base branch.
  const diffs = [diffOf("a.js", "@@ -0,0 +1 @@\n+one")];
  const result = scopeDiffs(diffs, new Map([["a.js", new Set([5])]]));
  assert.deepEqual(result.diffs, []);
});

test("takes every added line of a file when the comparison cannot say more", () => {
  const diffs = [diffOf("a.js", "@@ -0,0 +1,2 @@\n+one\n+two")];
  const result = scopeDiffs(diffs, new Map([["a.js", null]]));
  assert.deepEqual([...result.newLines.get("a.js")], [1, 2]);
});

test("keeps the order of the files", () => {
  const diffs = ["c.js", "a.js", "b.js"].map((path) =>
    diffOf(path, "@@ -0,0 +1 @@\n+x"),
  );
  const result = scopeDiffs(
    diffs,
    new Map([
      ["a.js", null],
      ["b.js", null],
      ["c.js", null],
    ]),
  );
  assert.deepEqual(
    result.diffs.map((diff) => diff.path),
    ["c.js", "a.js", "b.js"],
  );
});

// --- Incomplete reviews, review texts and line endings -------------------------

test("does not start at a review that is marked incomplete", async () => {
  const history = await read({
    existingReviews: [
      ownReview(FIRST),
      ownReview(SECOND, {
        body: `${REVIEW_MARKER}
${INCOMPLETE_LINE}

### ReviewOps`,
      }),
    ],
    compare: () => ahead(),
  });
  assert.equal(history.since, FIRST);
});

test("reviews everything when the only earlier review is incomplete", async () => {
  const history = await read({
    existingReviews: [
      ownReview(FIRST, {
        body: `${REVIEW_MARKER}
${INCOMPLETE_LINE}`,
      }),
    ],
  });
  assert.equal(history.mode, "full");
  assert.equal(history.reason, FULL_REASONS.noReview);
});

test("reads the fingerprints below the marker of a review text", async () => {
  const history = await read({
    existingReviews: [
      ownReview(FIRST, {
        body: `${REVIEW_MARKER}
${INCOMPLETE_LINE}
${fingerprintLine(FP)}
${fingerprintLine(FP2)}

### ReviewOps`,
      }),
    ],
  });
  assert.deepEqual([...history.fingerprints].sort(), [FP, FP2].sort());
});

test("does not read a fingerprint or an incomplete note further down in a review text", async () => {
  const history = await read({
    existingReviews: [
      ownReview(FIRST, {
        body: `${REVIEW_MARKER}

### ReviewOps
${INCOMPLETE_LINE}
${fingerprintLine(FP)}`,
      }),
    ],
    compare: () => ahead(),
  });
  assert.equal(history.fingerprints.size, 0);
  assert.equal(history.since, FIRST);
});

test("reads the head of a body with Windows line endings", async () => {
  const history = await read({
    existingReviews: [
      ownReview(FIRST, {
        body: `${REVIEW_MARKER}
${INCOMPLETE_LINE}

text`,
      }),
      ownReview(SECOND),
    ],
    existingComments: [
      {
        body: `${REVIEW_MARKER}
${fingerprintLine(FP)}

text`,
        user: BOT,
      },
    ],
    compare: () => ahead(),
  });
  assert.ok(history.fingerprints.has(FP));
  assert.equal(history.since, SECOND);
});

test("reads a review that GitHub shows with Windows line endings as incomplete", async () => {
  const history = await read({
    existingReviews: [
      ownReview(FIRST),
      ownReview(SECOND, {
        body: `${REVIEW_MARKER}
${INCOMPLETE_LINE}
`,
      }),
    ],
    compare: () => ahead(),
  });
  assert.equal(history.since, FIRST);
});
