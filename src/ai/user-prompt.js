// The user message of a review request. The system prompt in prompt.js
// describes this shape: change one, and the other has to follow.
//
// <pull_request_title>
// Add profile page
// </pull_request_title>
//
// <file path="src/Profile.jsx">
// @@ function Profile() {
//    9 | +  useEffect(() => {
// </file>
//
// Every line of an annotated diff starts with the number column, so no line
// of code can start with a tag. The title and the path are the only values
// that stand on their own, and both are checked here.

// Long enough for any real title. It only tells the model what the change
// is meant to do.
export const MAX_TITLE_LENGTH = 200;

// Control characters, invisible format characters and the Unicode line and
// paragraph separators. They could break the title into several lines or
// hide text from a reader.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// A path goes into an attribute in double quotes. Escaping is no way out:
// the model would have to undo it, and a path it returns changed can no
// longer be matched to a file of the pull request.
const UNUSABLE_PATH = /["<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const UNUSABLE_PATH_REASON =
  "the file name contains characters that cannot be put into the prompt";

// Between two blocks of the message.
const SEPARATOR = "\n\n";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/**
 * Turns the title of the pull request into one line for the prompt.
 *
 * The title is written by the author of the pull request. It is cut to
 * {@link MAX_TITLE_LENGTH} characters, kept on one line, and cannot close
 * its tag.
 *
 * @param {unknown} title
 * @returns {string} An empty text if nothing is left.
 */
export function promptTitle(title) {
  const line = String(title ?? "")
    .replace(UNSAFE, " ")
    .replace(/\s+/gu, " ")
    .trim();
  // Cut by code points, so that no character is split in half, and before
  // escaping, so that no escape is cut in half.
  const short = Array.from(line).slice(0, MAX_TITLE_LENGTH).join("").trimEnd();
  return short.replace(/[&<>]/g, (character) => ESCAPES[character]);
}

/**
 * Whether a path can be put into the prompt as it is.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isUsablePath(path) {
  return typeof path === "string" && path !== "" && !UNUSABLE_PATH.test(path);
}

/** The block of the title, or an empty text when there is no title. */
export function titleBlock(title) {
  const text = promptTitle(title);
  return text === ""
    ? ""
    : `<pull_request_title>\n${text}\n</pull_request_title>`;
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
 * @param {string} [options.title] The title of the pull request.
 * @param {{ path: string, annotated: string }[]} options.files The files of
 *   this request, with the annotated diff `applyLimits()` created.
 * @returns {string}
 */
export function buildUserPrompt({ title = "", files }) {
  return joinBlocks(titleBlock(title), files.map(fileBlock));
}

/**
 * Length of the message made of these blocks, without building it.
 *
 * @param {string} title The block of the title, may be empty.
 * @param {number[]} fileLengths The lengths of the file blocks.
 * @returns {number}
 */
export function messageLength(title, fileLengths) {
  const lengths = title === "" ? fileLengths : [title.length, ...fileLengths];
  if (lengths.length === 0) return 0;
  const content = lengths.reduce((sum, length) => sum + length, 0);
  return content + SEPARATOR.length * (lengths.length - 1);
}

function joinBlocks(title, blocks) {
  return (title === "" ? blocks : [title, ...blocks]).join(SEPARATOR);
}
