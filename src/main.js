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
import { findingsAtThreshold, parseFailOn } from "./fail-on.js";
import { explainMissingSecret, readPullRequest } from "./github/context.js";
import { listChangedFiles } from "./github/files.js";
import { readHistory, scopeDiffs } from "./github/history.js";
import { postReview, reviewUrl, serverUrlOf } from "./github/review.js";
import {
  ThreadsUnavailableError,
  readResolvedComments,
} from "./github/threads.js";
import { assertInputs, readInputs, secretsOf } from "./inputs.js";
import { parseInsightsConfig } from "./insights/config.js";
import { deliverInsightsReport } from "./insights/deliver.js";
import { sendInsightsReport as insightsSend } from "./insights/send.js";
import { applyLimits, parseLimits } from "./limits.js";
import { countOpenFindings, currentEarlierFindings } from "./open-findings.js";
import { setOutputs } from "./outputs.js";
import { printable } from "./printable.js";
import { createRedactor } from "./redact.js";
import { reviewInBatches } from "./review.js";
import { maskSecrets } from "./secrets.js";
import { parseSkipOptions, readSkipFacts, skipReason } from "./skip.js";
import { buildSummary } from "./summary.js";

// `pull_request_target` is left out on purpose: it hands secrets and a write
// token to pull requests from forks.
const SUPPORTED_EVENT = "pull_request";

// A pull request can skip thousands of files, for example when it deletes a
// directory. The log names the first ones and counts the rest.
const MAX_SKIPPED_LINES = 50;

const UNREADABLE_DIFF = "the diff could not be read";

const NOT_REVIEWED = "the request to the model failed";

// The outputs of a run that ended before it looked at the pull request.
const NOTHING_OPEN = Object.freeze({
  findingsCount: 0,
  criticalCount: 0,
  reviewUrl: null,
});

// Counts for a run that did not ask the model.
const NO_NEW_FINDINGS = Object.freeze(
  Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])),
);

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
 * @param {typeof import("./insights/send.js").sendInsightsReport} [deps.sendInsightsReport]
 */
export async function run({
  core = actionsCore,
  context = actionsContext,
  getOctokit = actionsGetOctokit,
  parsePatch = diffParsePatch,
  createAiClient = aiCreateClient,
  sendInsightsReport = insightsSend,
} = {}) {
  // The clock of the report: its duration runs from here (#75).
  const startedAt = performance.now();
  let redact = String;
  // What the job summary shows and what the outputs say. Both are filled
  // while the run goes on and written at the end, however it ends. The
  // outputs stay unset when the run fails with an error.
  const report = { status: "ReviewOps stopped before it reviewed anything." };
  let outputs = null;
  // The report for ReviewOps Insights (#76), set only at a regular end of a run
  // that asked the model. `finish()` sends it after the outputs are set.
  let insightsJob = null;

  try {
    if (context.eventName !== SUPPORTED_EVENT) {
      report.status = `ReviewOps runs only on the "${SUPPORTED_EVENT}" event. This run was triggered by "${context.eventName ?? "unknown"}" and was skipped.`;
      core.notice(report.status);
      outputs = NOTHING_OPEN;
      return;
    }

    const inputs = readInputs(core);
    redact = createRedactor(secretsOf(inputs));
    // Which pull requests are reviewed. A value of the three inputs that
    // cannot be used fails the run here, before any request. A run that leaves
    // out the review asks no model, so it needs no key either.
    const skip = skipReason(readSkipFacts(context), parseSkipOptions(inputs));
    // Without the key, a pull request from a fork or a run of Dependabot ends
    // here with a notice, before any request: GitHub gives them no secrets,
    // so there is nothing the workflow could fix. Anywhere else, a missing
    // key stays an error.
    if (!inputs.openaiApiKey && !skip) {
      const notice = explainMissingSecret(context);
      if (notice) {
        core.notice(notice);
        report.status = notice;
        outputs = NOTHING_OPEN;
        return;
      }
    }
    assertInputs(inputs, { needsKey: !skip });
    // A pattern, a limit, a model name or a language that cannot be used
    // fails the run here, before any request.
    const excludeReason = createExcludeFilter(inputs.exclude);
    const limits = parseLimits(inputs);
    const model = parseModel(inputs.openaiModel);
    const language = parseLanguage(inputs.language);
    const failOn = parseFailOn(inputs.failOn);
    // The report leaves the runner, so the address is checked before the
    // first request. Without the secret, a fork or a run of Dependabot goes on
    // without sending: GitHub gave it no secrets. Anywhere else it is a
    // mistake of the workflow.
    const insights = parseInsightsConfig(inputs);
    if (insights && !insights.secret && !explainMissingSecret(context)) {
      throw new Error(
        "Input `insights-secret` is missing. Store the secret as a repository secret and pass it to the action, for example `insights-secret: ${{ secrets.INSIGHTS_SECRET }}`, or remove `insights-url` to switch the report off.",
      );
    }

    core.info("ReviewOps started.");
    if (insights) {
      core.info(
        `The report of this run goes to ReviewOps Insights at ${printable(insights.host)}.`,
      );
    }

    // Only checked values reach the log: the title of the pull request is
    // written by its author and stays out.
    const pullRequest = readPullRequest(context);
    core.info(
      `Reviewing ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.pullNumber} at commit ${pullRequest.headSha}.`,
    );

    const octokit = getOctokit(inputs.githubToken);
    const listing = await listChangedFiles(octokit, pullRequest);

    // What ReviewOps did on this pull request before: the commit it reviewed
    // last and the lines it commented on. Reading it fails the run before
    // anything costs money.
    const history = await readHistory(octokit, pullRequest);
    // Numbers and a checked commit SHA only. A first run says nothing here.
    if (history.ownReviews > 0 || history.ownComments > 0) {
      core.info(
        `Earlier work of ReviewOps on this pull request: ${history.ownReviews} reviews, ${history.ownComments} comments.`,
      );
      core.info(
        history.mode === "incremental"
          ? `Reviewing only the changes since commit ${history.since}.`
          : `Reviewing the whole pull request: ${history.reason}.`,
      );
    }

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

    // After an earlier review, only files with a line that is new since then
    // go on. The others were checked already: they count in the log, not
    // under "not reviewed".
    let newLines = null;
    let scoped = diffs;
    if (history.mode === "incremental") {
      ({ diffs: scoped, newLines } = scopeDiffs(diffs, history.newLines));
    }
    const alreadyReviewed = diffs.length - scoped.length;
    if (history.mode === "incremental") report.since = history.since;

    // Earlier findings whose line is still an added line of the pull request
    // stay open until the code changes or a person resolves their thread.
    // Only GraphQL knows the resolved threads, and it is only asked when an
    // earlier finding is still current. Both happen before anything costs
    // money.
    const earlier = currentEarlierFindings(history.earlierFindings, diffs);
    let resolved = new Set();
    if (earlier.length > 0) {
      try {
        resolved = await readResolvedComments(octokit, pullRequest);
      } catch (error) {
        // The threads matter for the count only. Without `fail-on` the
        // review goes on, and every earlier finding counts as open: in
        // doubt more, never fewer. With `fail-on` the count decides about
        // the step, so it must be right.
        if (!(error instanceof ThreadsUnavailableError) || failOn !== "none") {
          throw error;
        }
        core.warning(
          redact(
            `${error.message} Every earlier finding of ReviewOps counts as open.`,
          ),
        );
      }
    }

    // Every regular end of the run counts the open findings, sets the
    // outputs and applies `fail-on`, also when nothing was sent to the
    // model: a run that has nothing new must not turn a red check green.
    const conclude = ({ newCounts, known = 0, overLimit = 0, url = null }) => {
      const open = countOpenFindings({ newCounts, earlier, resolved });
      report.findings = { ...open, known, overLimit };
      report.reviewUrl = url;
      outputs = {
        findingsCount: open.total,
        criticalCount: open.bySeverity.critical,
        reviewUrl: url,
      };
      // Numbers only. Without earlier findings the open ones are the ones
      // of this run, which the log names already.
      if (open.earlier > 0 || open.resolved > 0) {
        core.info(
          `Open findings: ${open.total} (${SEVERITIES.map((severity) => `${open.bySeverity[severity]} ${severity}`).join(", ")}), ${open.earlier} of them from earlier comments; ${open.resolved} earlier findings are left out because their thread is resolved.`,
        );
      }

      const reached = findingsAtThreshold(open.bySeverity, failOn);
      report.threshold = { failOn, reached };
      if (reached > 0) {
        const where =
          url ??
          `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.pullNumber}`;
        core.setFailed(
          `ReviewOps found ${reached} open findings at or above the severity "${failOn}" (fail-on: ${failOn}): ${where}. Fix them, or resolve the thread of a finding that needs no change.`,
        );
      }
    };

    // A pull request that is not reviewed ends here. Nothing below costs money
    // or posts something, and the lines about files, limits and masked strings
    // belong to a review that does not take place. The earlier findings are
    // counted and `fail-on` applies as in a run with nothing new: a label can
    // be set by anyone with the role Triage, and it must not turn a red check
    // green. The text names the reason from the inputs, nothing from the event.
    if (skip) {
      report.status = `ReviewOps left out the review: ${skip.text}. A green run does not mean that this pull request was reviewed.`;
      core.notice(report.status);
      conclude({ newCounts: NO_NEW_FINDINGS });
      return;
    }

    // Large pull requests are cut to the limits, in the order of GitHub. A
    // file that does not fit into one request to the model is left out too.
    const { selected, overLimit, tooLarge, usedChars } = applyLimits(
      scoped,
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
    report.files = { reviewed: 0, skipped, alreadyReviewed };
    core.info(
      `Found ${selected.length + skipped.length + alreadyReviewed} changed files: ${selected.length} to review, ${skipped.length} skipped.`,
    );
    if (alreadyReviewed > 0) {
      core.info(
        `${alreadyReviewed} files have no new line since commit ${history.since} and are not sent again.`,
      );
    }
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
      report.status =
        scoped.length === 0 && alreadyReviewed > 0
          ? `ReviewOps found no new lines to review since commit ${history.since}. A green run does not mean that new changes were reviewed.`
          : "ReviewOps found no files to review in this pull request. The log lists the skipped files.";
      core.notice(report.status);
      conclude({ newCounts: NO_NEW_FINDINGS });
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
    report.usage = {
      ...review.usage,
      requests: batches.length,
      failed: review.failed.length,
    };
    report.files = {
      reviewed: selected.length - notReviewed.length,
      skipped: [
        ...skipped,
        ...notReviewed.map((path) => ({ path, reason: NOT_REVIEWED })),
      ],
      alreadyReviewed,
    };
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
    const {
      inline,
      fingerprints,
      unplaced,
      unplacedFingerprints,
      dropped,
      counts: newCounts,
    } = selectFindings({
      reviews: review.reviews,
      maxComments: limits.maxComments,
      newLines,
      known: history.fingerprints,
    });
    const shown = [...inline, ...unplaced];
    // A later run does not start at a review whose gaps a new run can fill: a
    // request that failed, and findings over max-comments (the ones posted
    // now are left out next time, so the next ones come up). Files over a
    // limit or with an unreadable diff are not counted: a run over the whole
    // pull request leaves out the same files again.
    const incomplete = notReviewed.length > 0 || dropped.overLimit > 0;
    const received = review.reviews.reduce(
      (sum, { findings }) => sum + findings.length,
      0,
    );

    // Numbers only: the findings and the summary hold code from the pull
    // request.
    core.info(
      `Checked ${received} findings: ${inline.length} at an added line, ${unplaced.length} at another line, left out ${dropped.empty} with an empty text, ${dropped.unknownPath} for a file that was not sent, ${dropped.duplicate} duplicates, ${dropped.notNew} outside of the new lines, ${dropped.known} at lines that were commented before and ${dropped.overLimit} over the limit of ${limits.maxComments} (max-comments).`,
    );
    const counts = SEVERITIES.map(
      (severity) =>
        `${shown.filter((item) => item.severity === severity).length} ${severity}`,
    ).join(", ");
    core.info(
      `Review finished: ${shown.length} findings (${counts}) from ${review.succeeded} of ${batches.length} requests.`,
    );

    // From here on the run ends regularly after a request to the model, so
    // the report for Insights is due: also for a run without findings. It is
    // sent after the outputs, in `finish()`, and changes nothing about how
    // the run ends.
    const reportToInsights = (posted) => {
      if (!insights) return;
      insightsJob = () =>
        deliverInsightsReport({
          core,
          redact,
          insights,
          send: sendInsightsReport,
          facts: {
            pullRequest,
            context,
            model,
            usage: review.usage,
            mode: history.mode,
            posted,
            selection: { inline, fingerprints, unplaced, unplacedFingerprints },
            startedAt,
          },
        });
    };

    // An empty review would only notify people. Files that were not
    // reviewed are named in the log above.
    if (shown.length === 0) {
      report.status = "No findings, so no review was posted.";
      core.info(report.status);
      conclude({ newCounts, known: dropped.known });
      reportToInsights(null);
      return;
    }

    // One review of the type COMMENT with every inline comment. The texts
    // of the model are made safe for Markdown on the way.
    const posted = await postReview({
      octokit,
      pullRequest,
      model,
      summaries: review.reviews.map(({ summary }) => summary),
      selection: {
        inline,
        fingerprints,
        unplaced,
        unplacedFingerprints,
        dropped,
      },
      maxComments: limits.maxComments,
      incomplete,
      since: history.since,
      skipped: report.files.skipped,
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
      report.status = `GitHub did not accept the inline comments (HTTP 422), so all ${shown.length} findings are listed in the text of the review.`;
      core.warning(`${report.status.slice(0, -1)}: ${where}`);
    } else {
      report.status = `Posted a review with ${posted.inlineComments} inline comments and ${unplaced.length} findings in its text.`;
      core.info(`${report.status.slice(0, -1)}: ${where}`);
    }
    conclude({
      newCounts,
      known: dropped.known,
      overLimit: dropped.overLimit,
      url: posted.reviewId === null ? null : where,
    });
    reportToInsights(posted);
  } catch (error) {
    // A run that ends with an error sends no report.
    insightsJob = null;
    // Mark the step as failed first: nothing below may prevent that.
    const message = redact(describe(error));
    core.setFailed(message);
    report.status = "ReviewOps failed.";
    report.error = message;

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
  } finally {
    await finish(core, report, outputs, insightsJob);
  }
}

/**
 * Sets the outputs, sends the report for Insights and writes the job summary,
 * in this order: the outputs do not wait for the report, which can take up to
 * 50 seconds, and the summary can tell how it went. None of it may fail the
 * run: the review is posted already, and a runner without a summary file or a
 * server that does not answer is no reason for a red step. The warnings name
 * no path and no message.
 */
async function finish(core, report, outputs, insightsJob) {
  try {
    if (outputs) setOutputs(core, outputs);
  } catch {
    core.warning("The outputs of the step could not be set.");
  }
  if (insightsJob) {
    try {
      report.insights = await insightsJob();
    } catch {
      // `deliverInsightsReport()` catches its errors itself. This is the net
      // under it, with the same fixed text.
      const text =
        "The report for ReviewOps Insights could not be built or sent.";
      core.warning(text);
      report.insights = { text };
    }
  }
  try {
    await core.summary.addRaw(buildSummary(report), true).write();
  } catch {
    core.warning("The job summary could not be written.");
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
