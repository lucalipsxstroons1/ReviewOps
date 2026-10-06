const MARKERS = { added: "+", removed: "-", context: " " };

// The number column is at least this wide, so short files look the same.
const MIN_NUMBER_WIDTH = 4;

// Control characters, invisible format characters and the Unicode line and
// paragraph separators. A carriage return or a line separator inside a line
// could make code look like a line of its own, with a number of its own; a
// format character such as a bidi override can hide what code does. They are
// shown by their code point, a line separator for example as
// backslash-u-2028, so the model sees them.
// The tab is kept: it is ordinary indentation.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const visible = (text) =>
  text.replace(INVISIBLE, (character) =>
    character === "\t"
      ? character
      : `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
  );

/**
 * Renders the hunks of one file as text for the model.
 *
 * Only added lines carry a line number: every number the model can see is a
 * line it may comment on. Context and removed lines are there to understand
 * the change. The numbers of the hunk header are left out, so there is
 * nothing to calculate with.
 *
 * ```
 * @@ function total(items) {
 *      |    const tax = 0.19;
 *      | -  return items.length;
 *   12 | +  const sum = items.reduce(add, 0);
 *      |  }
 * ```
 *
 * The result contains code written by the author of the pull request. It is
 * meant for the prompt and must not be logged.
 *
 * @param {{
 *   section: string,
 *   lines: { type: "added" | "removed" | "context", line: number | null, content: string }[],
 * }[]} hunks The hunks of one file, as `parsePatch()` returns them.
 * @returns {string}
 */
export function annotateDiff(hunks) {
  let highest = 0;
  for (const hunk of hunks) {
    for (const { type, line } of hunk.lines) {
      if (type === "added" && line > highest) highest = line;
    }
  }
  const width = Math.max(MIN_NUMBER_WIDTH, String(highest).length);

  const rows = [];
  for (const hunk of hunks) {
    rows.push(hunk.section ? `@@ ${visible(hunk.section)}` : "@@");
    for (const { type, line, content } of hunk.lines) {
      const number = type === "added" ? String(line) : "";
      // Files with Windows line endings carry a carriage return on each line.
      const code = content.endsWith("\r") ? content.slice(0, -1) : content;
      rows.push(`${number.padStart(width)} | ${MARKERS[type]}${visible(code)}`);
    }
  }
  return rows.join("\n");
}
