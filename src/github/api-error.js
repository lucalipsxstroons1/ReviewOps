/**
 * Turns a failed request to the GitHub API into an error that names the HTTP
 * status and says what to do. The original error stays attached as `cause`.
 *
 * What a 403 or a 404 means depends on the request: reading the files of a
 * pull request needs other permissions than posting a review. The caller
 * passes these hints. A rate limit is recognised before them, because GitHub
 * also answers it with 403.
 *
 * @param {unknown} error What Octokit threw.
 * @param {Record<number, string>} [hints] Hints by HTTP status.
 * @returns {unknown} A new error, or the original one when it is not an
 *   answer of the API.
 */
export function describeApiError(error, hints = {}) {
  const status = error?.status;
  if (!Number.isInteger(status)) return error;

  // Octokit reports a failed connection as status 500 without a response.
  // Naming an HTTP status would claim an answer that never came.
  if (!error.response) {
    return new Error(
      "GitHub could not be reached. Check the network of the runner and run the workflow again.",
      { cause: error },
    );
  }

  return new Error(
    `GitHub API request failed (HTTP ${status}). ${hintFor(status, error, hints)}`,
    { cause: error },
  );
}

function hintFor(status, error, hints) {
  if (status === 401) {
    return "The token was rejected. Check the `github-token` input.";
  }
  if (status === 429 || (status === 403 && isRateLimited(error))) {
    return "The rate limit of the token is used up. Run the workflow again later.";
  }
  if (Object.hasOwn(hints, status)) return hints[status];
  if (status >= 500) {
    return "GitHub could not answer the request. Run the workflow again later.";
  }
  return "Turn on debug logging to see the answer from GitHub.";
}

function isRateLimited(error) {
  const headers = error.response?.headers ?? {};
  return (
    headers["x-ratelimit-remaining"] === "0" ||
    "retry-after" in headers ||
    /rate limit/i.test(String(error.message))
  );
}
