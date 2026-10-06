import * as actionsCore from "@actions/core";
import {
  context as actionsContext,
  getOctokit as actionsGetOctokit,
} from "@actions/github";
import { MAX_REQUEST_CHARS, planBatches, requestSize } from "./ai/batch.js";
import { createAiClient as aiCreateClient } from "./ai/client.js";
import { parseModel } from "./ai/model.js";
import { buildSystemPrompt, parseLanguage } from "./ai/prompt.js";
import { SEVERITIES } from "./ai/schema.js";
import { UNUSABLE_PATH_REASON, isUsablePath } from "./ai/user-prompt.js";
import {
  PatchFormatError,
  parsePatch as diffParsePatch,
} from "./diff/parse.js";
import {
  SENSITIVE_REASON,
  createExcludeFilter,
  isSensitiveFile,
} from "./exclude.js";
import { selectFindings } from "./findings.js";
import { explainMissingSecret, readPullRequest } from "./github/context.js";
import { listChangedFiles } from "./github/files.js";
import { postReview, reviewUrl, serverUrlOf } from "./github/review.js";
import { assertInputs, readInputs, secretsOf } from "./inputs.js";
import { applyLimits, parseLimits } from "./limits.js";
import { printable } from "./printable.js";
import { createRedactor } from "./redact.js";
import { reviewInBatches } from "./review.js";
import { maskSecrets } from "./secrets.js";

// `pull_request_target` is left out on purpose: it hands secrets and a write
// token to pull requests from forks.
const SUPPORTED_EVENT = "pull_request";

// A pull request can skip thousands of files, for example when it deletes a
// directory. The log names the first ones and counts the rest.
const MAX_SKIPPED_LINES = 50;

const UNREADABLE_DIFF = "the diff could not be read";

const NOT_REVIEWED = "the request to the model failed";

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
 * @param {typeof import("./ai/client.js").createAiClient} [deps.createAiClient]
 */
export async function run({
  core = actionsCore,
  context = actionsContext,
  getOctokit = actionsGetOctokit,
  parsePatch = diffParsePatch,
  createAiClient = aiCreateClient,
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
    // Without the key, a pull request from a fork or a run of Dependabot ends
    // here with a notice, before any request: GitHub gives them no secrets,
    // so there is nothing the workflow could fix. Anywhere else, a missing
    // key stays an error.
    if (!inputs.openaiApiKey) {
      const notice = explainMissingSecret(context);
      if (notice) {
        core.notice(notice);
        return;
      }
    }
    assertInputs(inputs);
    // A pattern, a limit, a model name or a language that cannot be used
    // fails the run here, before any request.
    const excludeReason = createExcludeFilter(inputs.exclude);
    const limits = parseLimits(inputs);
    const model = parseModel(inputs.openaiModel);
    const language = parseLanguage(inputs.language);

    core.info("ReviewOps started.");

    // Only checked values reach the log: the title of the pull request is
    // written by its author and stays out.
    const pullRequest = readPullRequest(context);
    core.info(
      `Reviewing ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.pullNumber} at commit ${pullRequest.headSha}.`,
    );

    const octokit = getOctokit(inputs.githubToken);
    const listing = await listChangedFiles(octokit, pullRequest);

    // Files that may hold secrets are left out first, under their new and
    // their old name, whatever the inputs say. Then generated and irrelevant
    // files, and files whose name cannot be put into the prompt. All of this
    // happens before anything is parsed.
    const relevant = [];
    const sensitive = [];
    const excluded = [];
    let unusableNames = 0;
    for (const file of listing.files) {
      if (
        isSensitiveFile(file.path) ||
        (file.previousPath && isSensitiveFile(file.previousPath))
      ) {
        sensitive.push({ path: file.path, reason: SENSITIVE_REASON });
        continue;
      }
      let reason = excludeReason(file.path);
      if (!reason && !isUsablePath(file.path)) {
        reason = UNUSABLE_PATH_REASON;
        unusableNames += 1;
      }
      if (reason) excluded.push({ path: file.path, reason });
      else relevant.push(file);
    }

    // Line numbers are calculated here and never taken from the model.
    // Strings that look like secrets are masked right away: everything after
    // this point, the limits included, sees only the masked text.
    const { diffs, unreadable } = parseDiffs(relevant, parsePatch);

    // Large pull requests are cut to the limits, in the order of GitHub. A
    // file that does not fit into one request to the model is left out too.
    const { selected, overLimit, tooLarge, usedChars } = applyLimits(
      diffs,
      limits,
      {
        maxChars: MAX_REQUEST_CHARS,
        sizeOf: requestSize,
      },
    );

    // The list below is cut off, so the order matters: unreadable diffs,
    // files that may hold secrets and files that the limits left out are the
    // ones someone has to look at, excluded files are a decision of this
    // action, the rest could not be reviewed anyway.
    const skipped = [
      ...unreadable.map(({ path }) => ({ path, reason: UNREADABLE_DIFF })),
      ...sensitive,
      ...tooLarge,
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
    const withSecrets = diffs.filter((diff) => diff.masked > 0);
    if (withSecrets.length > 0) {
      const count = withSecrets.reduce((sum, diff) => sum + diff.masked, 0);
      core.warning(
        `Strings that look like secrets were masked before anything was sent to the model: ${count} in ${withSecrets.length} files. Check that no real secret is part of this pull request.`,
      );
      // Names and numbers only, never what was found.
      for (const { path, masked } of withSecrets.slice(0, MAX_SKIPPED_LINES)) {
        core.info(`Masked ${masked} possible secrets in ${printable(path)}.`);
      }
    }
    if (sensitive.length > 0) {
      core.warning(
        `Files that may hold secrets: ${sensitive.length}. They are never sent to the model and are not reviewed. Check that no real secret is part of this pull request.`,
      );
    }
    if (unusableNames > 0) {
      core.warning(
        `Files whose name cannot be put into the prompt: ${unusableNames}. They are not reviewed. A name with a double quote, "<", ">" or a control character cannot be sent.`,
      );
    }
    if (tooLarge.length > 0) {
      core.warning(
        `Files larger than one request to the model: ${tooLarge.length}. They are not reviewed. One request holds at most ${MAX_REQUEST_CHARS} characters.`,
      );
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

    const batches = planBatches({ files: selected });
    core.info(
      `Sending ${selected.length} files to ${model} in ${batches.length} requests.`,
    );
    const client = createAiClient({
      apiKey: inputs.openaiApiKey,
      model,
      core,
    });
    const review = await reviewInBatches({
      client,
      system: buildSystemPrompt({ language }),
      batches,
    });

    // Not one request worked: there is no review, and the message of the
    // first error says what to do.
    if (review.succeeded === 0) throw review.failed[0].error;

    const notReviewed = review.failed.flatMap(({ paths }) => paths);
    if (review.failed.length > 0) {
      // The messages of the client are its own texts, without anything from
      // the answer of the API.
      const reasons = [
        ...new Set(review.failed.map(({ error }) => error.message)),
      ];
      core.warning(
        redact(
          `Requests to the model that failed: ${review.failed.length} of ${batches.length}. ${notReviewed.length} files were not reviewed. ${reasons.join(" ")}`,
        ),
      );
      for (const path of notReviewed.slice(0, MAX_SKIPPED_LINES)) {
        core.info(`Not reviewed ${printable(path)}: ${NOT_REVIEWED}.`);
      }
      if (notReviewed.length > MAX_SKIPPED_LINES) {
        core.info(
          `${notReviewed.length - MAX_SKIPPED_LINES} more files that were not reviewed are not listed.`,
        );
      }
    }

    // A number only: the texts themselves hold code from the pull request.
    if (review.shortened > 0) {
      core.info(
        `Texts of the model that were longer than allowed and were cut: ${review.shortened}.`,
      );
    }

    // Every finding is checked against the files of its own request: only an
    // added line of such a file can carry an inline comment.
    const { inline, unplaced, dropped } = selectFindings({
      reviews: review.reviews,
      maxComments: limits.maxComments,
    });
    const shown = [...inline, ...unplaced];
    const received = review.reviews.reduce(
      (sum, { findings }) => sum + findings.length,
      0,
    );

    // Numbers only: the findings and the summary hold code from the pull
    // request.
    core.info(
      `Checked ${received} findings: ${inline.length} at an added line, ${unplaced.length} at another line, left out ${dropped.empty} with an empty text, ${dropped.unknownPath} for a file that was not sent, ${dropped.duplicate} duplicates and ${dropped.overLimit} over the limit of ${limits.maxComments} (max-comments).`,
    );
    const counts = SEVERITIES.map(
      (severity) =>
        `${shown.filter((item) => item.severity === severity).length} ${severity}`,
    ).join(", ");
    core.info(
      `Review finished: ${shown.length} findings (${counts}) from ${review.succeeded} of ${batches.length} requests.`,
    );

    // An empty review would only notify people. Files that were not
    // reviewed are named in the log above.
    if (shown.length === 0) {
      core.info("No findings, so no review was posted.");
      return;
    }

    // One review of the type COMMENT with every inline comment. The texts
    // of the model are made safe for Markdown on the way.
    const posted = await postReview({
      octokit,
      pullRequest,
      model,
      summaries: review.reviews.map(({ summary }) => summary),
      selection: { inline, unplaced, dropped },
      maxComments: limits.maxComments,
      skipped: [
        ...skipped,
        ...notReviewed.map((path) => ({ path, reason: NOT_REVIEWED })),
      ],
    });
    const where =
      posted.reviewId === null
        ? `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.pullNumber}`
        : reviewUrl(
            serverUrlOf(context.serverUrl),
            pullRequest,
            posted.reviewId,
          );
    if (posted.fallback) {
      core.warning(
        `GitHub did not accept the inline comments (HTTP 422), so all ${shown.length} findings are listed in the text of the review: ${where}`,
      );
    } else {
      core.info(
        `Posted a review with ${posted.inlineComments} inline comments and ${unplaced.length} findings in its text: ${where}`,
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

/**
 * Parses the patch of every file and masks strings that look like secrets.
 * A file whose patch cannot be read is set aside instead of failing the run:
 * one odd file must not prevent the review of all others. Any other error is
 * a defect and is passed on.
 */
function parseDiffs(files, parsePatch) {
  const diffs = [];
  const unreadable = [];
  for (const file of files) {
    try {
      const { patch, ...rest } = file;
      const parsed = parsePatch(patch);
      const { hunks, masked } = maskSecrets(parsed.hunks);
      // The raw patch stays behind: from here on, only the masked hunks
      // exist, so nothing later can send an unmasked secret by mistake.
      diffs.push({ ...rest, ...parsed, hunks, masked });
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
