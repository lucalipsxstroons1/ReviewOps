import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PatchFormatError, parsePatch } from "../src/diff/parse.js";
import { fromRoot } from "./helpers/run-action.js";

const CARRIAGE_RETURN = String.fromCodePoint(0x0d);
const NO_NEWLINE = "\\ No newline at end of file";

/** A patch from its rows, joined the way GitHub sends them. */
const patchOf = (...rows) => rows.join("\n");

/** All lines of a parsed patch as `[type, line, content]`. */
const linesOf = (parsed) =>
  parsed.hunks.flatMap((hunk) =>
    hunk.lines.map(({ type, line, content }) => [type, line, content]),
  );

// --- Hunk headers ------------------------------------------------------------

test("reads a hunk header with both lengths", () => {
  const parsed = parsePatch(
    patchOf("@@ -7,3 +7,4 @@", " a", "-b", "+c", "+d", " e"),
  );

  assert.deepEqual(linesOf(parsed), [
    ["context", 7, "a"],
    ["removed", null, "b"],
    ["added", 8, "c"],
    ["added", 9, "d"],
    ["context", 10, "e"],
  ]);
  assert.deepEqual(parsed.commentableLines, [8, 9]);
});

test("reads the short form, where a missing length means one line", () => {
  assert.deepEqual(
    linesOf(parsePatch(patchOf("@@ -3 +3 @@", "-old", "+new"))),
    [
      ["removed", null, "old"],
      ["added", 3, "new"],
    ],
  );
  assert.deepEqual(
    parsePatch(patchOf("@@ -3 +3,2 @@", "-old", "+new", "+more"))
      .commentableLines,
    [3, 4],
  );
  assert.deepEqual(
    parsePatch(patchOf("@@ -3,2 +3 @@", "-old", "-gone", "+new"))
      .commentableLines,
    [3],
  );
});

test("keeps the section that follows the header", () => {
  const withSection = parsePatch(
    patchOf("@@ -10 +10 @@ function total(items) {", "-a", "+b"),
  );
  const without = parsePatch(patchOf("@@ -10 +10 @@", "-a", "+b"));

  assert.equal(withSection.hunks[0].section, "function total(items) {");
  assert.equal(without.hunks[0].section, "");
});

test("reads a section that itself looks like a header", () => {
  const parsed = parsePatch(patchOf("@@ -1 +1 @@ @@ -5 +5 @@", "-a", "+b"));

  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.hunks[0].section, "@@ -5 +5 @@");
  assert.deepEqual(parsed.commentableLines, [1]);
});

// --- Special cases -----------------------------------------------------------

test("numbers the lines of a new file from 1", () => {
  const parsed = parsePatch(patchOf("@@ -0,0 +1,3 @@", "+a", "+b", "+c"));

  assert.deepEqual(parsed.commentableLines, [1, 2, 3]);
  assert.deepEqual(linesOf(parsed), [
    ["added", 1, "a"],
    ["added", 2, "b"],
    ["added", 3, "c"],
  ]);
});

test("reads a new file with a single line", () => {
  assert.deepEqual(
    parsePatch(patchOf("@@ -0,0 +1 @@", "+only")).commentableLines,
    [1],
  );
});

test("starts the numbering again at every hunk", () => {
  const parsed = parsePatch(
    patchOf(
      "@@ -1,3 +1,4 @@",
      " a",
      "+b",
      " c",
      " d",
      "@@ -20,3 +21,3 @@ function later() {",
      " x",
      "-y",
      "+z",
      " w",
      "@@ -40 +41,2 @@",
      " last",
      "+appended",
    ),
  );

  assert.equal(parsed.hunks.length, 3);
  assert.deepEqual(
    parsed.hunks.map((hunk) => hunk.lines.map((line) => line.line)),
    [
      [1, 2, 3, 4],
      [21, null, 22, 23],
      [41, 42],
    ],
  );
  assert.deepEqual(parsed.commentableLines, [2, 22, 42]);
});

test("offers no comment target when a hunk only removes lines", () => {
  const parsed = parsePatch(patchOf("@@ -4,4 +4,2 @@", " a", "-b", "-c", " d"));

  assert.deepEqual(parsed.commentableLines, []);
  assert.deepEqual(linesOf(parsed), [
    ["context", 4, "a"],
    ["removed", null, "b"],
    ["removed", null, "c"],
    ["context", 5, "d"],
  ]);
});

test("reads a patch that empties a file", () => {
  const parsed = parsePatch(patchOf("@@ -1,2 +0,0 @@", "-a", "-b"));

  assert.deepEqual(parsed.commentableLines, []);
  assert.deepEqual(linesOf(parsed), [
    ["removed", null, "a"],
    ["removed", null, "b"],
  ]);
});

test("does not count the note about a missing line break at the end", () => {
  const parsed = parsePatch(
    patchOf("@@ -1,2 +1,2 @@", " a", "-old", NO_NEWLINE, "+new", NO_NEWLINE),
  );

  assert.deepEqual(linesOf(parsed), [
    ["context", 1, "a"],
    ["removed", null, "old"],
    ["added", 2, "new"],
  ]);
  assert.deepEqual(parsed.commentableLines, [2]);
});

test("reads a hunk that follows the note about a missing line break", () => {
  // Not a shape git produces, but nothing here may depend on that.
  const parsed = parsePatch(
    patchOf("@@ -1 +1 @@", "-a", "+b", NO_NEWLINE, "@@ -9 +9 @@", "-c", "+d"),
  );

  assert.deepEqual(parsed.commentableLines, [1, 9]);
});

test("keeps the numbers right in a file with Windows line endings", () => {
  const parsed = parsePatch(
    patchOf(
      "@@ -1,2 +1,4 @@",
      ` a${CARRIAGE_RETURN}`,
      `+b${CARRIAGE_RETURN}`,
      `+c${CARRIAGE_RETURN}`,
      ` d${CARRIAGE_RETURN}`,
    ),
  );

  assert.deepEqual(parsed.commentableLines, [2, 3]);
  assert.equal(parsed.hunks[0].lines[1].content, `b${CARRIAGE_RETURN}`);
});

test("counts an empty row as an empty context line", () => {
  const parsed = parsePatch(patchOf("@@ -1,3 +1,3 @@", " a", "", "-b", "+c"));

  assert.deepEqual(linesOf(parsed), [
    ["context", 1, "a"],
    ["context", 2, ""],
    ["removed", null, "b"],
    ["added", 3, "c"],
  ]);
});

test("ignores one line break at the end of the patch", () => {
  const parsed = parsePatch(`${patchOf("@@ -1 +1 @@", "-a", "+b")}\n`);

  assert.deepEqual(parsed.commentableLines, [1]);
  assert.equal(parsed.hunks.length, 1);
});

test("reads code that looks like a part of a diff as code", () => {
  // A removed line "-- a/x" and an added line "++ b/y" look like the file
  // header of a full diff. A line of code can also look like a hunk header.
  const parsed = parsePatch(
    patchOf(
      "@@ -1,3 +1,3 @@",
      " a",
      "--- a/x",
      "+++ b/y",
      "-@@ -1 +1 @@",
      "+@@ -9,9 +9,9 @@",
    ),
  );

  assert.deepEqual(linesOf(parsed), [
    ["context", 1, "a"],
    ["removed", null, "-- a/x"],
    ["added", 2, "++ b/y"],
    ["removed", null, "@@ -1 +1 @@"],
    ["added", 3, "@@ -9,9 +9,9 @@"],
  ]);
});

// --- Comment targets ---------------------------------------------------------

test("offers exactly the added lines as comment targets", () => {
  const parsed = parsePatch(
    patchOf(
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
    ),
  );

  const added = linesOf(parsed)
    .filter(([type]) => type === "added")
    .map(([, line]) => line);
  assert.deepEqual(parsed.commentableLines, added);
  assert.deepEqual(parsed.commentableLines, [2, 4, 32]);
});

// --- A patch as GitHub returned it -------------------------------------------

test("numbers a real patch the way the file itself is numbered", () => {
  const fixture = JSON.parse(
    readFileSync(fromRoot("test/fixtures/real-patch.json"), "utf8"),
  );
  const fileLines = fixture.content.split("\n");

  const parsed = parsePatch(fixture.patch);

  const lines = parsed.hunks.flatMap((hunk) => hunk.lines);
  for (const { type, line, content } of lines) {
    if (type === "removed") continue;
    assert.equal(content, fileLines[line - 1], `line ${line} of the file`);
  }
  assert.ok(parsed.hunks.length > 1, "the fixture must have several hunks");
  assert.equal(parsed.commentableLines.length, fixture.additions);
  assert.equal(
    lines.filter((line) => line.type === "removed").length,
    fixture.deletions,
  );
});

// --- Patches that cannot be read ---------------------------------------------

const UNREADABLE = [
  ["no text at all", undefined, /is empty/],
  ["null", null, /is empty/],
  ["a number", 42, /is empty/],
  ["an empty text", "", /is empty/],
  ["text without a hunk header", "just some text", /Row 1 .* hunk header/],
  [
    "a full diff with a file header",
    patchOf("diff --git a/x b/x", "@@ -1 +1 @@", "-a", "+b"),
    /Row 1 .* hunk header/,
  ],
  [
    "the header of a combined diff",
    patchOf("@@@ -1 -1 +1 @@@", "- a", " +b"),
    /Row 1 .* hunk header/,
  ],
  [
    "a line number with too many digits",
    patchOf("@@ -1 +12345678901 @@", "-a", "+b"),
    /Row 1 .* hunk header/,
  ],
  [
    "a row with an unknown marker",
    patchOf("@@ -1,2 +1,2 @@", " a", "?b", "+c"),
    /Row 3 .* does not fit into hunk 1/,
  ],
  [
    "a hunk that ends too early",
    patchOf("@@ -1,3 +1,3 @@", " a", "-b"),
    /Hunk 1 .* ends before/,
  ],
  [
    "a second hunk that ends too early",
    patchOf("@@ -1 +1 @@", "-a", "+b", "@@ -9,2 +9,2 @@", " c"),
    /Hunk 2 .* ends before/,
  ],
  [
    "more added lines than the header announces",
    patchOf("@@ -2,2 +2 @@", "+a", "+b", "-c", "-d"),
    /Row 3 .* does not fit into hunk 1/,
  ],
  [
    "more removed lines than the header announces",
    patchOf("@@ -2 +2,2 @@", "-a", "-b", "+c", "+d"),
    /Row 3 .* does not fit into hunk 1/,
  ],
  [
    "rows after the last line of a hunk",
    patchOf("@@ -1 +1 @@", "-a", "+b", "+c"),
    /Row 4 .* hunk header/,
  ],
  [
    "new lines that start at line 0",
    patchOf("@@ -0,0 +0,2 @@", "+a", "+b"),
    /Hunk 1 .* not possible/,
  ],
  [
    "a hunk that starts before the previous one ends",
    patchOf("@@ -1,2 +1,2 @@", " a", "+b", "-c", "@@ -5 +2 @@", "-d", "+e"),
    /Hunk 2 .* not possible/,
  ],
];

for (const [name, patch, expected] of UNREADABLE) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => parsePatch(patch),
      (error) => {
        assert.ok(error instanceof PatchFormatError);
        assert.equal(error.name, "PatchFormatError");
        assert.match(error.message, expected);
        return true;
      },
    );
  });
}

test("never repeats the content of a patch in an error", () => {
  const patches = [
    "CONTENT-FROM-AUTHOR",
    patchOf("@@ -1,2 +1,2 @@", " a", "?CONTENT-FROM-AUTHOR"),
    patchOf("@@ -1,3 +1,3 @@ CONTENT-FROM-AUTHOR", " CONTENT-FROM-AUTHOR"),
    patchOf("@@ -1 +1 @@", "-a", "+b", "CONTENT-FROM-AUTHOR"),
  ];

  for (const patch of patches) {
    assert.throws(
      () => parsePatch(patch),
      (error) => {
        assert.doesNotMatch(
          `${error.message}\n${error.stack}`,
          /CONTENT-FROM-AUTHOR/,
        );
        return true;
      },
    );
  }
});

// --- A pure function ---------------------------------------------------------

test("returns the same result for the same patch, as separate objects", () => {
  const patch = patchOf("@@ -1,2 +1,3 @@", " a", "+b", " c");

  const first = parsePatch(patch);
  const second = parsePatch(patch);

  assert.deepEqual(first, second);
  assert.notEqual(first.hunks, second.hunks);
  first.commentableLines.push(99);
  assert.deepEqual(second.commentableLines, [2]);
});

test("depends on nothing outside of the module", () => {
  const source = readFileSync(fromRoot("src/diff/parse.js"), "utf8");

  assert.doesNotMatch(source, /^import /m);
  assert.doesNotMatch(source, /\bimport\(|\brequire\(/);
  assert.doesNotMatch(source, /\b(process|globalThis|fetch|Date)\b/);
});
