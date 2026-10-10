import { assessComments } from "../open-findings.js";

/** The version of the contract of the status report. */
export const STATUS_SCHEMA_VERSION = 1;

/** At most this many findings go into one report (the limit of the contract). */
export const MAX_STATUS_FINDINGS = 1000;

/**
 * Builds the status report for ReviewOps Insights (docs/insights-payload.md,
 * "Status report"): for every earlier inline comment of this action that has
 * a fingerprint, three facts, and the state of the pull request. Insights
 * derives what became of a finding from them; the action only reports.
 *
 * This is a pure function. Fields are copied one by one: no text of a
 * comment, no code, no name, no number of reactions.
 *
 * A finding whose state cannot be determined safely is left out instead of
 * reported with a wrong value:
 *
 * - its file is part of the pull request, but its diff is not available
 *   (no patch, unreadable, excluded, possible secrets), or the list of files
 *   was cut off and the file is not among the parsed ones: whether the line
 *   is unchanged is unknown;
 * - the thread of its comment was not read, or its fields have another shape.
 *
 * Findings in the text of a review have no thread and are not reported.
 * Several comments with one fingerprint make one entry: the thread counts as
 * resolved if all of them are, and a thumbs down on one of them counts.
 *
 * @param {object} options
 * @param {{ owner: string, repo: string, pullNumber: number }} options.pullRequest
 * @param {{ runId: number, runAttempt: number }} options.run
 * @param {"open" | "merged" | "closed"} options.state
 * @param {{ id: number, path: string, fingerprint: string, textFingerprint?: string | null }[]} options.comments
 *   `inlineComments` of `readHistory()`.
 * @param {{ path: string, commentableLines: number[], hunks: object[] }[]} options.diffs
 *   The parsed and masked files of the pull request.
 * @param {Set<string>} options.unknownPaths Paths of files of the pull
 *   request whose diff is not available.
 * @param {boolean} options.listingTruncated GitHub cut the list of files.
 * @param {Map<number, { resolved: boolean, thumbsDown: boolean, known?: boolean }>} options.threads
 *   `readThreadStates()`.
 * @returns {{
 *   payload: object | null,
 *   omitted: { unknown: number, overLimit: number },
 * }} `payload` is `null` when there is nothing to report.
 */
export function buildStatusPayload({
  pullRequest,
  run,
  state,
  comments,
  diffs,
  unknownPaths,
  listingTruncated,
  threads,
}) {
  // The state of every comment line by the one rule of the count (#107). The
  // text fingerprint of a comment is used here and goes no further: the report
  // names the fingerprint of the comment, nothing else.
  const sorted = [...comments].sort((a, b) => a.id - b.id);
  const assessed = assessComments(sorted, diffs, {
    unknownPaths,
    listingTruncated,
  });

  // One entry per fingerprint, in the order of the oldest comment.
  const byFingerprint = new Map();
  for (const item of assessed) {
    const group = byFingerprint.get(item.comment.fingerprint) ?? [];
    group.push(item);
    byFingerprint.set(item.comment.fingerprint, group);
  }

  const findings = [];
  let unknown = 0;
  for (const [fingerprint, group] of byFingerprint) {
    const pathUnknown = group.some(({ state }) => state === "unknown");
    const states = group.map(({ comment }) => threads.get(comment.id));
    if (
      pathUnknown ||
      states.some((thread) => thread === undefined || thread.known === false)
    ) {
      unknown += 1;
      continue;
    }
    findings.push({
      fingerprint,
      lineUnchanged: group.some(({ state }) => state === "unchanged"),
      threadResolved: states.every(({ resolved }) => resolved),
      thumbsDown: states.some(({ thumbsDown }) => thumbsDown),
    });
  }

  const overLimit = Math.max(0, findings.length - MAX_STATUS_FINDINGS);
  const reported = findings.slice(0, MAX_STATUS_FINDINGS);
  if (reported.length === 0) {
    return { payload: null, omitted: { unknown, overLimit } };
  }
  return {
    payload: {
      schemaVersion: STATUS_SCHEMA_VERSION,
      repository: `${pullRequest.owner}/${pullRequest.repo}`,
      prNumber: pullRequest.pullNumber,
      runId: run.runId,
      runAttempt: run.runAttempt,
      pullRequestState: state,
      findings: reported,
    },
    omitted: { unknown, overLimit },
  };
}
