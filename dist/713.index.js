export const id = 713;
export const ids = [713];
export const modules = {

/***/ 7713:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {


// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  run: () => (/* binding */ run)
});

// EXTERNAL MODULE: ./node_modules/@actions/core/lib/core.js + 18 modules
var lib_core = __webpack_require__(6257);
// EXTERNAL MODULE: ./node_modules/@actions/github/lib/github.js + 22 modules
var github = __webpack_require__(2413);
;// CONCATENATED MODULE: ./src/github/context.js
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
function readPullRequest(context) {
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

;// CONCATENATED MODULE: ./src/github/files.js
// GitHub lists at most this many files for one pull request.
const API_FILE_LIMIT = 3000;

const SKIP_REASONS = Object.freeze({
  removed: "the file was deleted",
  unchanged: "no content change (rename or mode change only)",
  noPatch: "no text diff (binary file or diff too large)",
});

// Statuses where a missing patch means the content is the same as before.
const STATUSES_WITHOUT_CONTENT_CHANGE = new Set([
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);

/**
 * Loads the changed files of a pull request from the GitHub API.
 *
 * The diff comes from the API only. Nothing here reads the working tree, so
 * the action does not need a checkout of the repository it reviews.
 *
 * @param {ReturnType<typeof import("@actions/github").getOctokit>} octokit
 * @param {{ owner: string, repo: string, pullNumber: number }} pullRequest
 * @returns {Promise<{
 *   files: { path: string, status: string, additions: number, deletions: number, patch: string }[],
 *   skipped: { path: string, reason: string }[],
 *   truncated: boolean,
 * }>} `truncated` is true when GitHub's limit was reached and files are missing.
 */
async function listChangedFiles(octokit, { owner, repo, pullNumber }) {
  let entries;
  try {
    entries = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
  } catch (error) {
    throw describeApiError(error);
  }

  const files = [];
  const skipped = [];
  for (const entry of entries) {
    if (typeof entry?.filename !== "string" || entry.filename === "") {
      throw new Error("GitHub returned a changed file without a name.");
    }

    const reason = skipReason(entry);
    if (reason) {
      skipped.push({ path: entry.filename, reason });
    } else {
      files.push({
        path: entry.filename,
        status: entry.status,
        additions: Number(entry.additions) || 0,
        deletions: Number(entry.deletions) || 0,
        patch: entry.patch,
      });
    }
  }

  return { files, skipped, truncated: entries.length >= API_FILE_LIMIT };
}

function skipReason(entry) {
  if (entry.status === "removed") return SKIP_REASONS.removed;
  if (typeof entry.patch === "string" && entry.patch !== "") return null;

  const contentIsUnchanged =
    STATUSES_WITHOUT_CONTENT_CHANGE.has(entry.status) && !entry.changes;
  return contentIsUnchanged ? SKIP_REASONS.unchanged : SKIP_REASONS.noPatch;
}

/**
 * Turns a failed API request into an error that names the HTTP status and
 * says what to do. The original error stays attached as `cause`.
 */
function describeApiError(error) {
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
    `GitHub API request failed (HTTP ${status}). ${hintFor(status, error)}`,
    { cause: error },
  );
}

function hintFor(status, error) {
  if (status === 401) {
    return "The token was rejected. Check the `github-token` input.";
  }
  if (status === 429 || (status === 403 && isRateLimited(error))) {
    return "The rate limit of the token is used up. Run the workflow again later.";
  }
  if (status === 403) {
    return "The token may not read this pull request. The workflow needs the `pull-requests` permission.";
  }
  if (status === 404) {
    return "The pull request was not found, or the token has no access to the repository.";
  }
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

;// CONCATENATED MODULE: ./src/inputs.js
/**
 * Reads the action inputs and masks the credentials right away.
 *
 * Nothing is validated here on purpose: the values must be masked before
 * any check can fail and produce a message.
 *
 * @param {typeof import("@actions/core")} core
 * @returns {{ githubToken: string, openaiApiKey: string }}
 */
function readInputs(core) {
  const inputs = {
    githubToken: core.getInput("github-token"),
    openaiApiKey: core.getInput("openai-api-key"),
  };

  for (const secret of Object.values(inputs)) {
    if (secret) core.setSecret(secret);
  }

  return inputs;
}

/**
 * Rejects missing inputs with a message that says what to do.
 *
 * @param {{ githubToken: string, openaiApiKey: string }} inputs
 */
function assertInputs(inputs) {
  if (!inputs.openaiApiKey) {
    throw new Error(
      "Input `openai-api-key` is missing. Store the key as a repository secret and pass it to the action, for example `openai-api-key: ${{ secrets.OPENAI_API_KEY }}`.",
    );
  }
  if (!inputs.githubToken) {
    throw new Error(
      "Input `github-token` is empty. Remove it from the workflow to use the token of the workflow run, or pass a valid token.",
    );
  }
}

;// CONCATENATED MODULE: ./src/printable.js
const MAX_LENGTH = 200;

// \p{Cc}: control characters, including line breaks.
// \p{Cf}: invisible format characters, which can reorder what a reader sees.
// \p{Zl}, \p{Zp}: the Unicode line and paragraph separators.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Makes text from outside safe to write into the log on one line.
 *
 * File names and similar values come from the author of the pull request.
 * A line break in such a value could start a new log line with a workflow
 * command such as `::error::`. Unsafe characters are therefore shown by
 * their code point, a line feed for example as backslash-u-000a, instead of
 * being written out.
 *
 * @param {unknown} text
 * @returns {string}
 */
function printable(text) {
  const visible = String(text).replace(
    UNSAFE,
    (character) =>
      `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
  );
  return visible.length > MAX_LENGTH
    ? `${visible.slice(0, MAX_LENGTH)}…`
    : visible;
}

;// CONCATENATED MODULE: ./src/redact.js
const PLACEHOLDER = "***";

// Real tokens and API keys are far longer. A shorter value cannot be a
// credential, and replacing it would tear ordinary words apart.
const MIN_SECRET_LENGTH = 8;

/**
 * Builds a function that replaces every known secret in a text.
 *
 * The runner masks secrets in the log, but only there. Redacting the text
 * itself also protects places the mask never sees, such as review comments.
 *
 * @param {unknown[]} secrets Values to hide. Non-string values and values
 *   shorter than eight characters are ignored.
 * @returns {(text: unknown) => string}
 */
function createRedactor(secrets) {
  const known = secrets
    .filter(
      (secret) =>
        typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH,
    )
    // Longest first, so a secret that contains another one is replaced as a whole.
    .sort((a, b) => b.length - a.length);

  return (text) =>
    known.reduce(
      (result, secret) => result.replaceAll(secret, PLACEHOLDER),
      String(text),
    );
}

;// CONCATENATED MODULE: ./src/main.js








// `pull_request_target` is left out on purpose: it hands secrets and a write
// token to pull requests from forks.
const SUPPORTED_EVENT = "pull_request";

// A pull request can skip thousands of files, for example when it deletes a
// directory. The log names the first ones and counts the rest.
const MAX_SKIPPED_LINES = 50;

/**
 * Runs the action. Every failure inside ends in `core.setFailed()`.
 *
 * Loading this module can fail as well: `@actions/github` parses the event
 * file while it loads. `src/index.js` catches that case.
 *
 * @param {object} [deps] Replacements for the runner modules, used by tests.
 * @param {typeof import("@actions/core")} [deps.core]
 * @param {typeof import("@actions/github").context} [deps.context]
 * @param {typeof import("@actions/github").getOctokit} [deps.getOctokit]
 */
async function run({
  core = lib_core,
  context = github/* context */._,
  getOctokit = github/* getOctokit */.Q,
} = {}) {
  let redact = String;

  try {
    if (context.eventName !== SUPPORTED_EVENT) {
      core.notice(
        `ReviewOps runs only on the "${SUPPORTED_EVENT}" event. This run was triggered by "${context.eventName ?? "unknown"}" and was skipped.`,
      );
      return;
    }

    const inputs = readInputs(core);
    redact = createRedactor(Object.values(inputs));
    assertInputs(inputs);

    core.info("ReviewOps started.");

    // Only checked values reach the log: the title of the pull request is
    // written by its author and stays out.
    const pullRequest = readPullRequest(context);
    core.info(
      `Reviewing ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.pullNumber} at commit ${pullRequest.headSha}.`,
    );

    const octokit = getOctokit(inputs.githubToken);
    const { files, skipped, truncated } = await listChangedFiles(
      octokit,
      pullRequest,
    );
    core.info(
      `Found ${files.length + skipped.length} changed files: ${files.length} to review, ${skipped.length} skipped.`,
    );
    // File names are chosen by the author of the pull request.
    for (const { path, reason } of skipped.slice(0, MAX_SKIPPED_LINES)) {
      core.info(`Skipped ${printable(path)}: ${reason}.`);
    }
    if (skipped.length > MAX_SKIPPED_LINES) {
      core.info(
        `${skipped.length - MAX_SKIPPED_LINES} more skipped files are not listed.`,
      );
    }
    if (truncated) {
      core.warning(
        "GitHub lists at most 3000 files per pull request. Files beyond that were not loaded.",
      );
    }
  } catch (error) {
    // Mark the step as failed first: nothing below may prevent that.
    core.setFailed(redact(describe(error)));

    try {
      if (error instanceof Error && error.stack) {
        core.debug(redact(error.stack));
      }
      if (error?.cause instanceof Error) {
        core.debug(redact(`Caused by: ${error.cause.message}`));
      }
    } catch {
      // A broken debug log must not hide the failure reported above.
    }
  }
}

/** Turns anything that was thrown into a message a person can act on. */
function describe(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string" && error.trim()) return error;
  return "ReviewOps failed without an error message.";
}


/***/ })

};
