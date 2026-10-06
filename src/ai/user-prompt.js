// The user message of a review request. The system prompt in prompt.js
// describes this shape: change one, and the other has to follow.
//
// <file path="src/Profile.jsx">
// @@ function Profile() {
//    9 | +  useEffect(() => {
// </file>
//
// The title of the pull request is not part of it on purpose: with the title
// in the message, the model raised a false alarm on a clean reference diff in
// every run (#14).
//
// Every line of an annotated diff, split at line feeds, starts with the
// number column, so no such line of code can start with a tag. A carriage
// return or a Unicode line separator inside a line can still make code look
// like a new line to the model; #15 defuses those. The path is the only
// value that stands on its own, and it is checked here.

// A path goes into an attribute in double quotes. Escaping is no way out:
// the model would have to undo it, and a path it returns changed can no
// longer be matched to a file of the pull request. The control characters,
// invisible format characters and Unicode line and paragraph separators
// could break the tag or hide text from a reader.
const UNUSABLE_PATH = /["<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const UNUSABLE_PATH_REASON =
  "the file name contains characters that cannot be put into the prompt";

// Between two blocks of the message.
export const SEPARATOR = "\n\n";

/**
 * Whether a path can be put into the prompt as it is.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isUsablePath(path) {
  return typeof path === "string" && path !== "" && !UNUSABLE_PATH.test(path);
}

/**
 * The block of one file.
 *
 * @param {{ path: string, annotated: string }} file
 * @returns {string}
 * @throws {Error} When the path cannot be put into the prompt. `run()` leaves
 *   such files out before, so this is a defect.
 */
export function fileBlock({ path, annotated }) {
  if (!isUsablePath(path)) {
    throw new Error("A file with an unusable path reached the prompt.");
  }
  return `<file path="${path}">\n${annotated}\n</file>`;
}

/**
 * Builds the user message of one request.
 *
 * The result contains code from the pull request. It is meant for the model
 * and must not be logged.
 *
 * @param {object} options
 * @param {{ path: string, annotated: string }[]} options.files The files of
 *   this request, with the annotated diff `applyLimits()` created.
 * @returns {string}
 */
export function buildUserPrompt({ files }) {
  return files.map(fileBlock).join(SEPARATOR);
}
