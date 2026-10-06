import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TEXT_LIMITS, boundReview } from "../src/ai/answer-limits.js";
import { selectFindings } from "../src/findings.js";
import { fromRoot } from "./helpers/run-action.js";

// Special characters are built from their code points, so this file holds
// none of them.
const char = (codePoint) => String.fromCodePoint(codePoint);
const CARRIAGE_RETURN = char(0x0d);
const LINE_FEED = char(0x0a);
const TAB = char(0x09);
const LINE_SEPARATOR = char(0x2028);
const PARAGRAPH_SEPARATOR = char(0x2029);
const RIGHT_TO_LEFT_OVERRIDE = char(0x202e);
const ZERO_WIDTH_SPACE = char(0x200b);
const ZERO_WIDTH_JOINER = char(0x200d);
const BYTE_ORDER_MARK = char(0xfeff);
const SOFT_HYPHEN = char(0xad);
const TAG_LETTER_A = char(0xe0041);
const NUL = char(0x00);
const ESCAPE = char(0x1b);
const BELL = char(0x07);
// One character outside of the basic plane: two UTF-16 units.
const ROCKET = char(0x1f680);

const finding = (fields = {}) => ({
  path: "src/a.js",
  line: 3,
  severity: "major",
  category: "code-quality",
  title: "A title",
  comment: "What is wrong.",
  suggestion: "What to change.",
  ...fields,
});

const review = (findings = [finding()], summary = "A summary.") => ({
  summary,
  findings,
});

const countOf = (text) => Array.from(text).length;

// --- The limits --------------------------------------------------------------

test("names a limit for every text of a review", () => {
  assert.deepEqual(TEXT_LIMITS, {
    title: 150,
    comment: 1500,
    suggestion: 1500,
    summary: 1000,
  });
  assert.ok(Object.isFrozen(TEXT_LIMITS));
});

test("leaves short texts as they are", () => {
  const input = review();

  const { review: result, shortened } = boundReview(input);

  assert.deepEqual(result, input);
  assert.equal(shortened, 0);
});

for (const [field, limit] of [
  ["title", 150],
  ["comment", 1500],
  ["suggestion", 1500],
]) {
  test(`keeps a ${field} of exactly ${limit} characters`, () => {
    const text = "x".repeat(limit);

    const { review: result, shortened } = boundReview(
      review([finding({ [field]: text })]),
    );

    assert.equal(result.findings[0][field], text);
    assert.equal(shortened, 0);
  });

  test(`cuts a ${field} of ${limit + 1} characters and marks the cut`, () => {
    const { review: result, shortened } = boundReview(
      review([finding({ [field]: "x".repeat(limit + 1) })]),
    );

    const text = result.findings[0][field];
    assert.equal(countOf(text), limit);
    assert.equal(text, `${"x".repeat(limit - 1)}…`);
    assert.equal(shortened, 1);
  });
}

test("keeps a summary of exactly 1000 characters and cuts a longer one", () => {
  const exact = boundReview(review([], "s".repeat(1000)));
  const longer = boundReview(review([], "s".repeat(1001)));

  assert.equal(exact.review.summary, "s".repeat(1000));
  assert.equal(exact.shortened, 0);
  assert.equal(longer.review.summary, `${"s".repeat(999)}…`);
  assert.equal(longer.shortened, 1);
});

test("counts every text that was cut", () => {
  const long = "x".repeat(5000);

  const { shortened } = boundReview(
    review(
      [
        finding({ title: long, comment: long, suggestion: long }),
        finding({ comment: long }),
        finding(),
      ],
      long,
    ),
  );

  assert.equal(shortened, 5);
});

test("counts characters, not UTF-16 units, and never splits one", () => {
  // 150 rockets are 300 UTF-16 units, but 150 characters: they fit.
  const fits = boundReview(review([finding({ title: ROCKET.repeat(150) })]));
  const tooLong = boundReview(review([finding({ title: ROCKET.repeat(151) })]));

  assert.equal(fits.review.findings[0].title, ROCKET.repeat(150));
  assert.equal(fits.shortened, 0);

  const cut = tooLong.review.findings[0].title;
  assert.equal(cut, `${ROCKET.repeat(149)}…`);
  assert.equal(countOf(cut), 150);
  assert.ok(cut.isWellFormed(), "a character was split");
  assert.equal(tooLong.shortened, 1);
});

test("puts the mark right after the last word", () => {
  const text = `${"x".repeat(1490)}         and more text that does not fit`;

  const { review: result } = boundReview(review([finding({ comment: text })]));

  assert.equal(result.findings[0].comment, `${"x".repeat(1490)}…`);
});

test("never returns a text that is longer than its limit", () => {
  const texts = [
    "x".repeat(100000),
    ROCKET.repeat(40000),
    `${"word ".repeat(30000)}`,
    `${LINE_FEED}`.repeat(50000),
  ];

  for (const text of texts) {
    const { review: result } = boundReview(
      review([finding({ title: text, comment: text, suggestion: text })], text),
    );

    assert.ok(countOf(result.summary) <= 1000);
    assert.ok(countOf(result.findings[0].title) <= 150);
    assert.ok(countOf(result.findings[0].comment) <= 1500);
    assert.ok(countOf(result.findings[0].suggestion) <= 1500);
  }
});

// --- Invisible characters ----------------------------------------------------

const INVISIBLE = [
  ["a right-to-left override", RIGHT_TO_LEFT_OVERRIDE],
  ["a zero-width space", ZERO_WIDTH_SPACE],
  ["a zero-width joiner", ZERO_WIDTH_JOINER],
  ["a byte order mark", BYTE_ORDER_MARK],
  ["a soft hyphen", SOFT_HYPHEN],
  ["a tag character", TAG_LETTER_A],
  ["a NUL character", NUL],
  ["an escape character", ESCAPE],
  ["a bell character", BELL],
  // They show nothing, but are neither control nor format characters.
  ["a Braille blank", char(0x2800)],
  ["a Hangul filler", char(0x3164)],
  ["a Hangul choseong filler", char(0x115f)],
  ["a Hangul jungseong filler", char(0x1160)],
  ["a halfwidth Hangul filler", char(0xffa0)],
  ["a combining grapheme joiner", char(0x034f)],
  ["the first variation selector of the supplement", char(0xe0100)],
  ["the last variation selector of the supplement", char(0xe01ef)],
];

for (const [name, character] of INVISIBLE) {
  test(`removes ${name} from every text`, () => {
    const text = `be${character}fore and af${character}ter`;

    const { review: result, shortened } = boundReview(
      review([finding({ title: text, comment: text, suggestion: text })], text),
    );

    for (const cleaned of [
      result.summary,
      result.findings[0].title,
      result.findings[0].comment,
      result.findings[0].suggestion,
    ]) {
      assert.equal(cleaned, "before and after");
    }
    // Cleaning is not cutting.
    assert.equal(shortened, 0);
  });
}

test("keeps what emoji and ordinary text need", () => {
  // The variation selector 16 turns a symbol into an emoji. A no-break space
  // and a figure space are visible as spaces and stay.
  const text = `heart${char(0x2764)}${char(0xfe0f)} a${char(0x00a0)}b${char(0x2007)}c`;

  const { review: result } = boundReview(review([finding({ comment: text })]));

  assert.equal(result.findings[0].comment, text);
});

test("drops a finding whose text shows nothing, also with look-alike blanks", () => {
  const blanks = `${char(0x2800)}${char(0x3164)}${char(0xe0100)}${char(0x034f)}`;

  const { review: result } = boundReview(
    review([finding({ comment: blanks, title: blanks, suggestion: blanks })]),
  );
  const { inline, unplaced, dropped } = selectFindings({
    reviews: [
      {
        files: [{ path: "src/a.js", commentableLines: [3] }],
        findings: result.findings,
      },
    ],
    maxComments: 10,
  });

  assert.deepEqual([inline, unplaced], [[], []]);
  assert.equal(dropped.empty, 1);
});

test("keeps line feeds and tabs in a comment", () => {
  const text = `first line${LINE_FEED}${TAB}indented${LINE_FEED}${LINE_FEED}last`;

  const { review: result } = boundReview(review([finding({ comment: text })]));

  assert.equal(result.findings[0].comment, text);
});

test("turns every kind of line end into a line feed", () => {
  const text = [
    "a",
    `${CARRIAGE_RETURN}${LINE_FEED}`,
    "b",
    CARRIAGE_RETURN,
    "c",
    LINE_SEPARATOR,
    "d",
    PARAGRAPH_SEPARATOR,
    "e",
  ].join("");

  const { review: result } = boundReview(review([finding({ comment: text })]));

  assert.equal(
    result.findings[0].comment,
    ["a", "b", "c", "d", "e"].join(LINE_FEED),
  );
});

test("puts a title on one line", () => {
  const title = `  First${LINE_FEED}second${TAB}third${CARRIAGE_RETURN}${LINE_FEED}${LINE_SEPARATOR}fourth   fifth  `;

  const { review: result } = boundReview(review([finding({ title })]));

  assert.equal(result.findings[0].title, "First second third fourth fifth");
});

test("removes white space around a text", () => {
  const { review: result } = boundReview(
    review(
      [finding({ comment: `${LINE_FEED}  text  ${LINE_FEED}` })],
      "  summary  ",
    ),
  );

  assert.equal(result.findings[0].comment, "text");
  assert.equal(result.summary, "summary");
});

test("cleans a text before it measures it", () => {
  // 150 visible characters with an invisible one after each: nothing is cut.
  const title = `x${ZERO_WIDTH_SPACE}`.repeat(150);

  const { review: result, shortened } = boundReview(
    review([finding({ title })]),
  );

  assert.equal(result.findings[0].title, "x".repeat(150));
  assert.equal(shortened, 0);
});

test("leaves a text of nothing but invisible characters empty, so the finding is dropped later", () => {
  const hidden = `${ZERO_WIDTH_SPACE}${RIGHT_TO_LEFT_OVERRIDE}${TAG_LETTER_A}`;

  const { review: result } = boundReview(
    review([finding({ comment: hidden })]),
  );

  assert.equal(result.findings[0].comment, "");
  const { inline, unplaced, dropped } = selectFindings({
    reviews: [
      {
        files: [{ path: "src/a.js", commentableLines: [3] }],
        findings: result.findings,
      },
    ],
    maxComments: 10,
  });
  assert.deepEqual([inline, unplaced], [[], []]);
  assert.equal(dropped.empty, 1);
});

// --- What is not touched -----------------------------------------------------

test("passes path, line, severity and category on as they are", () => {
  const input = finding({
    path: "src/deep/File.cs",
    line: 4711,
    severity: "critical",
    category: "security",
  });

  const { review: result } = boundReview(review([input]));

  const { path, line, severity, category } = result.findings[0];
  assert.deepEqual(
    { path, line, severity, category },
    {
      path: "src/deep/File.cs",
      line: 4711,
      severity: "critical",
      category: "security",
    },
  );
});

test("leaves Markdown to whatever renders the text", () => {
  // Images, links, mentions and HTML are made harmless where the comment is
  // built (#17). Here the text is only bounded and cleaned.
  const comment =
    "![x](https://example.invalid/a.png) @someone <b>bold</b> [l](https://example.invalid)";

  const { review: result } = boundReview(review([finding({ comment })]));

  assert.equal(result.findings[0].comment, comment);
});

test("keeps the order and the number of the findings", () => {
  const input = review([
    finding({ title: "one" }),
    finding({ title: "two" }),
    finding({ title: "three" }),
  ]);

  const { review: result } = boundReview(input);

  assert.deepEqual(
    result.findings.map((item) => item.title),
    ["one", "two", "three"],
  );
});

test("handles a review without findings", () => {
  assert.deepEqual(boundReview(review([], "Nothing stands out.")), {
    review: { summary: "Nothing stands out.", findings: [] },
    shortened: 0,
  });
});

// --- A pure function ---------------------------------------------------------

test("does not change what it is given and repeats its result", () => {
  const long = "x".repeat(3000);
  const input = review([finding({ comment: long })], long);
  const frozen = Object.freeze({
    summary: input.summary,
    findings: Object.freeze(input.findings.map((item) => Object.freeze(item))),
  });
  const before = JSON.stringify(frozen);

  const first = boundReview(frozen);
  const second = boundReview(frozen);

  assert.equal(JSON.stringify(frozen), before);
  assert.deepEqual(first, second);
  assert.notEqual(first.review.findings, frozen.findings);
  assert.notEqual(first.review.findings[0], frozen.findings[0]);
});

test("stays fast for a very long text", () => {
  const huge = `${ROCKET}${ZERO_WIDTH_SPACE}x `.repeat(250000);

  const started = performance.now();
  boundReview(
    review([finding({ title: huge, comment: huge, suggestion: huge })], huge),
  );
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 2000, `bounding took ${Math.round(elapsed)} ms`);
});

test("depends on nothing outside of the module", () => {
  const source = readFileSync(fromRoot("src/ai/answer-limits.js"), "utf8");

  // Comments may name a type with `import("…")`; only code counts here.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  assert.doesNotMatch(code, /^import /m);
  assert.doesNotMatch(code, /\bimport\(|\brequire\(/);
  assert.doesNotMatch(code, /\b(process|globalThis|fetch|Date)\b/);
});
