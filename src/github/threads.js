import { describeApiError } from "./api-error.js";

// GitHub returns at most 100 threads per page. A pull request with more than
// 3000 threads is not read to the end: the threads after that count as not
// resolved, so in doubt more findings stay open, never fewer.
const PAGE_SIZE = 100;
const MAX_PAGES = 30;

// A cursor is an opaque token of GitHub. Anything that does not look like one
// ends the reading instead of being sent back.
const CURSOR = /^[A-Za-z0-9+/=:_-]{1,200}$/;

// Only GraphQL can say whether a thread is resolved. The first comment of a
// thread is the comment that opened it; this action only ever opens threads.
const QUERY = `query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 1) {
            nodes {
              databaseId
              reactionGroups { content reactors { totalCount } }
            }
          }
        }
      }
    }
  }
}`;

/**
 * GitHub did not answer the query for the review threads. Only an answer of
 * the API (or a missing one) becomes this error; anything else is a defect
 * and is passed on as it is. `run()` can go on without the threads when no
 * `fail-on` depends on them.
 */
export class ThreadsUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ThreadsUnavailableError";
  }
}

const THREAD_HINTS = Object.freeze({
  403: "The token may not read the review threads of this pull request. The workflow needs the `pull-requests` permission.",
});

/**
 * Reads the review threads of a pull request: for the comment that opened a
 * thread, whether the thread is resolved and whether the comment carries a
 * thumbs down. REST knows neither, so this is a GraphQL query, and one query
 * answers both.
 *
 * Everything in the answer is untrusted: a thread counts as resolved only if
 * `isResolved` is exactly `true` and the id is a positive whole number, and
 * a comment has a thumbs down only if the reaction group `THUMBS_DOWN` has a
 * count above 0. Only the two truth values leave this function: never a
 * number of reactions, never who reacted. An answer of another shape ends
 * the reading, and the threads it did not name are missing from the result.
 *
 * Nothing in here writes to the log.
 *
 * @param {ReturnType<typeof import("@actions/github").getOctokit>} octokit
 * @param {{ owner: string, repo: string, pullNumber: number }} pullRequest
 * @returns {Promise<Map<number, { resolved: boolean, thumbsDown: boolean }>>}
 *   By the id of the first comment of a thread.
 * @throws {ThreadsUnavailableError} When GitHub does not answer the query,
 *   with a message that says what to do.
 */
export async function readThreadStates(octokit, { owner, repo, pullNumber }) {
  const states = new Map();
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let data;
    try {
      data = await octokit.graphql(QUERY, {
        owner,
        repo,
        number: pullNumber,
        cursor,
      });
    } catch (error) {
      throw describeThreadError(error);
    }

    const threads = data?.repository?.pullRequest?.reviewThreads;
    if (!Array.isArray(threads?.nodes)) break;
    for (const thread of threads.nodes) {
      const comment = thread?.comments?.nodes?.[0];
      const id = comment?.databaseId;
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      states.set(id, {
        resolved: thread.isResolved === true,
        thumbsDown: hasThumbsDown(comment.reactionGroups),
      });
    }

    const next = threads.pageInfo;
    const usable =
      typeof next?.endCursor === "string" && CURSOR.test(next.endCursor);
    if (next?.hasNextPage !== true || !usable) break;
    cursor = next.endCursor;
  }
  return states;
}

/**
 * Reads which review threads of a pull request are resolved and returns the
 * ids of the comments that opened them.
 *
 * @param {ReturnType<typeof import("@actions/github").getOctokit>} octokit
 * @param {{ owner: string, repo: string, pullNumber: number }} pullRequest
 * @returns {Promise<Set<number>>}
 * @throws {ThreadsUnavailableError} See {@link readThreadStates}.
 */
export async function readResolvedComments(octokit, pullRequest) {
  return resolvedOf(await readThreadStates(octokit, pullRequest));
}

/** The ids of the comments whose thread is resolved. */
export function resolvedOf(states) {
  return new Set(
    [...states].filter(([, { resolved }]) => resolved).map(([id]) => id),
  );
}

function hasThumbsDown(groups) {
  return (
    Array.isArray(groups) &&
    groups.some(
      (group) =>
        group?.content === "THUMBS_DOWN" &&
        Number.isSafeInteger(group.reactors?.totalCount) &&
        group.reactors.totalCount > 0,
    )
  );
}

/**
 * An error of the query. GitHub can answer a GraphQL query with status 200
 * and a list of errors; their text is not taken over, it may repeat parts of
 * the query.
 */
function describeThreadError(error) {
  if (Number.isInteger(error?.status)) {
    const described = describeApiError(error, THREAD_HINTS);
    return new ThreadsUnavailableError(described.message, { cause: error });
  }
  if (Array.isArray(error?.errors)) {
    return new ThreadsUnavailableError(
      "GitHub did not answer the query for the review threads of this pull request. Run the workflow again later.",
    );
  }
  return error;
}
