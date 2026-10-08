import { SEVERITIES } from "../ai/schema.js";
import { PatchFormatError, parsePatch } from "../diff/parse.js";
import { FINGERPRINT_LENGTH } from "../fingerprint.js";
import { describeApiError } from "./api-error.js";
import { INCOMPLETE_LINE, REVIEW_MARKER } from "./review.js";

const COMMIT_SHA = /^[0-9a-f]{40}$/;

// The second line of an inline comment of this action. Only this exact shape
// is read; anything else in a comment is ignored. An inline comment adds the
// severity of its finding; the line in the text of a review has none.
const FINGERPRINT_LINE = new RegExp(
  `^<!-- reviewops-fingerprint: ([0-9a-f]{${FINGERPRINT_LENGTH}})(?: severity: (${SEVERITIES.join("|")}))? -->$`,
);

// A comparison lists at most this many files, 100 per request.
const COMPARE_PAGE_SIZE = 100;
const COMPARE_FILE_LIMIT = 3000;

// The statuses of a comparison where only new commits were added.
const AHEAD = "ahead";
const IDENTICAL = "identical";

// Statuses of a file where a missing patch means the content is the same.
const STATUSES_WITHOUT_CONTENT_CHANGE = new Set([
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);

// What a 403 or a 404 means when the earlier reviews are read.
const LIST_HINTS = Object.freeze({
  403: "The token may not read this pull request. The workflow needs the `pull-requests` permission.",
  404: "The pull request was not found, or the token has no access to the repository.",
});

const COMPARE_HINTS = Object.freeze({
  403: "The token may not read the commits of this repository. The workflow needs the `contents: read` permission.",
});

/** Why a run reviews the whole pull request instead of the new lines. */
export const FULL_REASONS = Object.freeze({
  noReview: "there is no earlier review of ReviewOps",
  notComparable:
    "the commit of the earlier review is no longer part of this branch (force-push or rebase)",
  incomplete:
    "GitHub did not list every file of the comparison with the earlier commit",
});

/**
 * Tells whether GitHub shows an account as an automation account. Only such
 * accounts count as the author of an earlier review: a person, who could
 * copy the marker into a comment, is never read.
 *
 * @param {{ user?: { type?: unknown } | null }} item
 */
const isBot = (item) => item?.user?.type === "Bot";

/** A review or a comment that this action posted: the marker and a bot. */
const isOwn = (item) =>
  isBot(item) &&
  typeof item.body === "string" &&
  item.body.startsWith(REVIEW_MARKER);

/**
 * Reads what ReviewOps already did on this pull request, so a new run does
 * not repeat it.
 *
 * - The reviews of this action are the ones with the marker at the start of
 *   their text and a bot as author. The `commit_id` of the newest one is the
 *   last commit that was reviewed.
 * - The fingerprints come from the second line of every inline comment of
 *   this action, including old and resolved ones.
 * - The lines that are new since the last reviewed commit come from a
 *   comparison of that commit with the head. Whenever that does not work
 *   out, the whole pull request is reviewed again: when in doubt, more is
 *   checked, never less.
 *
 * Nothing in here writes to the log or posts anything. Everything read from
 * GitHub is untrusted: a body is only checked against fixed patterns.
 *
 * @param {ReturnType<typeof import("@actions/github").getOctokit>} octokit
 * @param {{ owner: string, repo: string, pullNumber: number, headSha: string }} pullRequest
 * @param {object} [options]
 * @param {boolean} [options.compare] Compare the last reviewed commit with
 *   the head. Off for a run that reviews nothing (a closed pull request): it
 *   needs the earlier comments only, so the request is saved and the result
 *   is always `full`.
 * @returns {Promise<{
 *   mode: "full" | "incremental",
 *   since: string | null,
 *   reason: string | null,
 *   newLines: Map<string, Set<number> | null> | null,
 *   fingerprints: Set<string>,
 *   ownReviews: number,
 *   ownComments: number,
 *   earlierFindings: { id: number, fingerprint: string, severity: string }[],
 *   inlineComments: { id: number, path: string, fingerprint: string }[],
 * }>} `earlierFindings` are the own inline comments that name the severity
 *   of their finding, with the id GitHub gave them. In `incremental` mode, `since` is the last reviewed commit and
 *   `newLines` holds the added lines of the comparison by path. `null` as
 *   the value of a path stands for every line of that file. A path that is
 *   missing has no new line. In `full` mode, `newLines` is `null` and
 *   `reason` is one of {@link FULL_REASONS}.
 */
export async function readHistory(
  octokit,
  pullRequest,
  { compare: withComparison = true } = {},
) {
  const { owner, repo, pullNumber } = pullRequest;
  const listParameters = {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  };

  let reviews;
  let comments;
  try {
    reviews = await octokit.paginate(
      octokit.rest.pulls.listReviews,
      listParameters,
    );
    comments = await octokit.paginate(
      octokit.rest.pulls.listReviewComments,
      listParameters,
    );
  } catch (error) {
    throw describeApiError(error, LIST_HINTS);
  }

  const ownReviews = reviews.filter(isOwn);
  const ownComments = comments.filter(isOwn);
  const fingerprints = new Set();
  for (const item of [...ownComments, ...ownReviews]) {
    for (const { fingerprint } of readHead(item.body).fingerprints) {
      fingerprints.add(fingerprint);
    }
  }

  // The findings of earlier inline comments, for the count of the findings
  // that are still open. An inline comment has one fingerprint line; a
  // comment from before the severity was written there is left out.
  const earlierFindings = [];
  for (const comment of ownComments) {
    const [head] = readHead(comment.body).fingerprints;
    if (head?.severity && Number.isSafeInteger(comment.id) && comment.id > 0) {
      earlierFindings.push({ id: comment.id, ...head });
    }
  }

  // Every own inline comment with a fingerprint, whatever its severity, for
  // the status report (#77). The path is the one GitHub names for the comment.
  const inlineComments = [];
  for (const comment of ownComments) {
    const [head] = readHead(comment.body).fingerprints;
    if (
      head &&
      Number.isSafeInteger(comment.id) &&
      comment.id > 0 &&
      typeof comment.path === "string" &&
      comment.path !== ""
    ) {
      inlineComments.push({
        id: comment.id,
        path: comment.path,
        fingerprint: head.fingerprint,
      });
    }
  }

  const base = {
    fingerprints,
    ownReviews: ownReviews.length,
    ownComments: ownComments.length,
    earlierFindings,
    inlineComments,
  };
  const full = (reason) => ({
    ...base,
    mode: "full",
    since: null,
    reason,
    newLines: null,
  });

  const since = lastReviewedCommit(ownReviews);
  if (since === null || !withComparison) return full(FULL_REASONS.noReview);

  // The head was reviewed already: nothing is new, and nothing is compared.
  if (since === pullRequest.headSha) {
    return {
      ...base,
      mode: "incremental",
      since,
      reason: null,
      newLines: new Map(),
    };
  }

  const comparison = await compare(octokit, pullRequest, since);
  if (comparison.status === "not-comparable") {
    return full(FULL_REASONS.notComparable);
  }
  if (comparison.status === "incomplete") return full(FULL_REASONS.incomplete);
  return {
    ...base,
    mode: "incremental",
    since,
    reason: null,
    newLines: comparison.newLines,
  };
}

/**
 * Keeps the files with at least one new line and says which lines are new:
 * the added lines of the pull request that the comparison shows as added as
 * well. A line that only came with a merge of the base branch is not in the
 * comparison of the pull request's own diff, so it drops out.
 *
 * @template {{ path: string, commentableLines: number[] }} T
 * @param {T[]} diffs The parsed files of the pull request.
 * @param {Map<string, Set<number> | null>} newLines `newLines` of
 *   {@link readHistory}.
 * @returns {{ diffs: T[], newLines: Map<string, Set<number>> }}
 */
export function scopeDiffs(diffs, newLines) {
  const kept = [];
  const lines = new Map();
  for (const diff of diffs) {
    const compared = newLines.get(diff.path);
    if (compared === undefined) continue;
    const fresh =
      compared === null
        ? diff.commentableLines
        : diff.commentableLines.filter((line) => compared.has(line));
    if (fresh.length === 0) continue;
    kept.push(diff);
    lines.set(diff.path, new Set(fresh));
  }
  return { diffs: kept, newLines: lines };
}

/**
 * The lines right below the marker of a body of this action: the fingerprints
 * and the note of an incomplete review. The first line that is neither ends
 * the head, so the text further down, which comes from the model, is never
 * read. Both kinds of line ending are accepted: GitHub keeps the ones of an
 * edit.
 *
 * @param {string} body
 * @returns {{
 *   fingerprints: { fingerprint: string, severity: string | null }[],
 *   incomplete: boolean,
 * }}
 */
function readHead(body) {
  const result = { fingerprints: [], incomplete: false };
  for (const line of body.split(/\r?\n/, 40).slice(1)) {
    const match = FINGERPRINT_LINE.exec(line);
    if (match) {
      result.fingerprints.push({
        fingerprint: match[1],
        severity: match[2] ?? null,
      });
    } else if (line === INCOMPLETE_LINE) result.incomplete = true;
    else break;
  }
  return result;
}

/** `commit_id` of the newest complete review in the list, or `null`. */
function lastReviewedCommit(ownReviews) {
  // GitHub lists reviews from the oldest to the newest. A review that was
  // never submitted is not a finished review, and neither is one that left
  // files or lines out: a later run has to look at those again.
  for (const review of ownReviews.toReversed()) {
    if (review.state === "PENDING") continue;
    if (readHead(review.body).incomplete) continue;
    if (
      typeof review.commit_id === "string" &&
      COMMIT_SHA.test(review.commit_id)
    ) {
      return review.commit_id;
    }
  }
  return null;
}

/**
 * Compares the last reviewed commit with the head.
 *
 * @returns {Promise<
 *   | { status: "ok", newLines: Map<string, Set<number> | null> }
 *   | { status: "not-comparable" }
 *   | { status: "incomplete" }
 * >}
 */
async function compare(octokit, { owner, repo, headSha }, since) {
  const files = [];
  let page = 1;
  for (;;) {
    let data;
    try {
      ({ data } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${since}...${headSha}`,
        per_page: COMPARE_PAGE_SIZE,
        page,
      }));
    } catch (error) {
      // The commit is gone after a force-push: that is no failure.
      if (error?.status === 404) return { status: "not-comparable" };
      throw describeApiError(error, COMPARE_HINTS);
    }

    // Only a comparison that adds commits to the earlier state tells what is
    // new. After a rebase or a force-push, the earlier commit is not an
    // ancestor ("diverged" or "behind").
    if (page === 1) {
      if (data?.status === IDENTICAL)
        return { status: "ok", newLines: new Map() };
      if (data?.status !== AHEAD) return { status: "not-comparable" };
    }
    if (!Array.isArray(data?.files)) return { status: "incomplete" };

    files.push(...data.files);
    if (files.length >= COMPARE_FILE_LIMIT) return { status: "incomplete" };
    if (data.files.length < COMPARE_PAGE_SIZE) break;
    page += 1;
  }

  const newLines = new Map();
  for (const file of files) {
    if (typeof file?.filename !== "string" || file.filename === "") {
      return { status: "incomplete" };
    }
    newLines.set(file.filename, addedLinesOfComparison(file));
  }
  return { status: "ok", newLines };
}

/**
 * The added lines of one file of a comparison. `null` means every line: the
 * file has a change that shows no readable patch, so nothing can be ruled
 * out.
 */
function addedLinesOfComparison(file) {
  if (file.status === "removed") return new Set();
  if (typeof file.patch === "string" && file.patch !== "") {
    try {
      return new Set(parsePatch(file.patch).commentableLines);
    } catch (error) {
      if (!(error instanceof PatchFormatError)) throw error;
      return null;
    }
  }
  const unchanged =
    STATUSES_WITHOUT_CONTENT_CHANGE.has(file.status) && !file.changes;
  return unchanged ? new Set() : null;
}
