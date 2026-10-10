import { readRun } from "../github/context.js";
import { MAX_STATUS_FINDINGS, buildStatusPayload } from "./status.js";
import {
  MAX_FINDINGS,
  MAX_PATH_CHARS,
  buildInsightsPayload,
} from "./payload.js";
import { describeFailure } from "./send.js";

/** The text of every case in which the report could not even be tried. */
export const NOT_BUILT_TEXT =
  "The report for ReviewOps Insights could not be built or sent.";

/** The same for the status report. */
export const STATUS_NOT_BUILT_TEXT =
  "The status report for ReviewOps Insights could not be built or sent.";

/** The text of a run that cannot send because the secret is missing. */
export const NO_SECRET_TEXT =
  "The report for ReviewOps Insights was not sent: the secret in `insights-secret` is not available in this run, because GitHub passes no repository secrets to runs of forks and of Dependabot.";

// Only these two messages of the code that builds the report may reach the
// debug log: they name a field and never a value.
const SAFE_BUILD_ERROR =
  /^(The insights report has an invalid [\w.]+\.|GITHUB_RUN_(ID|ATTEMPT) is not a valid run number\.)$/;

// The hint for `401` is the one case that a person can fix in the workflow.
const HINT_FOR_401 =
  " Check that `insights-secret` has the same value as `INGEST_SECRET` at ReviewOps Insights.";

// The texts of the two reports, whole sentences side by side with the same
// keys (#112). They differ in more than a word: the report of a review says
// whether Insights knew it, only the status report can have nothing to send,
// and the lines about left out findings have their own conditions. A text
// that is `null` does not occur for that report.
//
// - `notBuilt`: nothing could be tried. Fixed, never redacted.
// - `omitted(numbers)`: the line about findings that were left out, or
//   `null`. Numbers only.
// - `nothingToSend`: the status report has no finding to report.
// - `delivered(result, attempts)`: the line in the log after success.
// - `reached(result)`: the sentence for the summary after success.
// - `notSent(why)` and `notDelivered(why, attempts, hint)`: the warning
//   after a failure, without and with an attempt. Redacted.
// - `didNotReach(why)`: the sentence for the summary after a failure. Redacted.
const REVIEW_TEXTS = {
  notBuilt: NOT_BUILT_TEXT,
  omitted: (omitted) =>
    omitted.overLimit > 0 || omitted.longPath > 0
      ? `Findings left out of the report for Insights: ${omitted.overLimit} over the limit of ${MAX_FINDINGS}, ${omitted.longPath} with a path over ${MAX_PATH_CHARS} characters.`
      : null,
  nothingToSend: null,
  delivered: (result, attempts) =>
    `Report delivered to ReviewOps Insights: ${
      result.outcome === "duplicate" ? "it was known already" : "stored"
    } (HTTP ${result.httpStatus}), ${attempts}.`,
  reached: (result) =>
    result.outcome === "duplicate"
      ? "The report reached ReviewOps Insights, which knew it already."
      : "The report reached ReviewOps Insights.",
  notSent: (why) => `The report for ReviewOps Insights was not sent: ${why}.`,
  notDelivered: (why, attempts, hint) =>
    `The report for ReviewOps Insights was not delivered: ${why}, after ${attempts}.${hint}`,
  didNotReach: (why) => `The report did not reach ReviewOps Insights (${why}).`,
};

const STATUS_TEXTS = {
  notBuilt: STATUS_NOT_BUILT_TEXT,
  omitted: (omitted) =>
    omitted.unknown > 0 || omitted.overLimit > 0
      ? `Findings left out of the status report: ${omitted.unknown} whose state is not known, ${omitted.overLimit} over the limit of ${MAX_STATUS_FINDINGS}.`
      : null,
  nothingToSend:
    "No status report was sent: none of the earlier findings has a known state.",
  delivered: (result, attempts) =>
    `Status report delivered to ReviewOps Insights (HTTP ${result.httpStatus}), ${attempts}.`,
  reached: () => "The status report reached ReviewOps Insights.",
  notSent: (why) =>
    `The status report for ReviewOps Insights was not sent: ${why}.`,
  notDelivered: (why, attempts, hint) =>
    `The status report for ReviewOps Insights was not delivered: ${why}, after ${attempts}.${hint}`,
  didNotReach: (why) =>
    `The status report did not reach ReviewOps Insights (${why}).`,
};

// What each report brings to the common course: the texts, how it is built
// from the facts of the run, where it goes and the kind for `send()`.
const REVIEW_REPORT = {
  texts: REVIEW_TEXTS,
  build: (facts) =>
    buildInsightsPayload({
      pullRequest: facts.pullRequest,
      run: readRun(facts.context),
      model: facts.model,
      usage: facts.usage,
      mode: facts.mode,
      posted: facts.posted,
      selection: facts.selection,
      startedAt: facts.startedAt,
    }),
  addressOf: (insights) => insights.url,
  kind: null,
};

const STATUS_REPORT = {
  texts: STATUS_TEXTS,
  build: (facts) =>
    buildStatusPayload({
      pullRequest: facts.pullRequest,
      run: readRun(facts.context),
      state: facts.state,
      comments: facts.comments,
      diffs: facts.diffs,
      unknownPaths: facts.unknownPaths,
      listingTruncated: facts.listingTruncated,
      threads: facts.threads,
    }),
  addressOf: (insights) => insights.statusUrl,
  kind: "status",
};

/**
 * The course that both reports share: build the report, send it and say in
 * the log and in the summary how that went.
 *
 * Nothing in here lets the run fail or changes its result: every error ends
 * in a warning with a fixed text. The log gets the status, the number of
 * attempts and a code that looks like an identifier, never the address, the
 * body, the signature or the answer.
 *
 * @returns {Promise<{ text: string }>} One sentence for the job summary.
 */
async function deliver({ report, core, redact, insights, send, facts }) {
  const { texts } = report;

  let result;
  try {
    const { payload, omitted } = report.build(facts);
    // Numbers only.
    const omittedLine = texts.omitted(omitted);
    if (omittedLine !== null) core.info(omittedLine);
    if (payload === null) {
      const text = texts.nothingToSend;
      core.info(text);
      return { text };
    }
    result = await send({
      url: report.addressOf(insights),
      secret: insights.secret,
      payload,
      ...(report.kind === null ? {} : { kind: report.kind }),
    });
  } catch (error) {
    if (error instanceof Error && SAFE_BUILD_ERROR.test(error.message)) {
      core.debug(redact(error.message));
    }
    core.warning(texts.notBuilt);
    return { text: texts.notBuilt };
  }

  if (result.detail) {
    core.debug(redact(`Insights: ${result.reason}, ${result.detail}`));
  }

  const attempts = `${result.attempts} ${result.attempts === 1 ? "attempt" : "attempts"}`;
  if (result.delivered) {
    core.info(texts.delivered(result, attempts));
    return { text: texts.reached(result) };
  }

  const why = describeFailure(result);
  const hint = result.httpStatus === 401 ? HINT_FOR_401 : "";
  core.warning(
    redact(
      result.attempts === 0
        ? texts.notSent(why)
        : texts.notDelivered(why, attempts, hint),
    ),
  );
  return { text: redact(texts.didNotReach(why)) };
}

/**
 * Builds the report of a finished run, sends it to ReviewOps Insights and says
 * in the log and in the summary how that went (#76).
 *
 * Nothing in here lets the run fail or changes its result: every error ends in
 * a warning with a fixed text. The log gets the status, the number of attempts
 * and a code that looks like an identifier, never the address, the body, the
 * signature or the answer. The address and its host were checked and logged
 * before the run began.
 *
 * @param {object} options
 * @param {typeof import("@actions/core")} options.core
 * @param {(text: unknown) => string} options.redact
 * @param {{ url: string, secret: string | null }} options.insights From
 *   `parseInsightsConfig()`. Without a secret, nothing is sent.
 * @param {typeof import("./send.js").sendInsightsReport} options.send
 * @param {object} options.facts What the run knows, for
 *   `buildInsightsPayload()`: `pullRequest`, `context`, `model`, `usage`,
 *   `mode`, `posted`, `selection` and `startedAt`.
 * @returns {Promise<{ text: string }>} One sentence for the job summary.
 */
export async function deliverInsightsReport({
  core,
  redact,
  insights,
  send,
  facts,
}) {
  // A run of a fork or of Dependabot gets no repository secrets. That is no
  // mistake of the workflow, so the review stays as it is and this says why
  // nothing was sent. Only the report of a review has this case: the status
  // report is planned only when a secret is there.
  if (!insights.secret) {
    core.notice(NO_SECRET_TEXT);
    return { text: NO_SECRET_TEXT };
  }
  return deliver({
    report: REVIEW_REPORT,
    core,
    redact,
    insights,
    send,
    facts,
  });
}

/**
 * Builds the status report of a finished run, sends it to ReviewOps Insights
 * and says in the log and in the summary how that went (#77). It reports what
 * became of the earlier findings of this action.
 *
 * Like `deliverInsightsReport()`, nothing in here lets the run fail or
 * changes its result, and the log gets numbers and fixed words only: never an
 * address, a fingerprint, a body or the text of an answer.
 *
 * @param {object} options
 * @param {typeof import("@actions/core")} options.core
 * @param {(text: unknown) => string} options.redact
 * @param {{ statusUrl: string, secret: string }} options.insights
 * @param {typeof import("./send.js").sendInsightsReport} options.send
 * @param {object} options.facts `pullRequest`, `context`, `state`,
 *   `comments`, `diffs`, `unknownPaths`, `listingTruncated` and `threads`,
 *   for `buildStatusPayload()`.
 * @returns {Promise<{ text: string }>} One sentence for the job summary.
 */
export async function deliverStatusReport({
  core,
  redact,
  insights,
  send,
  facts,
}) {
  return deliver({
    report: STATUS_REPORT,
    core,
    redact,
    insights,
    send,
    facts,
  });
}
