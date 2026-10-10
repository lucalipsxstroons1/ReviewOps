import { describeApiError } from "./api-error.js";

// `viewer` is the account of the token of this run: `github-actions[bot]` for
// the `GITHUB_TOKEN`, the app for an app token, the owner for a PAT. Its
// `databaseId` is the same number REST names as `user.id` and does not change
// when the account is renamed.
const QUERY = `query { viewer { databaseId } }`;

/**
 * GitHub did not tell which account the token belongs to. Only an answer of
 * the API (or a missing one, or one of another shape) becomes this error;
 * anything else is a defect and is passed on as it is.
 */
export class IdentityUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "IdentityUnavailableError";
  }
}

const IDENTITY_HINTS = Object.freeze({
  403: "The token may not read its own account. Check the `github-token` input.",
});

/**
 * Reads the id of the account that the token of this run belongs to. A review
 * or a comment is the action's own only if its author has this id.
 *
 * The answer is untrusted: only a positive whole number is accepted. Nothing
 * from the answer is put into a message, and nothing in here writes to the
 * log.
 *
 * @param {ReturnType<typeof import("@actions/github").getOctokit>} octokit
 * @returns {Promise<number>}
 * @throws {IdentityUnavailableError} When GitHub does not answer the query
 *   or the answer holds no usable id, with a message that says what to do.
 */
export async function readOwnAccountId(octokit) {
  let data;
  try {
    data = await octokit.graphql(QUERY);
  } catch (error) {
    throw describeIdentityError(error);
  }

  const id = data?.viewer?.databaseId;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new IdentityUnavailableError(
      "GitHub did not name the account of the token, so ReviewOps cannot tell its own reviews from others. Run the workflow again later.",
    );
  }
  return id;
}

/**
 * An error of the query. GitHub can answer a GraphQL query with status 200
 * and a list of errors; their text is not taken over, it may repeat parts of
 * the query.
 */
function describeIdentityError(error) {
  if (Number.isInteger(error?.status)) {
    const described = describeApiError(error, IDENTITY_HINTS);
    return new IdentityUnavailableError(described.message, { cause: error });
  }
  if (Array.isArray(error?.errors)) {
    return new IdentityUnavailableError(
      "GitHub did not answer the query for the account of the token, so ReviewOps cannot tell its own reviews from others. Run the workflow again later.",
    );
  }
  return error;
}
