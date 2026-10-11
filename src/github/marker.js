import { SEVERITIES } from "../ai/schema.js";
import { FINGERPRINT_LENGTH } from "../fingerprint.js";

// The hidden lines by which the action recognises its own work (#111). They
// are the only state it keeps between two runs, so the format has one home:
// what is written (`fingerprintLine()`, `reviewHead()`, `commentHead()`) and
// what is read (`readHead()`, `startsWithMarker()`) stand side by side, and
// the pattern of the reader is built from the same parts as the line of the
// writer. `test/marker.test.js` checks that the reader gets back what the
// writer wrote.

/**
 * Marks every comment and every review text of this action. It always
 * stands at the very start of a body; text from the model can never put it
 * there, and its `<` is escaped anywhere else.
 */
export const REVIEW_MARKER = "<!-- reviewops -->";

/**
 * The line that marks a review as not complete: files were left out or a
 * request failed. It stands right below the marker. A later run does not
 * start at such a review, so what was missed is checked again.
 */
export const INCOMPLETE_LINE = "<!-- reviewops-incomplete -->";

// The parts of the fingerprint line, for the writer and the reader alike.
const LINE_NAME = "reviewops-fingerprint";
const SEVERITY_FIELD = "severity";
const TEXT_FIELD = "text";
const HEX = `[0-9a-f]{${FINGERPRINT_LENGTH}}`;

// Only this exact shape is read; anything else is ignored. An inline comment
// adds the severity of its finding and, after it, the text fingerprint of its
// line (#107); the line in the text of a review has neither.
const FINGERPRINT_LINE = new RegExp(
  `^<!-- ${LINE_NAME}: (${HEX})(?: ${SEVERITY_FIELD}: (${SEVERITIES.join("|")})(?: ${TEXT_FIELD}: (${HEX}))?)? -->$`,
);

/** Whether the text of a review or comment starts with the marker. */
export const startsWithMarker = (body) =>
  typeof body === "string" && body.startsWith(REVIEW_MARKER);

/**
 * The line that carries the fingerprint of the commented line. It is the
 * second line of an inline comment, right below the marker. `readHead()`
 * reads it back with a strict pattern.
 *
 * An inline comment adds the severity of its finding, so a later run can
 * count the findings that are still open without reading the text of the
 * model. Only one of `SEVERITIES` is written. An inline comment adds the
 * text fingerprint of its line as well (#107), so a later run can tell that
 * the line is unchanged after a rename or a change of the line above. It
 * only ever follows a severity.
 *
 * @param {string} fingerprint 16 hex characters from `lineFingerprint()`.
 * @param {string | null} [severity] The severity of the finding.
 * @param {string | null} [text] 16 hex characters from `textFingerprint()`.
 * @returns {string}
 */
export const fingerprintLine = (fingerprint, severity = null, text = null) => {
  if (!SEVERITIES.includes(severity)) {
    return `<!-- ${LINE_NAME}: ${fingerprint} -->`;
  }
  const textPart = text ? ` ${TEXT_FIELD}: ${text}` : "";
  return `<!-- ${LINE_NAME}: ${fingerprint} ${SEVERITY_FIELD}: ${severity}${textPart} -->`;
};

/**
 * The first block of the text of a review: the marker, then the line for an
 * incomplete review and the fingerprints of the findings that stand in the
 * text. A later run reads only these lines, directly below the marker, never
 * the text of the model further down.
 *
 * @param {{ incomplete: boolean, fingerprints: (string | null)[] }} options
 * @returns {string}
 */
export function reviewHead({ incomplete, fingerprints }) {
  return [
    REVIEW_MARKER,
    ...(incomplete ? [INCOMPLETE_LINE] : []),
    ...fingerprints.filter(Boolean).map((print) => fingerprintLine(print)),
  ].join("\n");
}

/**
 * The first block of an inline comment: the marker and, if the line has a
 * fingerprint, the fingerprint line with the severity and the text
 * fingerprint of the line.
 *
 * @param {object} options
 * @param {string | null} options.fingerprint Fingerprint of the commented line.
 * @param {string | null} [options.severity] The severity of the finding.
 * @param {string | null} [options.text] Text fingerprint of that line.
 * @returns {string}
 */
export function commentHead({ fingerprint, severity = null, text = null }) {
  return [
    REVIEW_MARKER,
    ...(fingerprint ? [fingerprintLine(fingerprint, severity, text)] : []),
  ].join("\n");
}

/**
 * Reads the head of a body of this action: the lines directly below the
 * marker, up to the first one that is not a line of the head. So the text
 * further down, which comes from the model, is never read, and the head has no
 * limit of its own: the writer writes as many lines as there are findings.
 * Both kinds of line ending are accepted: GitHub keeps the ones of an edit.
 *
 * The first line is skipped, whatever it says: the caller has checked it with
 * `startsWithMarker()`.
 *
 * @param {string} body
 * @returns {{
 *   fingerprints: {
 *     fingerprint: string,
 *     severity: string | null,
 *     text: string | null,
 *   }[],
 *   incomplete: boolean,
 * }}
 */
export function readHead(body) {
  const result = { fingerprints: [], incomplete: false };
  let start = lineEnd(body, 0) + 1;
  while (start > 0 && start <= body.length) {
    const end = lineEnd(body, start);
    // A line ends at a line feed or at a carriage return and a line feed; a
    // carriage return at the very end of the body is no line end.
    const raw = body.slice(start, end === -1 ? undefined : end);
    const line = end !== -1 && raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const match = FINGERPRINT_LINE.exec(line);
    if (match) {
      result.fingerprints.push({
        fingerprint: match[1],
        severity: match[2] ?? null,
        text: match[3] ?? null,
      });
    } else if (line === INCOMPLETE_LINE) {
      result.incomplete = true;
    } else break;
    start = end === -1 ? 0 : end + 1;
  }
  return result;
}

/** The index of the next line feed at or after `from`, or -1. */
const lineEnd = (body, from) => body.indexOf("\n", from);
