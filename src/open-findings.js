import { SEVERITIES } from "./ai/schema.js";
import { lineFingerprintsOf, textFingerprintsOf } from "./fingerprint.js";

// "critical" first, "info" last.
const RANK = new Map(SEVERITIES.map((severity, index) => [severity, index]));

/**
 * What became of the line of each earlier inline comment of this action.
 * One rule for the count of the open findings, for the lines that count as
 * commented before, and for the status report. For each comment, in this
 * order:
 *
 * 1. The diff of its file is not available (`unknownPaths`, or the list of
 *    files is cut off and the file was not parsed): `unknown`. Whether the
 *    line changed cannot be told.
 * 2. Its fingerprint is among the fingerprints of the added lines of the pull
 *    request: `unchanged`.
 * 3. It has a text fingerprint (#107), and the text stands as an added line of
 *    its file; a file without a parsed diff (renamed, deleted) is searched
 *    in all files: `unchanged`. A rename or a change of the line above
 *    changes the fingerprint of a line, but not its text.
 * 4. Otherwise `changed`.
 *
 * Each result holds `key`, the fingerprint that names the line now: the
 * fingerprint of the comment, or, when step 3 finds the text at exactly one
 * line, the fingerprint of that line (`current`). With several lines of the
 * same text the line is unclear, and `current` is `null`.
 *
 * The text fingerprints of the lines are computed only when a comment gets
 * as far as step 3. This is a pure function.
 *
 * @template {{ fingerprint: string, path?: string | null, textFingerprint?: string | null }} C
 * @param {C[]} comments
 * @param {{ path: string, commentableLines: number[], hunks: object[] }[]} diffs
 *   The parsed and masked files of the pull request.
 * @param {object} [options]
 * @param {Set<string>} [options.unknownPaths] Paths of files of the pull
 *   request whose diff is not available.
 * @param {boolean} [options.listingTruncated] GitHub cut the list of files.
 * @returns {{
 *   comment: C,
 *   state: "unchanged" | "changed" | "unknown",
 *   key: string,
 *   current: string | null,
 * }[]} In the order of `comments`.
 */
export function assessComments(
  comments,
  diffs,
  { unknownPaths = new Set(), listingTruncated = false } = {},
) {
  const parsed = new Set(diffs.map(({ path }) => path));
  const current = currentFingerprints(diffs);
  let textIndex = null;

  return comments.map((comment) => {
    const { fingerprint, textFingerprint } = comment;
    const path = comment.path ?? null;
    const result = (state, key = fingerprint, line = null) => ({
      comment,
      state,
      key,
      current: line,
    });

    if (
      path !== null &&
      (unknownPaths.has(path) || (listingTruncated && !parsed.has(path)))
    ) {
      return result("unknown");
    }
    if (current.has(fingerprint)) return result("unchanged");
    if (textFingerprint) {
      textIndex ??= indexTextFingerprints(diffs);
      const lines =
        (parsed.has(path) ? textIndex.byPath.get(path) : textIndex.all).get(
          textFingerprint,
        ) ?? [];
      if (lines.length === 1) return result("unchanged", lines[0], lines[0]);
      if (lines.length > 1) return result("unchanged");
    }
    return result("changed");
  });
}

/**
 * The fingerprints of the added lines by text fingerprint: for every file
 * and for all files together.
 *
 * @returns {{
 *   byPath: Map<string, Map<string, string[]>>,
 *   all: Map<string, string[]>,
 * }}
 */
function indexTextFingerprints(diffs) {
  const byPath = new Map();
  const all = new Map();
  const add = (map, text, print) => {
    const lines = map.get(text);
    if (lines) lines.push(print);
    else map.set(text, [print]);
  };
  for (const diff of diffs) {
    const prints = lineFingerprintsOf(diff);
    const texts = textFingerprintsOf(diff);
    const own = new Map();
    byPath.set(diff.path, own);
    for (const line of diff.commentableLines) {
      const text = texts.get(line);
      const print = prints.get(line);
      if (text === undefined || print === undefined) continue;
      add(own, text, print);
      add(all, text, print);
    }
  }
  return { byPath, all };
}

/**
 * The earlier findings of this action that are still open on the pull
 * request: the code it commented on has not changed since, or the question
 * cannot be answered (see {@link assessComments}). Each one stays in the list
 * with its comment, so `countOpenFindings()` can leave out resolved threads.
 * `fingerprint` of a returned finding is the key of its line now.
 *
 * This is a pure function.
 *
 * @template {{ fingerprint: string, path?: string | null, textFingerprint?: string | null }} E
 * @param {E[]} earlierFindings `earlierFindings` of `readHistory()`.
 * @param {{ path: string, commentableLines: number[], hunks: object[] }[]} diffs
 *   The parsed and masked files of the pull request.
 * @param {{ unknownPaths?: Set<string>, listingTruncated?: boolean }} [options]
 * @returns {{
 *   open: E[],
 *   commented: Set<string>,
 *   unknown: number,
 * }} `commented` holds the fingerprints of the lines that an earlier comment
 *   is at although its own fingerprint is gone (the text was found at exactly
 *   one line): `selectFindings()` must not post them again. `unknown` counts
 *   the open findings whose file has no diff.
 */
export function openEarlierFindings(earlierFindings, diffs, options) {
  const open = [];
  const commented = new Set();
  let unknown = 0;
  for (const { comment, state, key, current } of assessComments(
    earlierFindings,
    diffs,
    options,
  )) {
    if (state === "changed") continue;
    if (state === "unknown") unknown += 1;
    if (current !== null) commented.add(current);
    open.push({ ...comment, fingerprint: key });
  }
  return { open, commented, unknown };
}

/**
 * The earlier findings that are still open: `open` of
 * {@link openEarlierFindings}.
 */
export function currentEarlierFindings(earlierFindings, diffs, options) {
  return openEarlierFindings(earlierFindings, diffs, options).open;
}

/**
 * The fingerprints of all added lines of the pull request: a line is
 * unchanged since a comment if the fingerprint of the comment is among them.
 *
 * @param {{ commentableLines: number[], hunks: object[], path: string }[]} diffs
 * @returns {Set<string>}
 */
export function currentFingerprints(diffs) {
  const current = new Set();
  for (const diff of diffs) {
    const prints = lineFingerprintsOf(diff);
    for (const line of diff.commentableLines) {
      const print = prints.get(line);
      if (print) current.add(print);
    }
  }
  return current;
}

/**
 * Counts the findings that are open on the pull request, by severity: the
 * new findings of this run and the earlier ones that are still current.
 *
 * - An earlier finding counts once per fingerprint (the key of its line
 *   from `openEarlierFindings()`), even if two comments carry it, with the
 *   most serious severity of the comments that count.
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
