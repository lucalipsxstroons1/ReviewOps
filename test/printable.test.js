import assert from "node:assert/strict";
import { test } from "node:test";
import { printable } from "../src/printable.js";

// Special characters are built from their code points. Writing them as
// escapes or as literals would put invisible characters into this file.
const char = (codePoint) => String.fromCodePoint(codePoint);
const LINE_FEED = char(0x0a);
const CARRIAGE_RETURN = char(0x0d);
const NEXT_LINE = char(0x85);
const LINE_SEPARATOR = char(0x2028);
const PARAGRAPH_SEPARATOR = char(0x2029);
const RIGHT_TO_LEFT_OVERRIDE = char(0x202e);
const ZERO_WIDTH_SPACE = char(0x200b);

const LINE_BREAKS = [
  LINE_FEED,
  CARRIAGE_RETURN,
  NEXT_LINE,
  LINE_SEPARATOR,
  PARAGRAPH_SEPARATOR,
];

test("leaves ordinary text untouched", () => {
  assert.equal(printable("src/Größe/index.js"), "src/Größe/index.js");
});

test("shows a line break instead of writing it", () => {
  const result = printable(`docs/a.md${LINE_FEED}::error::injected`);

  assert.equal(result, "docs/a.md\\u000a::error::injected");
  assert.equal(result.includes(LINE_FEED), false);
});

test("shows carriage returns, tabs and other control characters", () => {
  const text = ["a", CARRIAGE_RETURN, "b", char(0x09), "c", char(0), "d"];

  assert.equal(printable(text.join("")), "a\\u000db\\u0009c\\u0000d");
});

test("shows the Unicode line and paragraph separators", () => {
  const text = `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`;

  assert.equal(printable(text), "a\\u2028b\\u2029c");
});

test("shows invisible characters that reorder or hide text", () => {
  const text = `a${RIGHT_TO_LEFT_OVERRIDE}b${ZERO_WIDTH_SPACE}c`;

  assert.equal(printable(text), "a\\u202eb\\u200bc");
});

test("never returns more than one line", () => {
  for (let codePoint = 0; codePoint < 0x3000; codePoint++) {
    const result = printable(`before${char(codePoint)}after`);

    for (const lineBreak of LINE_BREAKS) {
      assert.equal(
        result.includes(lineBreak),
        false,
        `code point ${codePoint.toString(16)} left a line break`,
      );
    }
  }
});

test("shortens very long text", () => {
  const result = printable("a".repeat(500));

  assert.equal(result.length, 201);
  assert.ok(result.endsWith("…"));
});

test("turns non-string values into text", () => {
  assert.equal(printable(42), "42");
  assert.equal(printable(undefined), "undefined");
});
