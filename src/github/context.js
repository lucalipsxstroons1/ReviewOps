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

// The login of the account that GitHub gives to runs started by Dependabot.
const DEPENDABOT = "dependabot[bot]";

/**
 * Says why the repository secrets are not available in this run, if the
 * event itself explains it. GitHub does not pass secrets to workflows of pull
 * requests from forks, and it gives runs started by Dependabot only the
 * Dependabot secrets. In both cases an empty API key is not a mistake of the
 * workflow, and ReviewOps ends with a notice instead of an error.
 *
 * A pull request that is not a fork and not started by Dependabot never
 * gets an explanation: there, an empty key stays an error.
 *
 * Nothing in the text comes from the event.
 *
 * @param {{ actor?: string, repo: object, payload: object }} context
 * @returns {string | null} A notice, or `null` if there is no explanation.
 */
export function explainMissingSecret(context) {
  let isFork = false;
  try {
    isFork = readPullRequest(context).isFork;
  } catch {
    // A payload that cannot be read is no explanation. The run fails later
    // with the message that says what is wrong with it.
  }

  if (isFork) {
    return "ReviewOps did not review this pull request: it comes from a fork, and GitHub does not pass secrets to workflows of such pull requests, so the OpenAI API key is not available. A green run does not mean that this pull request was reviewed.";
  }
  if (context.actor === DEPENDABOT) {
    return "ReviewOps did not review this pull request: the run was started by Dependabot, and GitHub gives runs of Dependabot only the Dependabot secrets, not the repository secrets. To have these pull requests reviewed, store the key as a Dependabot secret named `OPENAI_API_KEY` as well. A green run does not mean that this pull request was reviewed.";
  }
  return null;
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

/**
 * Reads which run of the workflow this is: `GITHUB_RUN_ID` and
 * `GITHUB_RUN_ATTEMPT`. `@actions/github` gives `NaN` for a variable that is
 * not set. Both must be safe integers from 1, and the message never repeats
 * the value it read.
 *
 * @param {{ runId?: number, runAttempt?: number }} context
 * @returns {{ runId: number, runAttempt: number }}
 */
export function readRun(context) {
  return {
    runId: readCounter(context.runId, "GITHUB_RUN_ID"),
    runAttempt: readCounter(context.runAttempt, "GITHUB_RUN_ATTEMPT"),
  };
}

function readCounter(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} is not a valid run number.`);
  }
  return value;
}

/**
 * Reads whether the pull request of the event is open, merged or closed
 * without a merge: `state` and `merged` of the payload. Anything that is not
 * exactly `closed` counts as open, so an odd payload never switches a review
 * off. Only fixed words come out, never a value of the payload.
 *
 * @param {{ payload?: object }} context
 * @returns {"open" | "merged" | "closed"}
 */
export function readPullRequestState(context) {
  const pullRequest = context.payload?.pull_request;
  if (!isObject(pullRequest) || pullRequest.state !== "closed") return "open";
  return pullRequest.merged === true ? "merged" : "closed";
}
