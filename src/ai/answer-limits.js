// How long a text of the model answer may be, in characters. The answer as a
// whole is bounded by MAX_OUTPUT_TOKENS; these limits keep a single text from
// taking all of that, for example when an instruction in a diff makes the
// model write pages. Ten findings at these limits stay far below what GitHub
// accepts for a review.
export const TEXT_LIMITS = Object.freeze({
  title: 150,
  comment: 1500,
  suggestion: 1500,
  summary: 1000,
});

// What a shortened text ends with. It counts towards the limit.
const CUT_MARK = "…";

// Every way to end a line becomes a line feed.
const LINE_ENDS = /\r\n?|[\p{Zl}\p{Zp}]/gu;

// Characters that show nothing, built from their code points: this file must
// not hold them itself. They are no control or format characters, so the
// categories below miss them: the Braille blank, the Hangul fillers, the
// combining grapheme joiner and the variation selectors of the supplement
// (the ones up to U+FE0F stay: emoji need them).
const BLANKS = [0x2800, 0x3164, 0x115f, 0x1160, 0xffa0, 0x034f]
  .map((codePoint) => String.fromCodePoint(codePoint))
  .join("");
const VARIATION_SELECTORS = `${String.fromCodePoint(0xe0100)}-${String.fromCodePoint(0xe01ef)}`;

// Control characters other than line feed and tab, invisible format
// characters (direction overrides, zero-width characters and the tag
// characters that can hide a whole text from a reader) and the blanks above.
// None of them is needed in a review, and all of them can make a comment
// show something else than it says.
const INVISIBLE = new RegExp(
  `(?![\\n\\t])\\p{Cc}|\\p{Cf}|[${BLANKS}${VARIATION_SELECTORS}]`,
  "gu",
);

const WHITE_SPACE = /\s+/gu;

/**
 * Bounds and cleans the texts of a review, before anything else uses them.
 *
 * The texts come from the model and are not trusted: invisible characters are
 * removed, the title becomes one line, and a text that is longer than its
 * limit is cut and ends with "…". Length is counted in characters (code
 * points), so no character is split. A cut can end inside a Markdown code
 * block; closing it is the job of whatever renders the text.
 *
 * `path`, `line`, `severity` and `category` are passed on as they are: the
 * schema fixes the last two, and a finding is only used if its path is
 * exactly one of the files that were sent.
 *
 * This is a pure function: it uses nothing but its argument and does not
 * change it.
 *
 * @param {{ summary: string, findings: import("./schema.js").Finding[] }} review
 *   A review as `parseReview()` returns it.
 * @returns {{
 *   review: { summary: string, findings: import("./schema.js").Finding[] },
 *   shortened: number,
 * }} `shortened` counts the texts that were cut.
 */
export function boundReview(review) {
  let shortened = 0;
  const bound = (text, limit, { oneLine = false } = {}) => {
    const cleaned = clean(text, oneLine);
    const cut = cutTo(cleaned, limit);
    if (cut !== cleaned) shortened += 1;
    return cut;
  };

  const summary = bound(review.summary, TEXT_LIMITS.summary);
  const findings = review.findings.map((finding) => ({
    ...finding,
    title: bound(finding.title, TEXT_LIMITS.title, { oneLine: true }),
    comment: bound(finding.comment, TEXT_LIMITS.comment),
    suggestion: bound(finding.suggestion, TEXT_LIMITS.suggestion),
  }));

  return { review: { summary, findings }, shortened };
}

function clean(text, oneLine) {
  const visible = text.replace(LINE_ENDS, "\n").replace(INVISIBLE, "");
  return (oneLine ? visible.replace(WHITE_SPACE, " ") : visible).trim();
}

function cutTo(text, limit) {
  // Most texts are short: a string has at least as many UTF-16 units as
  // characters, so this needs no closer look.
  if (text.length <= limit) return text;

  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  return (
    characters
      .slice(0, limit - CUT_MARK.length)
      .join("")
      .trimEnd() + CUT_MARK
  );
}
