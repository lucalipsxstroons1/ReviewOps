import * as actionsCore from "@actions/core";
import {
  context as actionsContext,
  getOctokit as actionsGetOctokit,
} from "@actions/github";
import {
  MAX_REQUEST_CHARS,
  budgetCostOf,
  maxRequestsFor,
  planBatches as aiPlanBatches,
  requestSize,
} from "./ai/batch.js";
import { createAiClient as aiCreateClient } from "./ai/client.js";
import { parseBaseUrl, parseModel } from "./ai/model.js";
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
import {
  explainMissingSecret,
  readPullRequest,
  readPullRequestState,
} from "./github/context.js";
import { SKIP_REASONS, listChangedFiles } from "./github/files.js";
import { readHistory, scopeDiffs } from "./github/history.js";
import { IdentityUnavailableError } from "./github/identity.js";
import { postReview, reviewUrl, serverUrlOf } from "./github/review.js";
import {
  ThreadsUnavailableError,
  readThreadStates,
  resolvedOf,
} from "./github/threads.js";
import { assertInputs, readInputs, secretsOf } from "./inputs.js";
import { deriveStatusUrl, parseInsightsConfig } from "./insights/config.js";
import {
  NOT_BUILT_TEXT,
  NO_SECRET_TEXT,
  STATUS_NOT_BUILT_TEXT,
  deliverInsightsReport,
  deliverStatusReport,
} from "./insights/deliver.js";
import { sendInsightsReport as insightsSend } from "./insights/send.js";
import { applyLimits, parseLimits } from "./limits.js";
import { countOpenFindings, openEarlierFindings } from "./open-findings.js";
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
 * What `run()` returns (#114): numbers, fixed texts and file paths of the run,
 * never the text of a finding, a diff or a credential. The job summary is
 * written from it, and whoever needs the figures of a run reads them here and
 * not from a line of the log.
 *
 * @typedef {object} RunResult
 * @property {"other-event" | "fork-without-key" | "closed-without-report" | "closed" | "left-out" | "nothing-to-review" | "no-findings" | "posted" | "failed"} end
 *   How the run ended. `posted` is also a run in which some requests failed.
 * @property {string} status One sentence on how the run ended.
 * @property {boolean} failed The step was marked as failed: by an error, or
 *   because `fail-on` was reached.
 * @property {string | null} error The message of the error that ended the
 *   run, after the redaction of the log.
 * @property {{ findingsCount: number, criticalCount: number, reviewUrl: string | null } | null} outputs
 *   The outputs of the step; `null` after an error.
 * @property {string | null} since The commit of the earlier review when only
 *   the changes since then were checked.
 * @property {{ reviewed: number, skipped: { path: string, reason: string }[], alreadyReviewed: number } | null} files
 * @property {{ inputTokens: number, outputTokens: number, totalTokens: number, withoutCount: number, requests: number, failed: number } | null} usage
 *   The tokens that were used (`reviewInBatches()` counts requests without a
 *   token count in `withoutCount`). `requests` counts every request that was
 *   sent.
 * @property {object | null} findings The open findings, as
 *   `countOpenFindings()` returns them, with `known` and `overLimit`.
 * @property {{ failOn: string, reached: number } | null} threshold
 * @property {string | null} reviewUrl
 * @property {{ skippedByLimits: number, overMaxComments: number, failedRequests: number, shown: Record<string, number> | null }} selection
 *   Files at a limit (`max-files`, `max-diff-chars`, or larger than one
 *   request), findings over `max-comments`, requests to the model that
 *   failed, and the findings that the review shows by severity (`null` for a
 *   run that did not get that far).
 * @property {{ text: string } | null} insights How the report for ReviewOps
 *   Insights went, one sentence.
 * @property {{ text: string } | null} insightsStatus The same for the status
 *   report.
 */

/** The result of a run that has done nothing yet. */
const started = () => ({
  end: "failed",
  status: "ReviewOps stopped before it reviewed anything.",
  failed: false,
  error: null,
  outputs: null,
  since: null,
  files: null,
  usage: null,
  findings: null,
  threshold: null,
  reviewUrl: null,
  selection: {
    skippedByLimits: 0,
    overMaxComments: 0,
    failedRequests: 0,
    shown: null,
  },
  insights: null,
  insightsStatus: null,
});

/**
 * The reports that are due at the end of a run, set by the phases and sent by
 * `finish()`. They hold the findings and the diffs, so they never leave
 * `run()`: only the sentences about them go into the result.
 *
 * @typedef {object} Due
 * @property {(() => Promise<{ text: string }>) | null} insights The report
 *   for ReviewOps Insights (#76), due at a regular end of a run that asked the
 *   model.
 * @property {(() => Promise<{ text: string }>) | null} status The status
 *   report (#77).
 * @property {boolean} noSecretNotice The run would have sent a status report,
 *   but has no secret for it: `finish()` says so.
 */

/** @type {Due} */
const NOTHING_DUE = Object.freeze({
  insights: null,
  status: null,
  noSecretNotice: false,
});

/**
 * One phase of a run gives back a step: what it adds to the result (`result`),
 * which reports it makes due (`due`), a message for `core.setFailed()` when
 * `fail-on` is reached (`failure`), `stop` when the run ends here, and the
 * data the later phases need (`data`). Only `run()` joins the steps; a phase
 * changes nothing outside of what it returns.
 *
 * @typedef {object} Step
 * @property {Partial<RunResult> & { selection?: Partial<RunResult["selection"]> }} [result]
 * @property {Partial<Due>} [due]
 * @property {string} [failure]
 * @property {boolean} [stop]
 * @property {any} [data]
 */

/** Adds what a phase found to the result. `selection` is added to, not replaced. */
const joined = (result, patch = {}) => ({
  ...result,
  ...patch,
  selection: { ...result.selection, ...patch.selection },
});

/** A run that ends before it has looked at the pull request. */
const stopped = (end, status) => ({
  stop: true,
  result: { end, status, outputs: NOTHING_OPEN },
});

/**
 * Runs the action. Every failure inside ends in `core.setFailed()`.
 *
 * The run is a row of phases, each a function below: check the event, read the
 * settings, then either report the state of a closed pull request or read
 * from GitHub, limit the files, ask the model, choose the findings and post
 * them. Each phase returns what it adds to the result, and `run()` joins it.
 * Whatever stood when a phase fails stays in the result, so the job summary
 * after an error shows what was known by then. Last comes `finish()`: the
 * outputs, the reports for Insights and the job summary.
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
 * @param {typeof import("./ai/batch.js").planBatches} [deps.planBatches]
 * @param {typeof import("./insights/send.js").sendInsightsReport} [deps.sendInsightsReport]
 * @returns {Promise<RunResult>}
 */
export async function run({
  core = actionsCore,
  context = actionsContext,
  getOctokit = actionsGetOctokit,
  parsePatch = diffParsePatch,
  createAiClient = aiCreateClient,
  planBatches = aiPlanBatches,
  sendInsightsReport = insightsSend,
} = {}) {
  const env = {
    core,
    context,
    getOctokit,
    parsePatch,
    createAiClient,
    planBatches,
    sendInsightsReport,
    // The clock of the report: its duration runs from here (#75).
    startedAt: performance.now(),
  };
  // Set as soon as the inputs are read; the error handler needs it before.
  let redact = String;
  let result = started();
  let due = NOTHING_DUE;

  /** Joins a step into the result and the due reports. */
  const take = (step) => {
    result = joined(result, step.result);
    due = { ...due, ...step.due };
    // `fail-on` is reached: the step fails, after the review is posted.
    if (step.failure !== undefined) {
      core.setFailed(step.failure);
      result = { ...result, failed: true };
    }
    return step;
  };

  try {
    steps: {
      if (take(checkEvent(env)).stop) break steps;

      const inputs = readInputs(core);
      redact = createRedactor(secretsOf(inputs));
      const ctx = { ...env, redact };

      const opened = take(readSettings(ctx, inputs));
      if (opened.stop) break steps;
      const settings = opened.data;

      if (settings.closed) {
        take(announceClosed(ctx, settings));
        take(await readClosed(ctx, settings));
        break steps;
      }

      const read = take(await readFromGitHub(ctx, settings)).data;

      if (settings.skip) {
        take(leftOut(ctx, settings, read));
        break steps;
      }

      const limiting = take(limitFiles(ctx, settings, read));
      if (limiting.stop) break steps;

      const asked = take(
        await askModel(ctx, settings, limiting.data, read),
      ).data;
      const chosen = take(chooseFindings(ctx, settings, read, asked)).data;
      take(await postFindings(ctx, settings, read, asked, chosen));
    }
  } catch (error) {
    // Mark the step as failed first: nothing below may prevent that.
    const message = redact(describe(error));
    core.setFailed(message);
    result = {
      ...result,
      end: "failed",
      failed: true,
      status: "ReviewOps failed.",
      error: message,
    };
    // A run that ends with an error sends no report.
    due = { ...NOTHING_DUE, noSecretNotice: due.noSecretNotice };
    logError(core, redact, error);
  }

  return finish(core, result, due);
}

/** Only `pull_request` is supported. Any other event ends the run. */
function checkEvent({ core, context }) {
  if (context.eventName === SUPPORTED_EVENT) return {};
  const status = `ReviewOps runs only on the "${SUPPORTED_EVENT}" event. This run was triggered by "${context.eventName ?? "unknown"}" and was skipped.`;
  core.notice(status);
  return stopped("other-event", status);
}

/**
 * Reads the settings of the run from the inputs and the event, and starts it:
 * which pull requests are reviewed, the limits, the model, the address for
 * Insights, then the client for GitHub. A value that cannot be used fails the
 * run here, before any request. Some runs end here without a request.
 *
 * @returns {Step} `data` holds the settings.
 */
function readSettings({ core, context, getOctokit }, inputs) {
  // Which pull requests are reviewed. A value of the three inputs that
  // cannot be used fails the run here, before any request. A run that leaves
  // out the review asks no model, so it needs no key either.
  const skip = skipReason(readSkipFacts(context), parseSkipOptions(inputs));
  // A pull request that is merged or closed is never reviewed, whatever
  // event started the run. It asks no model, so it needs no key either.
  const state = readPullRequestState(context);
  const closed = state !== "open";
  // Without the key, a pull request from a fork or a run of Dependabot ends
  // here with a notice, before any request: GitHub gives them no secrets,
  // so there is nothing the workflow could fix. Anywhere else, a missing
  // key stays an error.
  if (!inputs.openaiApiKey && !skip && !closed) {
    const notice = explainMissingSecret(context);
    if (notice) {
      core.notice(notice);
      return stopped("fork-without-key", notice);
    }
  }
  assertInputs(inputs, { needsKey: !skip && !closed });
  // A pattern, a limit, a model name or a language that cannot be used
  // fails the run here, before any request.
  const excludeReason = createExcludeFilter(inputs.exclude);
  const limits = parseLimits(inputs);
  const model = parseModel(inputs.openaiModel);
  const baseUrl = parseBaseUrl(inputs.openaiBaseUrl);
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

  // The status report goes to a second address, derived from the first.
  const statusUrl = insights ? deriveStatusUrl(insights.url) : null;
  const statusWanted = Boolean(insights?.secret && statusUrl);

  // A closed pull request is not reviewed. It only has something to do if
  // the final state can go to Insights; otherwise it ends before the first
  // request to GitHub.
  if (closed && !statusWanted) {
    const status = `ReviewOps left out the review: the pull request is ${state}. The final state goes to ReviewOps Insights only with \`insights-url\` (a path that ends on \`/review\`) and \`insights-secret\`, and at least one of them was not usable in this run.`;
    core.notice(status);
    return stopped("closed-without-report", status);
  }
  if (insights && !statusUrl) {
    core.notice(
      "The status report for ReviewOps Insights is not sent: the path of `insights-url` does not end on `/review`, so the address of the status report cannot be derived.",
    );
  }

  core.info("ReviewOps started.");
  if (!baseUrl.isDefault && !skip && !closed) {
    core.info(
      `The requests to the model go to ${printable(baseUrl.host)}, not to OpenAI.`,
    );
  }
  if (insights) {
    core.info(
      `The report of this run goes to ReviewOps Insights at ${printable(insights.host)}.`,
    );
  }

  // Only checked values reach the log: the title of the pull request is
  // written by its author and stays out.
  const pullRequest = readPullRequest(context);
  // Checked values only: the place of the pull request in a log line.
  const pullRequestName = `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.pullNumber}`;
  core.info(
    `${closed ? "Reporting the state of" : "Reviewing"} ${pullRequestName} at commit ${pullRequest.headSha}.`,
  );

  return {
    data: {
      inputs,
      skip,
      state,
      closed,
      excludeReason,
      limits,
      model,
      baseUrl,
      language,
      failOn,
      insights,
      statusUrl,
      statusWanted,
      pullRequest,
      pullRequestName,
      octokit: getOctokit(inputs.githubToken),
    },
  };
}

/**
 * The status report of this run goes out in `finish()`, after the outputs.
 * The two places that plan it (a closed pull request, and the regular end of
 * a review) hand over what they read and nothing else.
 *
 * @returns {Due["status"]}
 */
function statusJob(
  { core, context, redact, sendInsightsReport },
  { pullRequest, state, statusUrl, insights },
  { comments, diffs, unknownPaths, listingTruncated, threads },
) {
  return () =>
    deliverStatusReport({
      core,
      redact,
      insights: { statusUrl, secret: insights.secret },
      send: sendInsightsReport,
      facts: {
        pullRequest,
        context,
        state,
        comments,
        diffs,
        unknownPaths,
        listingTruncated,
        threads,
      },
    });
}

/**
 * A closed pull request is not reviewed and nothing is posted: only the final
 * state of the earlier findings is reported. This says so.
 */
function announceClosed({ core }, { state }) {
  const status = `ReviewOps left out the review: the pull request is ${state}. Only the final state of the earlier findings goes to ReviewOps Insights.`;
  core.notice(status);
  return { result: { status, outputs: NOTHING_OPEN } };
}

/**
 * Reads what a closed pull request has to report and makes the status report
 * due. A failure to read is a warning here, because this run exists for the
 * report alone.
 *
 * @returns {Step}
 */
async function readClosed(ctx, settings) {
  const { core, redact, parsePatch } = ctx;
  const { octokit, pullRequest, excludeReason } = settings;
  const ended = { result: { end: "closed" } };
  try {
    const files = await listChangedFiles(octokit, pullRequest);
    const earlierWork = await readHistory(octokit, pullRequest, {
      compare: false,
    });
    const closedFiles = prepareFiles(files, excludeReason, parsePatch);
    if (earlierWork.inlineComments.length === 0) return ended;
    const threads = await readThreadStates(octokit, pullRequest);
    return {
      ...ended,
      due: {
        status: statusJob(ctx, settings, {
          comments: earlierWork.inlineComments,
          diffs: closedFiles.diffs,
          unknownPaths: unknownPathsOf(files, closedFiles.diffs),
          listingTruncated: files.truncated,
          threads,
        }),
      },
    };
  } catch (error) {
    if (!isReadingError(error)) throw error;
    core.warning(
      redact(
        `${describe(error)} The status report for ReviewOps Insights is not sent.`,
      ),
    );
    return ended;
  }
}

/**
 * Reads what a review needs from GitHub: the changed files, the earlier work
 * of ReviewOps, the diffs without the files that never go to the model, and
 * the earlier findings that are still open. Fails the run before anything
 * costs money.
 *
 * @returns {Step} `data` holds what was read.
 */
async function readFromGitHub(ctx, settings) {
  const { core, redact, parsePatch } = ctx;
  const {
    octokit,
    pullRequest,
    excludeReason,
    failOn,
    insights,
    statusUrl,
    statusWanted,
  } = settings;

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
  // happens before anything is parsed. Line numbers are calculated here and
  // never taken from the model. Strings that look like secrets are masked
  // right away: everything after this point, the limits included, sees only
  // the masked text.
  const { sensitive, excluded, unusableNames, diffs, unreadable } =
    prepareFiles(listing, excludeReason, parsePatch);

  // After an earlier review, only files with a line that is new since then
  // go on. The others were checked already: they count in the log, not
  // under "not reviewed".
  let scoped = diffs;
  let newLines = null;
  if (history.mode === "incremental") {
    ({ diffs: scoped, newLines } = scopeDiffs(diffs, history.newLines));
  }
  const alreadyReviewed = diffs.length - scoped.length;

  // Earlier findings whose line is still an added line of the pull request
  // stay open until the code changes or a person resolves their thread. A
  // renamed file and a changed line above do not change the code of the
  // line (the text fingerprint, #107), and a finding whose file has no
  // diff any more stays open: nothing says that its line changed.
  // Only GraphQL knows the resolved threads, and it is asked when an earlier
  // finding is still current, or when a status report can go to Insights
  // (`statusWanted`) and there are earlier comments to report. Both happen
  // before anything costs money.
  const unknownPaths = unknownPathsOf(listing, diffs);
  const {
    open: earlier,
    commented,
    unknown: openWithoutDiff,
  } = openEarlierFindings(history.earlierFindings, diffs, {
    unknownPaths,
    listingTruncated: listing.truncated,
  });
  if (openWithoutDiff > 0) {
    core.info(
      `${openWithoutDiff} earlier findings count as open because the diff of their file is not available.`,
    );
  }
  const reportStatus = statusWanted && history.inlineComments.length > 0;
  let threadStates = null;
  if (earlier.length > 0 || reportStatus) {
    try {
      threadStates = await readThreadStates(octokit, pullRequest);
    } catch (error) {
      if (!(error instanceof ThreadsUnavailableError)) throw error;
      if (earlier.length > 0) {
        // The threads matter for the count. Without `fail-on` the review
        // goes on, and every earlier finding counts as open: in doubt more,
        // never fewer. With `fail-on` the count decides about the step, so
        // it must be right.
        if (failOn !== "none") throw error;
        core.warning(
          redact(
            `${error.message} Every earlier finding of ReviewOps counts as open.${reportStatus ? " The status report for ReviewOps Insights is not sent." : ""}`,
          ),
        );
      } else {
        core.warning(
          redact(
            `${error.message} The status report for ReviewOps Insights is not sent.`,
          ),
        );
      }
    }
  }

  return {
    result: { since: history.mode === "incremental" ? history.since : null },
    // Without a secret there is no status report. In a run where one would
    // have gone out, the log says why.
    due: {
      noSecretNotice:
        Boolean(insights && statusUrl && !insights.secret) &&
        history.inlineComments.length > 0,
    },
    data: {
      listing,
      history,
      sensitive,
      excluded,
      unusableNames,
      diffs,
      unreadable,
      scoped,
      newLines,
      alreadyReviewed,
      unknownPaths,
      earlier,
      commented,
      reportStatus,
      threadStates,
      resolved: threadStates ? resolvedOf(threadStates) : new Set(),
    },
  };
}

/**
 * Every regular end of the run counts the open findings, sets the outputs and
 * applies `fail-on`, also when nothing was sent to the model: a run that has
 * nothing new must not turn a red check green. The step fails in `run()`,
 * from the message this gives back.
 *
 * @returns {Step}
 */
function conclude(
  ctx,
  settings,
  read,
  { newCounts, known = 0, overLimit = 0, url = null },
) {
  const { core } = ctx;
  const { failOn, pullRequestName } = settings;
  const open = countOpenFindings({
    newCounts,
    earlier: read.earlier,
    resolved: read.resolved,
  });
  // Numbers only. Without earlier findings the open ones are the ones of this
  // run, which the log names already.
  if (open.earlier > 0 || open.resolved > 0) {
    core.info(
      `Open findings: ${open.total} (${SEVERITIES.map((severity) => `${open.bySeverity[severity]} ${severity}`).join(", ")}), ${open.earlier} of them from earlier comments; ${open.resolved} earlier findings are left out because their thread is resolved.`,
    );
  }

  // The state of the earlier findings goes to Insights at every regular end,
  // after the outputs. It reports facts and changes nothing about how the run
  // ends.
  const due =
    read.reportStatus && read.threadStates
      ? {
          status: statusJob(ctx, settings, {
            comments: read.history.inlineComments,
            diffs: read.diffs,
            unknownPaths: read.unknownPaths,
            listingTruncated: read.listing.truncated,
            threads: read.threadStates,
          }),
        }
      : undefined;

  const reached = findingsAtThreshold(open.bySeverity, failOn);
  const where = url ?? pullRequestName;
  return {
    result: {
      findings: { ...open, known, overLimit },
      reviewUrl: url,
      outputs: {
        findingsCount: open.total,
        criticalCount: open.bySeverity.critical,
        reviewUrl: url,
      },
      threshold: { failOn, reached },
    },
    due,
    ...(reached > 0
      ? {
          failure: `ReviewOps found ${reached} open findings at or above the severity "${failOn}" (fail-on: ${failOn}): ${where}. Fix them, or resolve the thread of a finding that needs no change.`,
        }
      : {}),
  };
}

/** A step that ends the run with the counts of `conclude()`. */
const ending = (end, status, concluded) => ({
  ...concluded,
  stop: true,
  result: { ...concluded.result, end, status },
});

/**
 * A pull request that is not reviewed ends here. Nothing below costs money or
 * posts something, and the lines about files, limits and masked strings belong
 * to a review that does not take place. The earlier findings are counted and
 * `fail-on` applies as in a run with nothing new: a label can be set by anyone
 * with the role Triage, and it must not turn a red check green. The text names
 * the reason from the inputs, nothing from the event.
 *
 * @returns {Step}
 */
function leftOut(ctx, settings, read) {
  const status = `ReviewOps left out the review: ${settings.skip.text}. A green run does not mean that this pull request was reviewed.`;
  ctx.core.notice(status);
  return ending(
    "left-out",
    status,
    conclude(ctx, settings, read, { newCounts: NO_NEW_FINDINGS }),
  );
}

/**
 * Cuts the pull request to the limits, in the order of GitHub, and says in the
 * log what was left out and why. A pull request without reviewable files ends
 * here, before anything costs money or posts something.
 *
 * @returns {Step} `data` holds the chosen files.
 */
function limitFiles(ctx, settings, read) {
  const { core } = ctx;
  const { limits } = settings;
  const { listing, history, sensitive, excluded, unusableNames, diffs } = read;
  const { unreadable, scoped, alreadyReviewed } = read;

  // Large pull requests are cut to the limits, in the order of GitHub. A
  // file that does not fit into one request to the model is left out too.
  // The budget counts what a file costs in a request (block and separator),
  // so a run has a bounded number of requests (#108).
  const { selected, overLimit, tooLarge, usedChars } = applyLimits(
    scoped,
    limits,
    {
      maxChars: MAX_REQUEST_CHARS,
      sizeOf: requestSize,
      costOf: budgetCostOf,
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

  const result = {
    files: { reviewed: 0, skipped, alreadyReviewed },
    selection: { skippedByLimits: overLimit.length + tooLarge.length },
  };

  // Everything that costs money or posts something comes after this
  // point: a pull request without reviewable files ends here.
  if (selected.length === 0) {
    const status =
      scoped.length === 0 && alreadyReviewed > 0
        ? `ReviewOps found no new lines to review since commit ${history.since}. A green run does not mean that new changes were reviewed.`
        : "ReviewOps found no files to review in this pull request. The log lists the skipped files.";
    core.notice(status);
    const concluded = conclude(ctx, settings, read, {
      newCounts: NO_NEW_FINDINGS,
    });
    return ending("nothing-to-review", status, {
      ...concluded,
      result: { ...result, ...concluded.result },
    });
  }

  const addedLines = selected.reduce(
    (sum, diff) => sum + diff.commentableLines.length,
    0,
  );
  core.info(
    `Parsed the diffs of ${selected.length} files: ${addedLines} added lines can receive comments.`,
  );
  core.info(`Diff size: ${usedChars} of ${limits.maxDiffChars} characters.`);

  return { result, data: { selected, skipped, usedChars } };
}

/**
 * Splits the files into requests, asks the model and checks the answers. Not
 * one request that works is an error: there is no review, and the message of
 * the first error says what to do.
 *
 * @returns {Step} `data` holds the answers and the files that were not reviewed.
 */
async function askModel(ctx, settings, limited, read) {
  const { core, redact, createAiClient, planBatches } = ctx;
  const { limits, inputs, model, baseUrl, language } = settings;
  const { selected, skipped } = limited;

  const batches = planBatches({ files: selected });
  // More requests than the budget allows would outlast `timeout-minutes`
  // of the example workflow. With the cost above this cannot happen, so it
  // is a defect, found before the first request that costs money.
  if (batches.length > maxRequestsFor(limits.maxDiffChars)) {
    throw new Error(
      "The files were split into more requests than the budget allows.",
    );
  }
  core.info(
    `Sending ${selected.length} files to ${model} in ${batches.length} requests.`,
  );
  const client = createAiClient({
    apiKey: inputs.openaiApiKey,
    baseUrl: baseUrl.url,
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
  const skippedFiles = [
    ...skipped,
    ...notReviewed.map((path) => ({ path, reason: NOT_REVIEWED })),
  ];
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

  return {
    result: {
      usage: {
        ...review.usage,
        requests: batches.length,
        failed: review.failed.length,
      },
      files: {
        reviewed: selected.length - notReviewed.length,
        skipped: skippedFiles,
        alreadyReviewed: read.alreadyReviewed,
      },
      selection: { failedRequests: review.failed.length },
    },
    data: { review, batches, notReviewed, skippedFiles },
  };
}

/**
 * Checks every finding against the files of its own request and chooses the
 * ones the review shows: only an added line of such a file can carry an inline
 * comment.
 *
 * @returns {Step} `data` holds the chosen findings.
 */
function chooseFindings(ctx, settings, read, asked) {
  const { core } = ctx;
  const { limits } = settings;
  const { review, batches, notReviewed } = asked;

  const {
    inline,
    fingerprints,
    textFingerprints,
    unplaced,
    unplacedFingerprints,
    dropped,
    counts: newCounts,
  } = selectFindings({
    reviews: review.reviews,
    maxComments: limits.maxComments,
    newLines: read.newLines,
    known: new Set([...read.history.fingerprints, ...read.commented]),
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

  return {
    result: {
      selection: {
        overMaxComments: dropped.overLimit,
        shown: Object.fromEntries(
          SEVERITIES.map((severity) => [
            severity,
            shown.filter((item) => item.severity === severity).length,
          ]),
        ),
      },
    },
    data: {
      inline,
      fingerprints,
      textFingerprints,
      unplaced,
      unplacedFingerprints,
      dropped,
      newCounts,
      shown,
      incomplete,
    },
  };
}

/**
 * From here on the run ends regularly after a request to the model, so the
 * report for Insights is due: also for a run without findings. It is sent
 * after the outputs, in `finish()`, and changes nothing about how the run
 * ends.
 *
 * @returns {Due["insights"]}
 */
function insightsJob(
  { core, context, redact, sendInsightsReport, startedAt },
  { pullRequest, model, insights },
  { history },
  { review },
  { inline, fingerprints, unplaced, unplacedFingerprints },
  posted,
) {
  if (!insights) return null;
  return () =>
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
}

/**
 * Posts the review, or says that there is none to post, and ends the run: one
 * review of the type COMMENT with every inline comment, the texts of the model
 * made safe for Markdown on the way.
 *
 * @returns {Step}
 */
async function postFindings(ctx, settings, read, asked, chosen) {
  const { core, context } = ctx;
  const { octokit, pullRequest, pullRequestName, model, limits } = settings;
  const { inline, unplaced, shown, dropped, newCounts } = chosen;
  const due = (posted) => ({
    insights: insightsJob(ctx, settings, read, asked, chosen, posted),
  });

  // An empty review would only notify people. Files that were not
  // reviewed are named in the log above.
  if (shown.length === 0) {
    const status = "No findings, so no review was posted.";
    core.info(status);
    const concluded = conclude(ctx, settings, read, {
      newCounts,
      known: dropped.known,
    });
    return {
      ...concluded,
      result: { ...concluded.result, end: "no-findings", status },
      due: { ...concluded.due, ...due(null) },
    };
  }

  const posted = await postReview({
    octokit,
    pullRequest,
    model,
    summaries: asked.review.reviews.map(({ summary }) => summary),
    selection: {
      inline,
      fingerprints: chosen.fingerprints,
      textFingerprints: chosen.textFingerprints,
      unplaced,
      unplacedFingerprints: chosen.unplacedFingerprints,
      dropped,
    },
    maxComments: limits.maxComments,
    incomplete: chosen.incomplete,
    since: read.history.since,
    skipped: asked.skippedFiles,
  });
  const where =
    posted.reviewId === null
      ? pullRequestName
      : reviewUrl(serverUrlOf(context.serverUrl), pullRequest, posted.reviewId);
  // The sentence for the summary ends with a full stop, the line of the
  // log names the place instead.
  let sentence;
  if (posted.fallback) {
    sentence = `GitHub did not accept the inline comments (HTTP 422), so all ${shown.length} findings are listed in the text of the review`;
    core.warning(`${sentence}: ${where}`);
  } else {
    sentence = `Posted a review with ${posted.inlineComments} inline comments and ${unplaced.length} findings in its text`;
    core.info(`${sentence}: ${where}`);
  }
  const concluded = conclude(ctx, settings, read, {
    newCounts,
    known: dropped.known,
    overLimit: dropped.overLimit,
    url: posted.reviewId === null ? null : where,
  });
  return {
    ...concluded,
    result: { ...concluded.result, end: "posted", status: `${sentence}.` },
    due: { ...concluded.due, ...due(posted) },
  };
}

/**
 * Writes what went wrong to the debug log: the stack and the cause. Only the
 * debug log gets them, and they go through the redactor.
 */
function logError(core, redact, error) {
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

/**
 * Sets the outputs, sends the report for Insights and writes the job summary,
 * in this order: the outputs do not wait for the report, which can take up to
 * 50 seconds, and the summary can tell how it went. None of it may fail the
 * run: the review is posted already, and a runner without a summary file or a
 * server that does not answer is no reason for a red step. The warnings name
 * no path and no message.
 *
 * @returns {Promise<RunResult>} The result with the sentences about the reports.
 */
async function finish(core, result, due) {
  try {
    if (result.outputs) setOutputs(core, result.outputs);
  } catch {
    core.warning("The outputs of the step could not be set.");
  }

  // `deliverInsightsReport()` catches its errors itself. The net under it has
  // the same fixed text.
  const deliver = async (job, fixedText) => {
    try {
      return await job();
    } catch {
      core.warning(fixedText);
      return { text: fixedText };
    }
  };
  const insights = due.insights
    ? await deliver(due.insights, NOT_BUILT_TEXT)
    : null;
  const insightsStatus = due.status
    ? await deliver(due.status, STATUS_NOT_BUILT_TEXT)
    : null;
  let noSecret = null;
  if (!due.status && due.noSecretNotice && !due.insights) {
    core.notice(NO_SECRET_TEXT);
    noSecret = { text: NO_SECRET_TEXT };
  }

  const final = {
    ...result,
    insights: insights ?? noSecret ?? result.insights,
    insightsStatus: insightsStatus ?? result.insightsStatus,
  };
  try {
    await core.summary.addRaw(buildSummary(final), true).write();
  } catch {
    core.warning("The job summary could not be written.");
  }
  return final;
}

/**
 * Splits the files of a pull request: the ones that never go to the model
 * (possible secrets, excluded, a name that cannot be put into the prompt),
 * and the parsed and masked diffs of the others.
 */
function prepareFiles(listing, excludeReason, parsePatch) {
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
  return {
    sensitive,
    excluded,
    unusableNames,
    ...parseDiffs(relevant, parsePatch),
  };
}

/**
 * The paths of files of the pull request whose diff is not available: the
 * ones that were not parsed (excluded, possible secrets, unreadable) and the
 * ones GitHub lists without a text diff. For these the status report cannot
 * say whether a commented line is unchanged. A deleted file, or one with no
 * content change, is no such case: it has no added lines.
 */
function unknownPathsOf(listing, diffs) {
  const parsed = new Set(diffs.map(({ path }) => path));
  const paths = new Set();
  for (const file of listing.files) {
    if (parsed.has(file.path)) continue;
    paths.add(file.path);
    if (file.previousPath) paths.add(file.previousPath);
  }
  for (const { path, reason } of listing.skipped) {
    if (reason === SKIP_REASONS.noPatch) paths.add(path);
  }
  return paths;
}

/** An error of reading from GitHub, as opposed to a defect of the action. */
const isReadingError = (error) =>
  error instanceof ThreadsUnavailableError ||
  error instanceof IdentityUnavailableError ||
  Number.isInteger(error?.cause?.status);

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
