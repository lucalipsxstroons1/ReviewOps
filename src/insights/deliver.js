import { readRun } from "../github/context.js";
import {
  MAX_FINDINGS,
  MAX_PATH_CHARS,
  buildInsightsPayload,
} from "./payload.js";
import { describeFailure } from "./send.js";

/** The text of every case in which the report could not even be tried. */
const NOT_SENT =
  "The report for ReviewOps Insights could not be built or sent.";

// Only these two messages of the code that builds the report may reach the
// debug log: they name a field and never a value.
const SAFE_BUILD_ERROR =
  /^(The insights report has an invalid [\w.]+\.|GITHUB_RUN_(ID|ATTEMPT) is not a valid run number\.)$/;

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
  // nothing was sent.
  if (!insights.secret) {
    const text =
      "The report for ReviewOps Insights was not sent: the secret in `insights-secret` is not available in this run, because GitHub passes no repository secrets to runs of forks and of Dependabot.";
    core.notice(text);
    return { text };
  }

  let result;
  try {
    const { payload, omitted } = buildInsightsPayload({
      pullRequest: facts.pullRequest,
      run: readRun(facts.context),
      model: facts.model,
      usage: facts.usage,
      mode: facts.mode,
      posted: facts.posted,
      selection: facts.selection,
      startedAt: facts.startedAt,
    });
    // Numbers only.
    if (omitted.overLimit > 0 || omitted.longPath > 0) {
      core.info(
        `Findings left out of the report for Insights: ${omitted.overLimit} over the limit of ${MAX_FINDINGS}, ${omitted.longPath} with a path over ${MAX_PATH_CHARS} characters.`,
      );
    }
    result = await send({
      url: insights.url,
      secret: insights.secret,
      payload,
    });
  } catch (error) {
    if (error instanceof Error && SAFE_BUILD_ERROR.test(error.message)) {
      core.debug(redact(error.message));
    }
    core.warning(NOT_SENT);
    return { text: NOT_SENT };
  }

  if (result.detail)
    core.debug(redact(`Insights: ${result.reason}, ${result.detail}`));

  const attempts = `${result.attempts} ${result.attempts === 1 ? "attempt" : "attempts"}`;
  if (result.delivered) {
    const known =
      result.outcome === "duplicate" ? "it was known already" : "stored";
    core.info(
      `Report delivered to ReviewOps Insights: ${known} (HTTP ${result.httpStatus}), ${attempts}.`,
    );
    return {
      text:
        result.outcome === "duplicate"
          ? "The report reached ReviewOps Insights, which knew it already."
          : "The report reached ReviewOps Insights.",
    };
  }

  const why = describeFailure(result);
  // The hint for `401` is the one case that a person can fix in the workflow.
  const hint =
    result.httpStatus === 401
      ? " Check that `insights-secret` has the same value as `INGEST_SECRET` at ReviewOps Insights."
      : "";
  core.warning(
    redact(
      result.attempts === 0
        ? `The report for ReviewOps Insights was not sent: ${why}.`
        : `The report for ReviewOps Insights was not delivered: ${why}, after ${attempts}.${hint}`,
    ),
  );
  return {
    text: redact(`The report did not reach ReviewOps Insights (${why}).`),
  };
}
