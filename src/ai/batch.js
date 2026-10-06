import {
  SEPARATOR,
  buildUserPrompt,
  fileBlock,
  messageLength,
  titleBlock,
} from "./user-prompt.js";

// The largest user message of one request, in characters: about 12000 to
// 16000 tokens. It keeps the answer well below its limit of about 30
// findings and the request below the timeout of the client.
export const MAX_REQUEST_CHARS = 50000;

/**
 * Length of the user message that holds this one file and the title.
 * A file above {@link MAX_REQUEST_CHARS} fits into no request.
 *
 * @param {string} title The title of the pull request.
 * @param {{ path: string, annotated: string }} file
 * @returns {number}
 */
export function requestSize(title, file) {
  return messageLength(titleBlock(title), [fileBlock(file).length]);
}

/**
 * Splits the files into requests, in the order they are given.
 *
 * A request takes files until the next one no longer fits, then the next
 * request begins. A file is never split. Every request carries the title.
 *
 * This is a pure function: it uses nothing but its arguments and does not
 * change them.
 *
 * @template {{ path: string, annotated: string }} T
 * @param {object} options
 * @param {string} [options.title] The title of the pull request.
 * @param {T[]} options.files The files `applyLimits()` selected.
 * @param {number} [options.maxChars] The largest user message.
 * @returns {{ files: T[], user: string }[]} One entry per request, with the
 *   user message that goes to the model.
 * @throws {Error} When a single file does not fit: `applyLimits()` leaves
 *   such files out before, so this is a defect.
 */
export function planBatches({
  title = "",
  files,
  maxChars = MAX_REQUEST_CHARS,
}) {
  const head = titleBlock(title);
  const batches = [];
  let current = [];
  let used = 0;

  for (const file of files) {
    const length = fileBlock(file).length;
    const alone = messageLength(head, [length]);
    if (alone > maxChars) {
      throw new Error("A file larger than one request reached the batching.");
    }
    // A block added to a message that already holds one brings a separator.
    const added = SEPARATOR.length + length;
    if (current.length > 0 && used + added > maxChars) {
      batches.push(current);
      current = [];
    }
    if (current.length === 0) used = alone;
    else used += added;
    current.push(file);
  }
  if (current.length > 0) batches.push(current);

  return batches.map((batch) => ({
    files: batch,
    user: buildUserPrompt({ title, files: batch }),
  }));
}
