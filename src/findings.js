import { SEVERITIES } from "./ai/schema.js";
import { lineFingerprintsOf } from "./fingerprint.js";

// A text made of nothing but white space and invisible format characters
// (such as a zero-width space) cannot become a comment.
const BLANK = /^[\s\p{Cf}]*$/u;
const GAPS = /[\s\p{Cf}]+/gu;

// "critical" first, "info" last.
const RANK = new Map(SEVERITIES.map((severity, index) => [severity, index]));

/**
 * Checks the findings of the model against the diff and chooses the ones the
 * review shows.
 *
 * Every finding comes from the model and is checked before it is used:
 *
 * 1. A finding with an empty title, comment or suggestion is dropped.
 * 2. A finding whose path is not one of the files of its own request is
 *    dropped: the model never saw that file. The path must match exactly.
 * 3. Of the findings with the same path, line and title (compared without
 *    case and extra white space) only the most serious one is kept.
 * 4. When only the new lines are reviewed (`newLines`), a finding at an added
 *    line must be at a new one. A finding for the text of the review must be
 *    in a file with a new line and at a line of the diff (it has a
 *    fingerprint); otherwise it is dropped.
 * 5. A finding at a line whose fingerprint an earlier comment or review of
 *    this action carries (`known`) is dropped: it was reported already.
 * 6. The rest is sorted by severity, most serious first. Findings of the same
 *    severity keep the order of the requests and of the model.
 * 7. Only the first `maxComments` findings are shown, the others are counted.
 * 8. A shown finding whose line is an added line of its file becomes an inline
 *    comment (`inline`). Any other line cannot carry a comment on GitHub, so
 *    the finding goes into the text of the review (`unplaced`).
 *
 * This is a pure function: it uses nothing but its arguments and does not
 * change them. The findings are passed on as they are; their texts are still
 * untrusted and must not reach the log.
 *
 * @param {object} options
 * @param {{
 *   files: { path: string, commentableLines: number[] }[],
 *   findings: import("./ai/schema.js").Finding[],
 * }[]} options.reviews The reviews of the requests, as `reviewInBatches()`
 *   returns them.
 * @param {number} options.maxComments How many findings the review shows.
 * @param {Map<string, Set<number>> | null} [options.newLines] The added lines
 *   that are new since the last review, by path. `null` reviews the whole
 *   pull request.
 * @param {Set<string>} [options.known] Fingerprints of the lines that earlier
 *   comments of this action are at.
 * @returns {{
 *   inline: import("./ai/schema.js").Finding[],
 *   fingerprints: (string | null)[],
 *   unplaced: import("./ai/schema.js").Finding[],
 *   unplacedFingerprints: (string | null)[],
 *   dropped: {
 *     empty: number,
 *     unknownPath: number,
 *     duplicate: number,
 *     notNew: number,
 *     known: number,
 *     overLimit: number,
 *   },
 * }} `inline` and `unplaced` together hold at most `maxComments` findings,
 *   each list sorted by severity. A fingerprint belongs to the finding at the
 *   same place of its list and is `null` when the diff does not show the
 *   line.
 */
export function selectFindings({
  reviews,
  maxComments,
  newLines = null,
  known = new Set(),
}) {
  const dropped = {
    empty: 0,
    unknownPath: 0,
    duplicate: 0,
    notNew: 0,
    known: 0,
    overLimit: 0,
  };
  const kept = [];
  const placeOf = new Map();

  for (const { files, findings } of reviews) {
    const linesOf = new Map(
      files.map((file) => [file.path, new Set(file.commentableLines)]),
    );
    const printsOf = new Map(
      files.map((file) => [file.path, lineFingerprintsOf(file)]),
    );

    for (const finding of findings) {
      if (isBlank(finding.title, finding.comment, finding.suggestion)) {
        dropped.empty += 1;
        continue;
      }
      const lines = linesOf.get(finding.path);
      if (!lines) {
        dropped.unknownPath += 1;
        continue;
      }

      const key = JSON.stringify([
        finding.path,
        finding.line,
        normalize(finding.title),
      ]);
      const place = placeOf.get(key);
      if (place === undefined) {
        placeOf.set(key, kept.length);
        const commentable = lines.has(finding.line);
        kept.push({
          finding,
          commentable,
          fingerprint: printsOf.get(finding.path).get(finding.line) ?? null,
        });
        continue;
      }
      // Same path and line: whether it can carry a comment stays the same.
      dropped.duplicate += 1;
      if (rank(finding) < rank(kept[place].finding)) {
        kept[place] = { ...kept[place], finding };
      }
    }
  }

  // Findings that repeat earlier work or that lie outside of the new lines
  // are dropped before the limit is applied, so they never use up a place.
  const fresh = kept.filter((item) => {
    if (newLines && !isNew(item, newLines.get(item.finding.path))) {
      dropped.notNew += 1;
      return false;
    }
    if (item.fingerprint !== null && known.has(item.fingerprint)) {
      dropped.known += 1;
      return false;
    }
    return true;
  });

  // Array.prototype.sort is stable: equal severities keep their order.
  fresh.sort((a, b) => rank(a.finding) - rank(b.finding));
  const shown = fresh.slice(0, maxComments);
  dropped.overLimit = fresh.length - shown.length;
  const inline = shown.filter((item) => item.commentable);
  const listed = shown.filter((item) => !item.commentable);

  return {
    inline: inline.map(({ finding }) => finding),
    fingerprints: inline.map(({ fingerprint }) => fingerprint),
    unplaced: listed.map(({ finding }) => finding),
    unplacedFingerprints: listed.map(({ fingerprint }) => fingerprint),
    dropped,
  };
}

/**
 * Whether a finding belongs to the new lines. `fresh` holds the new lines of
 * its file and is missing for a file without one. A finding for the text of
 * the review has no line of its own to compare: it counts when its file has a
 * new line and the diff shows its line, so it can be told from one that was
 * reported before. Anything else would come back with every run.
 */
function isNew({ finding, commentable, fingerprint }, fresh) {
  if (!fresh) return false;
  return commentable ? fresh.has(finding.line) : fingerprint !== null;
}

function isBlank(...texts) {
  return texts.some((text) => BLANK.test(text));
}

function normalize(text) {
  return text.replace(GAPS, " ").trim().toLowerCase();
}

function rank(finding) {
  return RANK.get(finding.severity);
}
