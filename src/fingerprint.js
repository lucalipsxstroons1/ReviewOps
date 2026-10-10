import { createHash } from "node:crypto";

// Hex characters of the SHA-256 hash that are kept. 64 bits are far more than
// the few hundred comments of a pull request need.
export const FINGERPRINT_LENGTH = 16;

const GAPS = /\s+/g;

/**
 * The fingerprint of one line of code: the first 16 hex characters of the
 * SHA-256 hash over the path, the text of the line and the text of the line
 * before it, with runs of white space reduced to one space.
 *
 * The line before tells equal lines apart (a closing brace, a masked secret)
 * as long as their surroundings differ. The fingerprint stays the same when
 * the line moves and changes when the text of the line or of its predecessor
 * changes. It is taken from the masked diff, so it never depends on a secret,
 * and it reveals nothing about the line.
 *
 * @param {string} path
 * @param {string} content The text of the line, without the leading `+`.
 * @param {string} [previous] The text of the line before it in the new file,
 *   empty at the start of a hunk.
 * @returns {string}
 */
export function lineFingerprint(path, content, previous = "") {
  return createHash("sha256")
    .update(JSON.stringify([path, normalize(content), normalize(previous)]))
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

const normalize = (text) => text.replace(GAPS, " ").trim();

/**
 * The fingerprint of every line of a file that has a number in the new file,
 * added lines and context lines, by line number.
 *
 * @param {{ path: string, hunks?: { lines: { type: string, line: number | null, content: string }[] }[] }} file
 *   A parsed and masked file.
 * @returns {Map<number, string>}
 */
export function lineFingerprintsOf(file) {
  const result = new Map();
  for (const hunk of file.hunks ?? []) {
    let previous = "";
    for (const { line, content } of hunk.lines) {
      if (line === null) continue;
      result.set(line, lineFingerprint(file.path, content, previous));
      previous = content;
    }
  }
  return result;
}

// A line needs a letter or a digit to be told apart from other lines by its
// text alone: `}` or `);` stand all over a file.
const HAS_SUBSTANCE = /[\p{L}\p{N}]/u;

/**
 * The text fingerprint of one line of code: the first 16 hex characters of
 * the SHA-256 hash over the text of the line alone, with runs of white space
 * reduced to one space. It has no path and no line before it, so it survives
 * what changes `lineFingerprint()`: a renamed file and a changed line above.
 *
 * A line without a letter or a digit has none (`null`): its text says too
 * little about which line is meant.
 *
 * @param {string} content The text of the line, without the leading `+`.
 * @returns {string | null}
 */
export function textFingerprint(content) {
  const text = normalize(content);
  if (!HAS_SUBSTANCE.test(text)) return null;
  return createHash("sha256")
    .update(JSON.stringify(["text", text]))
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

/**
 * The text fingerprint of every line of a file that has a number in the new
 * file and a text that tells it apart, by line number.
 *
 * @param {{ hunks?: { lines: { line: number | null, content: string }[] }[] }} file
 *   A parsed and masked file.
 * @returns {Map<number, string>}
 */
export function textFingerprintsOf(file) {
  const result = new Map();
  for (const hunk of file.hunks ?? []) {
    for (const { line, content } of hunk.lines) {
      if (line === null) continue;
      const print = textFingerprint(content);
      if (print !== null) result.set(line, print);
    }
  }
  return result;
}
