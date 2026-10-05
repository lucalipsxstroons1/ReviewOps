const COMMIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

/**
 * Extracts what the action needs to know about the pull request that
 * triggered the run.
 *
 * Everything in the event payload is checked before it is used. Error
 * messages never repeat a value from the payload: parts of it are written by
 * the author of the pull request.
 *
 * @param {{ repo: { owner: string, repo: string }, payload: object }} context
 *   The context of the run, as provided by `@actions/github`.
 * @returns {{
 *   owner: string, repo: string, pullNumber: number,
 *   headSha: string, baseSha: string, title: string,
 *   isFork: boolean, isDraft: boolean,
 * }}
 */
export function readPullRequest(context) {
  const pullRequest = context.payload?.pull_request;
  if (!isObject(pullRequest)) {
    throw new Error(
      "The event carries no pull request. ReviewOps has to run on the `pull_request` event.",
    );
  }

  const { owner, repo } = readRepository(context);

  const pullNumber = pullRequest.number;
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    throw new Error("The event has no valid pull request number.");
  }

  // The base repository is the one the workflow runs in. A head repository
  // that differs, or that was deleted, makes the pull request a fork.
  const headRepository = pullRequest.head?.repo?.full_name;
  const isFork =
    typeof headRepository !== "string" ||
    headRepository.toLowerCase() !== `${owner}/${repo}`.toLowerCase();

  return {
    owner,
    repo,
    pullNumber,
    // The last commit of the pull request branch. GITHUB_SHA would be the
    // temporary merge commit, which GitHub does not accept for review comments.
    headSha: readSha(pullRequest.head?.sha, "head"),
    baseSha: readSha(pullRequest.base?.sha, "base"),
    title: typeof pullRequest.title === "string" ? pullRequest.title : "",
    isFork,
    isDraft: pullRequest.draft === true,
  };
}

function readRepository(context) {
  const { owner, repo } = context.repo ?? {};
  if (!isRepositoryPart(owner) || !isRepositoryPart(repo)) {
    throw new Error(
      "The repository of this run could not be determined from GITHUB_REPOSITORY.",
    );
  }
  return { owner, repo };
}

function readSha(value, side) {
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) {
    throw new Error(`The event has no valid ${side} commit SHA.`);
  }
  return value;
}

const isObject = (value) => typeof value === "object" && value !== null;

const isRepositoryPart = (value) =>
  typeof value === "string" && REPOSITORY_PART.test(value);
