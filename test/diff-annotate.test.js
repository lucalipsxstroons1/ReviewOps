import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { annotateDiff } from "../src/diff/annotate.js";
import { parsePatch } from "../src/diff/parse.js";
import { fromRoot } from "./helpers/run-action.js";

const CARRIAGE_RETURN = String.fromCodePoint(0x0d);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const NEXT_LINE = String.fromCodePoint(0x85);
const VERTICAL_TAB = String.fromCodePoint(0x0b);
const FORM_FEED = String.fromCodePoint(0x0c);
const ESCAPE = String.fromCodePoint(0x1b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const TAG_CHARACTER = String.fromCodePoint(0xe0041);

/** A backslash, u and the code point, as the output shows a character. */
const shown = (codePoint) => `${String.fromCodePoint(0x5c)}u${codePoint}`;

/** The annotated text of a patch, row by row. */
const annotate = (...rows) =>
  annotateDiff(parsePatch(rows.join("\n")).hunks).split("\n");

/** The line numbers that appear in the number column of the output. */
const numbersIn = (rows) =>
  rows
    .filter((row) => !row.startsWith("@@"))
    .map((row) => row.split(" | ")[0].trim())
    .filter((number) => number !== "")
    .map(Number);

test("shows line number, marker and code for each line", () => {
  const rows = annotate(
    "@@ -10,3 +10,4 @@ function total(items) {",
    "   const tax = 0.19;",
    "-  return items.length;",
    "+  const sum = items.reduce(add, 0);",
    "+  return sum * (1 + tax);",
    " }",
  );

  assert.deepEqual(rows, [
    "@@ function total(items) {",
    "     |    const tax = 0.19;",
    "     | -  return items.length;",
    "  11 | +  const sum = items.reduce(add, 0);",
    "  12 | +  return sum * (1 + tax);",
    "     |  }",
  ]);
});

test("numbers only the lines that can receive a comment", () => {
  const patch = [
    "@@ -1,4 +1,5 @@",
    " a",
    "-b",
    "+B",
    " c",
    "+c2",
    " d",
    "@@ -30,2 +31,3 @@",
    " x",
    "+y",
    " z",
  ].join("\n");
  const { hunks, commentableLines } = parsePatch(patch);

  const rows = annotateDiff(hunks).split("\n");

  assert.deepEqual(numbersIn(rows), commentableLines);
  assert.deepEqual(numbersIn(rows), [2, 4, 32]);
});

test("leaves the numbers of the hunk header out", () => {
  const rows = annotate(
    "@@ -120,2 +125,2 @@ class Cart {",
    " a",
    "-b",
    "+c",
    "@@ -300 +305 @@",
    "-d",
    "+e",
  );

  assert.equal(rows[0], "@@ class Cart {");
  assert.equal(rows[4], "@@");
  assert.doesNotMatch(rows.join("\n"), /120|125|300|305(?! \|)/);
  assert.deepEqual(numbersIn(rows), [126, 305]);
});

test("shows no number at all when lines were only removed", () => {
  const rows = annotate("@@ -4,4 +4,2 @@", " a", "-b", "-c", " d");

  assert.deepEqual(rows, [
    "@@",
    "     |  a",
    "     | -b",
    "     | -c",
    "     |  d",
  ]);
});

test("numbers every line of a new file", () => {
  const rows = annotate("@@ -0,0 +1,3 @@", "+a", "+b", "+c");

  assert.deepEqual(rows, ["@@", "   1 | +a", "   2 | +b", "   3 | +c"]);
});

test("leaves the note about a missing line break out", () => {
  const rows = annotate(
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
  );

  assert.deepEqual(rows, ["@@", "     | -old", "   1 | +new"]);
});

test("keeps all rows aligned when line numbers get long", () => {
  const rows = annotate(
    "@@ -99998,2 +99998,3 @@",
    " a",
    "+b",
    " c",
    "@@ -123456,1 +123457,2 @@",
    " d",
    "+e",
  );

  assert.deepEqual(rows, [
    "@@",
    "       |  a",
    " 99999 | +b",
    "       |  c",
    "@@",
    "       |  d",
    "123458 | +e",
  ]);
});

test("removes the carriage return of Windows line endings", () => {
  const rows = annotate(
    "@@ -1 +1,2 @@",
    ` a${CARRIAGE_RETURN}`,
    `+b${CARRIAGE_RETURN}`,
  );

  assert.deepEqual(rows, ["@@", "     |  a", "   2 | +b"]);
});

test("shows a line break inside a line by its code point, so no code poses as a numbered row", () => {
  for (const [breaker, code] of [
    [CARRIAGE_RETURN, "000d"],
    [LINE_SEPARATOR, "2028"],
    [PARAGRAPH_SEPARATOR, "2029"],
    [NEXT_LINE, "0085"],
    [VERTICAL_TAB, "000b"],
    [FORM_FEED, "000c"],
  ]) {
    const text = annotateDiff(
      parsePatch(`@@ -0,0 +1 @@\n+a = 1;${breaker}  99 | +fake()`).hunks,
    );

    assert.equal(text, `@@\n   1 | +a = 1;${shown(code)}  99 | +fake()`, code);
    // Apart from the line feeds between the rows, nothing could break a line.
    assert.doesNotMatch(text.replaceAll("\n", ""), /[\p{Cc}\p{Zl}\p{Zp}]/u);
  }
});

test("shows control and invisible format characters by their code point", () => {
  const rows = annotate(
    "@@ -0,0 +1,4 @@",
    `+const s = "${ESCAPE}[31m";`,
    `+if (isAdmin ${RIGHT_TO_LEFT_OVERRIDE}) {`,
    `+let a${ZERO_WIDTH_SPACE}b = 1;`,
    `+tag${TAG_CHARACTER}`,
  );

  assert.deepEqual(rows, [
    "@@",
    `   1 | +const s = "${shown("001b")}[31m";`,
    `   2 | +if (isAdmin ${shown("202e")}) {`,
    `   3 | +let a${shown("200b")}b = 1;`,
    `   4 | +tag${shown("e0041")}`,
  ]);
});

test("shows control characters in the section of a hunk as well", () => {
  const rows = annotate(
    `@@ -1 +1 @@ function f()${LINE_SEPARATOR}  7 | +x`,
    "-a",
    "+b",
  );

  assert.equal(rows[0], `@@ function f()${shown("2028")}  7 | +x`);
});

test("keeps the code itself unchanged, including its indentation", () => {
  const rows = annotate(
    "@@ -1,2 +1,4 @@",
    " \tindented with a tab",
    "+    | 99 | +looks like a numbered row",
    "+",
    " end",
  );

  assert.deepEqual(rows, [
    "@@",
    "     |  \tindented with a tab",
    "   2 | +    | 99 | +looks like a numbered row",
    "   3 | +",
    "     |  end",
  ]);
});

test("returns an empty text when there are no hunks", () => {
  assert.equal(annotateDiff([]), "");
});

test("annotates a real patch with exactly its added lines", () => {
  const fixture = JSON.parse(
    readFileSync(fromRoot("test/fixtures/real-patch.json"), "utf8"),
  );
  const fileLines = fixture.content.split("\n");
  const { hunks, commentableLines } = parsePatch(fixture.patch);

  const rows = annotateDiff(hunks).split("\n");

  assert.deepEqual(numbersIn(rows), commentableLines);
  for (const row of rows) {
    const [number, rest] = [row.slice(0, 4).trim(), row.slice(7)];
    if (row.startsWith("@@") || number === "") continue;
    assert.equal(rest.slice(1), fileLines[Number(number) - 1]);
  }
});

test("depends on nothing outside of the module", () => {
  const source = readFileSync(fromRoot("src/diff/annotate.js"), "utf8");

  assert.doesNotMatch(source, /^import /m);
  assert.doesNotMatch(source, /\bimport\(|\brequire\(/);
});
