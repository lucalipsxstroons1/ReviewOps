import { SEVERITIES } from "./ai/schema.js";
import { lineFingerprintsOf } from "./fingerprint.js";

// "critical" first, "info" last.
const RANK = new Map(SEVERITIES.map((severity, index) => [severity, index]));

/**
 * The earlier findings of this action whose line is still an added line of
 * the pull request: the code it commented on has not changed since. Each one
 * stays in the list with its comment, so `countOpenFindings()` can leave out
 * resolved threads.
 *
 * This is a pure function.
 *
 * @template {{ fingerprint: string }} E
 * @param {E[]} earlierFindings `earlierFindings` of `readHistory()`.
 * @param {{ path: string, commentableLines: number[], hunks: object[] }[]} diffs
 *   The parsed and masked files of the pull request.
 * @returns {E[]}
 */
export function currentEarlierFindings(earlierFindings, diffs) {
  const current = new Set();
  for (const diff of diffs) {
    const prints = lineFingerprintsOf(diff);
    for (const line of diff.commentableLines) {
      const print = prints.get(line);
      if (print) current.add(print);
    }
  }
  return earlierFindings.filter(({ fingerprint }) => current.has(fingerprint));
}

/**
 * Counts the findings that are open on the pull request, by severity: the
 * new findings of this run and the earlier ones that are still current.
 *
 * - An earlier finding counts once per fingerprint, even if two comments
 *   carry it, with the most serious severity of the comments that count.
 * - A comment whose thread is resolved does not count: a person decided
 *   that it needs nothing more.
 * - A new finding never has the fingerprint of an earlier comment:
 *   `selectFindings()` drops those as known. So nothing counts twice.
 *
 * This is a pure function.
 *
 * @param {object} options
 * @param {Record<string, number>} options.newCounts `counts` of
 *   `selectFindings()`.
 * @param {{ id: number, fingerprint: string, severity: string }[]} options.earlier
 *   What `currentEarlierFindings()` returned.
 * @param {Set<number>} options.resolved Ids of the comments that opened a
 *   resolved thread.
 * @returns {{
 *   total: number,
 *   bySeverity: Record<string, number>,
 *   earlier: number,
 *   resolved: number,
 * }} `earlier` counts the earlier findings in `total`, `resolved` the
 *   current earlier findings that a resolved thread leaves out.
 */
export function countOpenFindings({ newCounts, earlier, resolved }) {
  const open = new Map();
  const dismissed = new Set();
  for (const { id, fingerprint, severity } of earlier) {
    if (resolved.has(id)) {
      dismissed.add(fingerprint);
      continue;
    }
    const known = open.get(fingerprint);
    if (known === undefined || RANK.get(severity) < RANK.get(known)) {
      open.set(fingerprint, severity);
    }
  }

  const bySeverity = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, newCounts[severity] ?? 0]),
  );
  for (const severity of open.values()) bySeverity[severity] += 1;

  return {
    total: SEVERITIES.reduce((sum, severity) => sum + bySeverity[severity], 0),
    bySeverity,
    earlier: open.size,
    resolved: [...dismissed].filter((print) => !open.has(print)).length,
  };
}
