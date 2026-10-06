import { SEPARATOR, buildUserPrompt, fileBlock } from "./user-prompt.js";

// The largest user message of one request, in characters: about 12000 to
// 16000 tokens. It keeps the answer well below its limit of about 30
// findings and the request below the timeout of the client.
export const MAX_REQUEST_CHARS = 50000;

/**
 * Length of the user message that holds only this file. A file above
 * {@link MAX_REQUEST_CHARS} fits into no request.
 *
 * @param {{ path: string, annotated: string }} file
 * @returns {number}
 */
export function requestSize(file) {
  return fileBlock(file).length;
}

/**
 * Splits the files into requests, in the order they are given.
 *
 * A request takes files until the next one no longer fits, then the next
 * request begins. A file is never split.
 *
 * This is a pure function: it uses nothing but its arguments and does not
 * change them.
 *
 * @template {{ path: string, annotated: string }} T
 * @param {object} options
 * @param {T[]} options.files The files `applyLimits()` selected.
 * @param {number} [options.maxChars] The largest user message.
 * @returns {{ files: T[], user: string }[]} One entry per request, with the
 *   user message that goes to the model.
 * @throws {Error} When a single file does not fit: `applyLimits()` leaves
 *   such files out before, so this is a defect.
 */
export function planBatches({ files, maxChars = MAX_REQUEST_CHARS }) {
  const batches = [];
  let current = [];
  let used = 0;

  for (const file of files) {
    const length = requestSize(file);
    if (length > maxChars) {
      throw new Error("A file larger than one request reached the batching.");
    }
    // A block added to a message that already holds one brings a separator.
    if (current.length > 0 && used + SEPARATOR.length + length > maxChars) {
      batches.push(current);
      current = [];
    }
    used = current.length === 0 ? length : used + SEPARATOR.length + length;
    current.push(file);
  }
  if (current.length > 0) batches.push(current);

  return batches.map((batch) => ({
    files: batch,
    user: buildUserPrompt({ files: batch }),
  }));
}
