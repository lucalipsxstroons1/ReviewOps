import * as actionsCore from "@actions/core";
import {
  context as actionsContext,
  getOctokit as actionsGetOctokit,
} from "@actions/github";
import { parseModel } from "./ai/model.js";
import {
  PatchFormatError,
  parsePatch as diffParsePatch,
} from "./diff/parse.js";
import { createExcludeFilter } from "./exclude.js";
import { readPullRequest } from "./github/context.js";
import { listChangedFiles } from "./github/files.js";
import { assertInputs, readInputs, secretsOf } from "./inputs.js";
import { applyLimits, parseLimits } from "./limits.js";
import { printable } from "./printable.js";
import { createRedactor } from "./redact.js";

// `pull_request_target` is left out on purpose: it hands secrets and a write
// token to pull requests from forks.
const SUPPORTED_EVENT = "pull_request";

// A pull request can skip thousands of files, for example when it deletes a
// directory. The log names the first ones and counts the rest.
const MAX_SKIPPED_LINES = 50;

const UNREADABLE_DIFF = "the diff could not be read";

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
 * @param {typeof import("./diff/parse.js").parsePatch} [deps.parsePatch]
 */
export async function run({
  core = actionsCore,
  context = actionsContext,
  getOctokit = actionsGetOctokit,
  parsePatch = diffParsePatch,
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
    redact = createRedactor(secretsOf(inputs));
    assertInputs(inputs);
    // A pattern, a limit or a model name that cannot be used fails the run
    // here, before any request. The model is handed to the AI client later.
    const excludeReason = createExcludeFilter(inputs.exclude);
    const limits = parseLimits(inputs);
    parseModel(inputs.openaiModel);

    core.info("ReviewOps started.");

    // Only checked values reach the log: the title of the pull request is
    // written by its author and stays out.
    const pullRequest = readPullRequest(context);
    core.info(
      `Reviewing ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.pullNumber} at commit ${pullRequest.headSha}.`,
    );

    const octokit = getOctokit(inputs.githubToken);
    const listing = await listChangedFiles(octokit, pullRequest);

    // Generated and irrelevant files are left out before anything is parsed.
    const relevant = [];
    const excluded = [];
    for (const file of listing.files) {
      const reason = excludeReason(file.path);
      if (reason) excluded.push({ path: file.path, reason });
      else relevant.push(file);
    }

    // Line numbers are calculated here and never taken from the model.
    const { diffs, unreadable } = parseDiffs(relevant, parsePatch);

    // Large pull requests are cut to the limits, in the order of GitHub.
    const { selected, overLimit, usedChars } = applyLimits(diffs, limits);

    // The list below is cut off, so the order matters: unreadable diffs and
    // files that the limits left out are the ones someone has to look at,
    // excluded files are a decision of this action, the rest could not be
    // reviewed anyway.
    const skipped = [
      ...unreadable.map(({ path }) => ({ path, reason: UNREADABLE_DIFF })),
      ...overLimit,
      ...excluded,
      ...listing.skipped,
    ];
    core.info(
      `Found ${selected.length + skipped.length} changed files: ${selected.length} to review, ${skipped.length} skipped.`,
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
    if (unreadable.length > 0) {
      core.warning(
        `Diffs that could not be read: ${unreadable.length}. These files are not reviewed.`,
      );
      for (const { path, detail } of unreadable) {
        core.debug(`${printable(path)}: ${detail}`);
      }
    }
    if (overLimit.length > 0) {
      core.warning(
        `Files left out because of the limits: ${overLimit.length}. They are not reviewed. The limits are max-files: ${limits.maxFiles} and max-diff-chars: ${limits.maxDiffChars}.`,
      );
    }
    if (listing.truncated) {
      core.warning(
        "GitHub lists at most 3000 files per pull request. Files beyond that were not loaded.",
      );
    }

    // Everything that costs money or posts something comes after this
    // point: a pull request without reviewable files ends here.
    if (selected.length === 0) {
      core.notice(
        "ReviewOps found no files to review in this pull request. The log lists the skipped files.",
      );
      return;
    }

    const addedLines = selected.reduce(
      (sum, diff) => sum + diff.commentableLines.length,
      0,
    );
    core.info(
      `Parsed the diffs of ${selected.length} files: ${addedLines} added lines can receive comments.`,
    );
    core.info(`Diff size: ${usedChars} of ${limits.maxDiffChars} characters.`);
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

/**
 * Parses the patch of every file. A file whose patch cannot be read is set
 * aside instead of failing the run: one odd file must not prevent the review
 * of all others. Any other error is a defect and is passed on.
 */
function parseDiffs(files, parsePatch) {
  const diffs = [];
  const unreadable = [];
  for (const file of files) {
    try {
      diffs.push({ ...file, ...parsePatch(file.patch) });
    } catch (error) {
      if (!(error instanceof PatchFormatError)) throw error;
      // The message names positions in the patch, never its content.
      unreadable.push({ path: file.path, detail: error.message });
    }
  }
  return { diffs, unreadable };
}

/** Turns anything that was thrown into a message a person can act on. */
function describe(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string" && error.trim()) return error;
  return "ReviewOps failed without an error message.";
}
