import { SEVERITIES } from "./ai/schema.js";
import { inlineCode, plainText } from "./github/markdown.js";
import { SEVERITY_LABELS } from "./github/review.js";

/** File names listed in the summary; the rest is counted. */
export const MAX_SUMMARY_FILES = 50;

// A longer path is cut. GitHub allows much longer paths, and the list is
// meant to be read.
const MAX_PATH_CHARS = 200;

// The summary of one step may hold 1 MiB. The texts here stay far below.
const MAX_SUMMARY_CHARS = 60000;

/** What the summary says when nothing is open. */
export const NO_FINDINGS = "No findings.";

/**
 * The text of the job summary: what the run did, in numbers.
 *
 * Nothing in here comes from the model. File names come from the pull
 * request and stand as inline code, reasons and messages go through
 * `plainText()`, so the summary shows text, code, tables and the one link to
 * the review, nothing else.
 *
 * @param {object} report What `run()` collected.
 * @param {string} report.status One sentence on how the run ended.
 * @param {string | null} [report.error] The message of the error the run
 *   failed with, already redacted.
 * @param {{
 *   reviewed: number,
 *   skipped: { path: string, reason: string }[],
 *   alreadyReviewed: number,
 * } | null} [report.files]
 * @param {string | null} [report.since] The commit of the earlier review
 *   when only the new lines were reviewed, 40 hex characters.
 * @param {{
 *   bySeverity: Record<string, number>,
 *   total: number,
 *   earlier: number,
 *   resolved: number,
 *   overLimit: number,
 *   known: number,
 * } | null} [report.findings] Open findings, as `countOpenFindings()`
 *   returned them, and the counts of `selectFindings()`.
 * @param {{
 *   inputTokens: number,
 *   outputTokens: number,
 *   totalTokens: number,
 *   withoutCount: number,
 *   requests: number,
 *   failed?: number,
 * } | null} [report.usage] `requests` counts every request that was sent,
 *   `failed` the ones without an answer; the tokens are those of the
 *   answered requests.
 * @param {string | null} [report.reviewUrl] Built from checked values.
 * @param {{ failOn: string, reached: number } | null} [report.threshold]
 * @param {{ text: string } | null} [report.insights] How the report for
 *   ReviewOps Insights went, one sentence of the action. Only set when the
 *   workflow switched the report on: without it the summary says nothing
 *   about Insights.
 * @param {{ text: string } | null} [report.insightsStatus] How the status
 *   report for ReviewOps Insights went (#77), one sentence of the action.
 * @returns {string}
 */
export function buildSummary({
  status,
  error = null,
  files = null,
  since = null,
  findings = null,
  usage = null,
  reviewUrl = null,
  threshold = null,
  insights = null,
  insightsStatus = null,
}) {
  const blocks = ["## ReviewOps", plainText(status)];
  if (error) blocks.push(`**Error:** ${plainText(error)}`);
  if (reviewUrl) blocks.push(`[Open the review](${reviewUrl})`);

  if (findings) blocks.push(...findingBlocks(findings));
  if (threshold && threshold.failOn !== "none") {
    blocks.push(
      threshold.reached > 0
        ? `**fail-on: ${threshold.failOn}** — ${threshold.reached} open findings reach the threshold, so the step fails.`
        : `**fail-on: ${threshold.failOn}** — no open finding reaches the threshold.`,
    );
  }
  if (files) blocks.push(...fileBlocks(files, since));
  if (usage) blocks.push(...usageBlocks(usage));
  if (insights || insightsStatus) {
    blocks.push("### ReviewOps Insights");
    if (insights) blocks.push(plainText(insights.text));
    if (insightsStatus) blocks.push(plainText(insightsStatus.text));
  }

  const text = `${blocks.join("\n\n")}\n`;
  return text.length > MAX_SUMMARY_CHARS
    ? `${text.slice(0, MAX_SUMMARY_CHARS - 2)}…\n`
    : text;
}

function findingBlocks({
  bySeverity,
  total,
  earlier,
  resolved,
  overLimit,
  known,
}) {
  const blocks = ["### Findings"];
  if (total === 0) {
    blocks.push(NO_FINDINGS);
  } else {
    blocks.push(
      [
        "| Severity | Open |",
        "|---|---:|",
        ...SEVERITIES.map(
          (severity) =>
            `| ${SEVERITY_LABELS[severity]} | ${bySeverity[severity]} |`,
        ),
        `| **Total** | **${total}** |`,
      ].join("\n"),
    );
    blocks.push(
      `${total - earlier} found in this run, ${earlier} from earlier comments whose line has not changed.`,
    );
  }

  const notes = [];
  if (resolved > 0) {
    notes.push(
      `${resolved} earlier findings are left out: their thread is resolved.`,
    );
  }
  if (known > 0) {
    notes.push(
      `${known} findings of this run were commented before and are not posted again.`,
    );
  }
  if (overLimit > 0) {
    notes.push(
      `${overLimit} findings are counted, but not shown in the review (\`max-comments\`).`,
    );
  }
  if (notes.length > 0) blocks.push(notes.join(" "));
  return blocks;
}

function fileBlocks({ reviewed, skipped, alreadyReviewed }, since) {
  const rows = [
    "| Files | Count |",
    "|---|---:|",
    `| Reviewed | ${reviewed} |`,
    `| Skipped | ${skipped.length} |`,
  ];
  if (since !== null) {
    rows.push(
      `| No new line since ${inlineCode(since.slice(0, 7))} | ${alreadyReviewed} |`,
    );
  }
  const blocks = ["### Files", rows.join("\n")];

  if (skipped.length > 0) {
    const lines = skipped
      .slice(0, MAX_SUMMARY_FILES)
      .map(({ path, reason }) => `- ${pathCode(path)}: ${plainText(reason)}`);
    if (skipped.length > MAX_SUMMARY_FILES) {
      lines.push(`- and ${skipped.length - MAX_SUMMARY_FILES} more files`);
    }
    blocks.push("#### Skipped files", lines.join("\n"));
  }
  return blocks;
}

function usageBlocks({
  inputTokens,
  outputTokens,
  totalTokens,
  withoutCount,
  requests,
  failed = 0,
}) {
  const blocks = [
    "### Tokens",
    [
      "| Input | Output | Total | Requests sent |",
      "|---:|---:|---:|---:|",
      `| ${inputTokens} | ${outputTokens} | ${totalTokens} | ${requests} |`,
    ].join("\n"),
  ];
  const notes = [];
  if (failed > 0) {
    notes.push(
      `${failed} requests failed; the tokens they used are not part of the numbers above.`,
    );
  }
  if (withoutCount > 0) {
    notes.push(
      `${withoutCount} requests answered without a token count; they are not part of the numbers above.`,
    );
  }
  if (notes.length > 0) blocks.push(notes.join(" "));
  return blocks;
}

/** A file name as inline code. File names come from the pull request. */
function pathCode(path) {
  return inlineCode(
    path.length > MAX_PATH_CHARS ? `${path.slice(0, MAX_PATH_CHARS)}…` : path,
  );
}
