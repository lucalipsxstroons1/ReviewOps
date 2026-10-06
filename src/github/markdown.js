// Turns text from the model into Markdown that GitHub renders as nothing but
// text and code. The model can be steered by the diff, so its text could
// otherwise mention people, load images from any address, show links under
// the name of this action or forge the marker of a review comment.
//
// The text is read leniently and written strictly: code blocks and inline
// code are recognised and written again with fences of their own, longer
// than any run of backticks inside. Everything else is escaped. What GitHub
// renders is decided here, not by the model.

// Control characters other than tab and line feed, invisible format
// characters and the Unicode line and paragraph separators. They could hide
// text from a reader or reorder it, so they are shown by their code point.
const INVISIBLE = /[^\P{Cc}\n\t]|[\p{Cf}\p{Zl}\p{Zp}]/gu;

// Every ASCII punctuation character can be escaped with a backslash in
// CommonMark, and an escaped one is always shown as itself.
const PUNCTUATION = /[!-/:-@[-`{-~]/g;

// Text that GitHub turns into a link or a notification even without any
// Markdown: addresses, e-mail addresses, mentions and references to issues.
// Shown as inline code, it stays plain text. The repetitions are bounded, so
// matching stays linear on long text.
const AUTOLINKED = new RegExp(
  [
    String.raw`(?:https?|ftp|wss?):\/\/[^\s<>()[\]\x60]{0,2000}`,
    String.raw`\bwww\.[^\s<>()[\]\x60]{1,2000}`,
    String.raw`[\w.+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,10}`,
    String.raw`(?<![\w@])@[A-Za-z0-9-]{1,39}(?:\/[A-Za-z0-9._-]{1,100})?`,
    String.raw`\b[\w.-]{1,100}\/[\w.-]{1,100}#\d{1,10}\b`,
    String.raw`(?<![\w&])#\d{1,10}\b`,
    String.raw`\bGH-\d{1,10}\b`,
  ].join("|"),
  "gu",
);

// The start and the end of a fenced code block, as CommonMark reads them.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// A language name of a code block. Anything else is left out.
const LANGUAGE = /^[A-Za-z0-9#+.-]{1,30}$/;

/**
 * Shows invisible characters by their code point, a right-to-left override
 * for example as backslash-u-202e. Line feeds and tabs stay.
 *
 * @param {string} text
 * @returns {string}
 */
export function visible(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(
      INVISIBLE,
      (character) =>
        `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
    );
}

/**
 * Text as inline code: a run of backticks around it that is longer than any
 * run inside, so nothing in the text can end the code early. A line break
 * becomes a space: inline code cannot span a paragraph.
 *
 * @param {string} text
 * @returns {string} Empty for empty text.
 */
export function inlineCode(text) {
  const code = visible(text).replace(/\n/g, " ");
  if (code === "") return "";
  const fence = "`".repeat(longestRun(code, "`") + 1);
  // A space keeps a backtick at the edge apart from the fence. CommonMark
  // removes one space on each side again.
  const padded = /^`|`$|^ .* $/.test(code) ? ` ${code} ` : code;
  return `${fence}${padded}${fence}`;
}

/**
 * Text as a fenced code block, with a fence longer than any run of backticks
 * inside.
 *
 * @param {string} text
 * @param {string} [language] A language name. A value that does not look
 *   like one is left out.
 * @returns {string}
 */
export function codeBlock(text, language = "") {
  const code = visible(text).replace(/\n+$/, "");
  const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
  const info = LANGUAGE.test(language) ? language : "";
  return `${fence}${info}\n${code}\n${fence}`;
}

/**
 * Text as Markdown that renders as nothing but text: every punctuation
 * character is escaped, and addresses, mentions and references become
 * inline code.
 *
 * @param {string} text
 * @returns {string}
 */
export function plainText(text) {
  const source = visible(text);
  let result = "";
  let last = 0;
  for (const match of source.matchAll(AUTOLINKED)) {
    result += escape(source.slice(last, match.index)) + inlineCode(match[0]);
    last = match.index + match[0].length;
  }
  return result + escape(source.slice(last));
}

/**
 * Text from the model as safe Markdown. Fenced code blocks (also one without
 * an end) and inline code keep their content and become code again; all
 * other text goes through `plainText()`.
 *
 * @param {string} text
 * @returns {string}
 */
export function modelMarkdown(text) {
  const lines = visible(text).split("\n");
  const blocks = [];
  let prose = [];
  const flushProse = () => {
    if (prose.length > 0) blocks.push(proseMarkdown(prose.join("\n")));
    prose = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE.exec(lines[index]);
    if (!open || (open[1][0] === "`" && open[2].includes("`"))) {
      prose.push(lines[index]);
      continue;
    }
    flushProse();
    const [, fence, info] = open;
    const code = [];
    index += 1;
    while (index < lines.length && !closes(lines[index], fence)) {
      code.push(lines[index]);
      index += 1;
    }
    blocks.push(codeBlock(code.join("\n"), info.trim().split(/\s/)[0]));
  }
  flushProse();
  return blocks.join("\n");
}

/** Prose with inline code: code spans stay code, the rest becomes text. */
function proseMarkdown(text) {
  // Leading spaces would make an indented code block of escaped text.
  const source = text.replace(/^[ \t]+/gm, "");
  let result = "";
  let position = 0;
  let textStart = 0;
  while (position < source.length) {
    if (source[position] !== "`") {
      position += 1;
      continue;
    }
    const length = runLength(source, position, "`");
    const end = findRun(source, position + length, length);
    if (end === -1) {
      // Backticks without a partner are text.
      position += length;
      continue;
    }
    result += plainText(source.slice(textStart, position));
    result += inlineCode(trimCodeSpan(source.slice(position + length, end)));
    position = end + length;
    textStart = position;
  }
  return result + plainText(source.slice(textStart));
}

/** Whether a line ends a code block that began with this fence. */
function closes(line, fence) {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return (
    match !== null &&
    match[1][0] === fence[0] &&
    match[1].length >= fence.length
  );
}

/** The start of the next run of exactly `length` backticks, or -1. */
function findRun(text, from, length) {
  let position = text.indexOf("`", from);
  while (position !== -1) {
    const run = runLength(text, position, "`");
    if (run === length) return position;
    position = text.indexOf("`", position + run);
  }
  return -1;
}

/** CommonMark removes one space on each side of a code span. */
function trimCodeSpan(code) {
  return /^ .* $/s.test(code) && code.trim() !== "" ? code.slice(1, -1) : code;
}

function runLength(text, from, character) {
  let end = from;
  while (text[end] === character) end += 1;
  return end - from;
}

function longestRun(text, character) {
  let longest = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== character) continue;
    const length = runLength(text, index, character);
    longest = Math.max(longest, length);
    index += length - 1;
  }
  return longest;
}

function escape(text) {
  return text.replace(PUNCTUATION, "\\$&");
}
