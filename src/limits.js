import { annotateDiff } from "./diff/annotate.js";
import { printable } from "./printable.js";

// The same values are written into action.yml. A test keeps them equal.
export const DEFAULT_MAX_FILES = 50;
export const DEFAULT_MAX_DIFF_CHARS = 200000;
export const DEFAULT_MAX_COMMENTS = 10;

// Nine digits are far above any useful limit and stay exact as a number.
const MAX_DIGITS = 9;
const MAX_VALUE = 10 ** MAX_DIGITS - 1;

export const OVER_LIMIT_REASONS = Object.freeze({
  files: (maxFiles) => `over the limit of ${maxFiles} files (max-files)`,
  chars: (maxDiffChars) =>
    `does not fit into the budget of ${maxDiffChars} characters (max-diff-chars)`,
  request: (maxChars) =>
    `larger than one request to the model (${maxChars} characters)`,
});

/**
 * Reads the limits of the action. An empty value means the default: it is
 * usually a variable of the workflow that was not set.
 *
 * @param {{ maxFiles?: string, maxDiffChars?: string, maxComments?: string }} inputs
 *   Values as the workflow passed them.
 * @returns {{ maxFiles: number, maxDiffChars: number, maxComments: number }}
 * @throws {Error} When a value is not a whole number from 1 to 999999999.
 */
export function parseLimits({
  maxFiles = "",
  maxDiffChars = "",
  maxComments = "",
} = {}) {
  return {
    maxFiles: parseLimit("max-files", maxFiles, DEFAULT_MAX_FILES),
    maxDiffChars: parseLimit(
      "max-diff-chars",
      maxDiffChars,
      DEFAULT_MAX_DIFF_CHARS,
    ),
    maxComments: parseLimit("max-comments", maxComments, DEFAULT_MAX_COMMENTS),
  };
}

function parseLimit(name, value, fallback) {
  const text = String(value).trim();
  if (text === "") return fallback;

  // Only digits: "1e3", "2.5", "-1" and "0x10" are not whole numbers a
  // person meant to write.
  const valid = /^\d+$/.test(text) && text.length <= MAX_DIGITS;
  const number = valid ? Number(text) : 0;
  if (number < 1) {
    // The value is a setting of the workflow, which a pull request can change.
    throw new Error(
      `Input \`${name}\` must be a whole number from 1 to ${MAX_VALUE}, but is "${printable(text)}".`,
    );
  }
  return number;
}

/**
 * Chooses the files that go into the review, in the order GitHub lists them.
 *
 * A file that no longer fits into the remaining budget is left out, but later
 * and smaller files can still follow: one huge file must not keep the rest
 * from being reviewed. Once `maxFiles` files are chosen, all others are left
 * out without being looked at.
 *
 * The size is the length of the annotated diff, the text that is later sent
 * to the model. It is created here once and kept as `annotated`.
 *
 * A file that is larger than one request to the model on its own lands in
 * `tooLarge`. It counts against neither limit: it could never be sent.
 *
 * This is a pure function: it uses nothing but its arguments and does not
 * change them.
 *
 * @template {{ path: string, hunks: Parameters<typeof annotateDiff>[0] }} T
 * @param {T[]} diffs Parsed files, as `parsePatch()` returns them plus `path`.
 * @param {{ maxFiles: number, maxDiffChars: number }} limits
 * @param {{
 *   maxChars: number,
 *   sizeOf: (file: T & { annotated: string }) => number,
 * } | null} [request] The size of one request and how large a file makes
 *   it. Without it, no file is too large.
 * @returns {{
 *   selected: (T & { annotated: string })[],
 *   overLimit: { path: string, reason: string }[],
 *   tooLarge: { path: string, reason: string }[],
 *   usedChars: number,
 * }}
 */
export function applyLimits(diffs, { maxFiles, maxDiffChars }, request = null) {
  const selected = [];
  const overLimit = [];
  const tooLarge = [];
  let usedChars = 0;

  for (const diff of diffs) {
    if (selected.length >= maxFiles) {
      overLimit.push({
        path: diff.path,
        reason: OVER_LIMIT_REASONS.files(maxFiles),
      });
      continue;
    }

    const annotated = annotateDiff(diff.hunks);
    if (request && request.sizeOf({ ...diff, annotated }) > request.maxChars) {
      tooLarge.push({
        path: diff.path,
        reason: OVER_LIMIT_REASONS.request(request.maxChars),
      });
      continue;
    }
    if (usedChars + annotated.length > maxDiffChars) {
      overLimit.push({
        path: diff.path,
        reason: OVER_LIMIT_REASONS.chars(maxDiffChars),
      });
      continue;
    }

    usedChars += annotated.length;
    selected.push({ ...diff, annotated });
  }

  return { selected, overLimit, tooLarge, usedChars };
}
