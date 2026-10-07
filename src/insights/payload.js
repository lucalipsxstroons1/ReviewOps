import { randomUUID } from "node:crypto";
import { PROMPT_VERSION } from "../ai/prompt.js";
import { ACTION_VERSION } from "../version.js";

export const SCHEMA_VERSION = 1;
export const MAX_FINDINGS = 500;
export const MAX_PATH_CHARS = 1024;
const MAX_REPOSITORY_CHARS = 140;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Builds the report that ReviewOps Insights reads (contract v1,
 * docs/insights-payload.md): key figures of one run and the findings the
 * review shows, with severity and category.
 *
 * Only metadata goes in. Every field is taken one by one from the arguments,
 * nothing is passed through, so the title of the pull request and the texts of
 * the model (summary, title, comment, suggestion) cannot get into the report.
 *
 * Nothing is logged and nothing is sent here. The report is built once per
 * run, so every attempt to send it carries the same `deliveryId`.
 *
 * @param {object} options
 * @param {{ owner: string, repo: string, pullNumber: number, headSha: string }} options.pullRequest
 *   As `readPullRequest()` returns it. Nothing else is read.
 * @param {{ runId: number, runAttempt: number }} options.run From `readRun()`.
 * @param {string} options.model The name of the model, from `parseModel()`.
 * @param {{ inputTokens: number, outputTokens: number, totalTokens: number }} options.usage
 *   From `reviewInBatches()`.
 * @param {"full" | "incremental"} options.mode `history.mode`.
 * @param {{ reviewId: number | null, fallback: boolean } | null} options.posted
 *   The result of `postReview()`, or `null` when nothing was posted.
 * @param {ReturnType<import("../findings.js").selectFindings>} options.selection
 *   The findings the review shows.
 * @param {number} options.startedAt The time `run()` started, from the same
 *   clock as `now`.
 * @param {() => number} [options.now] A monotonic clock in milliseconds.
 *   `Date.now()` can jump back, so it is not the default.
 * @param {string} [options.deliveryId] The id of this delivery, a lower case
 *   UUID v4.
 * @returns {{
 *   payload: object,
 *   omitted: { overLimit: number, longPath: number },
 * }} `omitted` counts the findings that did not fit the contract: a path over
 *   1024 characters, or more than 500 findings. The numbers are not part of
 *   the report.
 * @throws {Error} For a value that breaks the contract. The message names the
 *   field, never the value.
 */
export function buildInsightsPayload({
  pullRequest,
  run,
  model,
  usage,
  mode,
  posted,
  selection,
  startedAt,
  now = () => performance.now(),
  deliveryId = randomUUID(),
}) {
  const repository = `${pullRequest.owner}/${pullRequest.repo}`;
  ensure(repository.length <= MAX_REPOSITORY_CHARS, "repository");
  ensure(UUID_V4.test(deliveryId), "deliveryId");
  ensure(Number.isSafeInteger(pullRequest.pullNumber), "prNumber");
  for (const [name, value] of Object.entries({
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.totalTokens,
  })) {
    ensure(Number.isSafeInteger(value) && value >= 0, `tokens.${name}`);
  }

  // Same order as in the review: the comments at a line, then the rest.
  // After the fallback to a review without comments, everything is in the text.
  const placement = posted?.fallback ? "body" : "inline";
  const all = [
    ...selection.inline.map((finding, index) =>
      toEntry(finding, selection.fingerprints[index], placement),
    ),
    ...selection.unplaced.map((finding, index) =>
      toEntry(finding, selection.unplacedFingerprints[index], "body"),
    ),
  ];
  // `String.length` counts UTF-16 code units, never fewer than code points,
  // so a path that is allowed here is allowed by the contract.
  const fitting = all.filter((entry) => entry.path.length <= MAX_PATH_CHARS);
  const findings = fitting.slice(0, MAX_FINDINGS);

  // Taken last, so the time is that of the finished report.
  const durationMs = Math.round(now() - startedAt);
  ensure(Number.isSafeInteger(durationMs) && durationMs >= 0, "durationMs");

  return {
    payload: {
      schemaVersion: SCHEMA_VERSION,
      deliveryId,
      repository,
      prNumber: pullRequest.pullNumber,
      commitSha: pullRequest.headSha,
      runId: run.runId,
      runAttempt: run.runAttempt,
      model,
      tokens: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        total: usage.totalTokens,
      },
      durationMs,
      mode,
      actionVersion: ACTION_VERSION,
      promptVersion: PROMPT_VERSION,
      githubReviewId: posted?.reviewId ?? null,
      findings,
    },
    omitted: {
      overLimit: fitting.length - findings.length,
      longPath: all.length - fitting.length,
    },
  };
}

// A finding has a line only together with its fingerprint: the fingerprint
// exists when the diff shows the line.
function toEntry(finding, fingerprint, placement) {
  const known = typeof fingerprint === "string";
  return {
    severity: finding.severity,
    category: finding.category,
    path: finding.path,
    line: known ? finding.line : null,
    fingerprint: known ? fingerprint : null,
    placement,
  };
}

function ensure(ok, field) {
  if (!ok) throw new Error(`The insights report has an invalid ${field}.`);
}
