import { SEVERITIES } from "./ai/schema.js";

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
 * 4. The rest is sorted by severity, most serious first. Findings of the same
 *    severity keep the order of the requests and of the model.
 * 5. Only the first `maxComments` findings are shown, the others are counted.
 * 6. A shown finding whose line is an added line of its file becomes an inline
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
 * @returns {{
 *   inline: import("./ai/schema.js").Finding[],
 *   unplaced: import("./ai/schema.js").Finding[],
 *   dropped: {
 *     empty: number,
 *     unknownPath: number,
 *     duplicate: number,
 *     overLimit: number,
 *   },
 * }} `inline` and `unplaced` together hold at most `maxComments` findings,
 *   each list sorted by severity.
 */
export function selectFindings({ reviews, maxComments }) {
  const dropped = { empty: 0, unknownPath: 0, duplicate: 0, overLimit: 0 };
  const kept = [];
  const placeOf = new Map();

  for (const { files, findings } of reviews) {
    const linesOf = new Map(
      files.map((file) => [file.path, new Set(file.commentableLines)]),
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
        kept.push({ finding, commentable: lines.has(finding.line) });
        continue;
      }
      // Same path and line: whether it can carry a comment stays the same.
      dropped.duplicate += 1;
      if (rank(finding) < rank(kept[place].finding)) {
        kept[place] = { ...kept[place], finding };
      }
    }
  }

  // Array.prototype.sort is stable: equal severities keep their order.
  kept.sort((a, b) => rank(a.finding) - rank(b.finding));
  const shown = kept.slice(0, maxComments);
  dropped.overLimit = kept.length - shown.length;

  return {
    inline: shown
      .filter((item) => item.commentable)
      .map(({ finding }) => finding),
    unplaced: shown
      .filter((item) => !item.commentable)
      .map(({ finding }) => finding),
    dropped,
  };
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
