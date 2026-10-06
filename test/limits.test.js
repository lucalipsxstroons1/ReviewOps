import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { annotateDiff } from "../src/diff/annotate.js";
import { parsePatch } from "../src/diff/parse.js";
import {
  DEFAULT_MAX_DIFF_CHARS,
  DEFAULT_MAX_FILES,
  OVER_LIMIT_REASONS,
  applyLimits,
  parseLimits,
} from "../src/limits.js";
import { fromRoot } from "./helpers/run-action.js";

const ESCAPE = String.fromCodePoint(0x1b);

/** A parsed file with `lines` added lines, as run() hands them over. */
function diffOf(path, lines = 1, text = "x") {
  const rows = Array.from({ length: lines }, () => `+${text}`);
  const patch = [`@@ -0,0 +1,${lines} @@`, ...rows].join("\n");
  return { path, ...parsePatch(patch) };
}

/** How many characters the annotated diff of a file has. */
const sizeOf = (diff) => annotateDiff(diff.hunks).length;

const LIMITS = { maxFiles: 50, maxDiffChars: 200000 };

// --- Reading the limits ------------------------------------------------------

test("uses the defaults when the inputs are empty or missing", () => {
  const expected = { maxFiles: 50, maxDiffChars: 200000 };

  assert.deepEqual(parseLimits(), expected);
  assert.deepEqual(parseLimits({}), expected);
  assert.deepEqual(parseLimits({ maxFiles: "", maxDiffChars: "" }), expected);
  assert.deepEqual(
    parseLimits({ maxFiles: "  ", maxDiffChars: "\n" }),
    expected,
  );
  assert.equal(DEFAULT_MAX_FILES, 50);
  assert.equal(DEFAULT_MAX_DIFF_CHARS, 200000);
});

test("reads whole numbers", () => {
  assert.deepEqual(parseLimits({ maxFiles: "10", maxDiffChars: "5000" }), {
    maxFiles: 10,
    maxDiffChars: 5000,
  });
  assert.deepEqual(parseLimits({ maxFiles: " 7 ", maxDiffChars: "007" }), {
    maxFiles: 7,
    maxDiffChars: 7,
  });
});

test("accepts the smallest and the largest value", () => {
  assert.deepEqual(parseLimits({ maxFiles: "1", maxDiffChars: "999999999" }), {
    maxFiles: 1,
    maxDiffChars: 999999999,
  });
});

test("sets one limit and leaves the other at its default", () => {
  assert.deepEqual(parseLimits({ maxFiles: "5" }), {
    maxFiles: 5,
    maxDiffChars: 200000,
  });
  assert.deepEqual(parseLimits({ maxDiffChars: "5" }), {
    maxFiles: 50,
    maxDiffChars: 5,
  });
});

const INVALID = [
  ["zero", "0"],
  ["a negative number", "-5"],
  ["a number with a plus sign", "+5"],
  ["a decimal number", "2.5"],
  ["a number with a thousands separator", "1,000"],
  ["a number in exponent notation", "1e3"],
  ["a hexadecimal number", "0x10"],
  ["text", "many"],
  ["a number followed by text", "10 files"],
  ["two numbers", "10 20"],
  ["a number with ten digits", "1000000000"],
  ["zeros that hide a large number", `${"0".repeat(20)}5`],
  ["Infinity", "Infinity"],
  ["not a number", "NaN"],
  ["null", "null"],
];

for (const [name, value] of INVALID) {
  for (const [input, key] of [
    ["max-files", "maxFiles"],
    ["max-diff-chars", "maxDiffChars"],
  ]) {
    test(`rejects ${name} for ${input} and says what is allowed`, () => {
      assert.throws(
        () => parseLimits({ [key]: value }),
        (error) => {
          assert.equal(
            error.message,
            `Input \`${input}\` must be a whole number from 1 to 999999999, but is "${value}".`,
          );
          return true;
        },
      );
    });
  }
}

test("shows an odd value as harmless text, shortened", () => {
  const odd = `1${ESCAPE}[31m`;

  assert.throws(
    () => parseLimits({ maxFiles: odd }),
    (error) => {
      assert.equal(error.message.includes(ESCAPE), false);
      assert.match(error.message, /"1\\u001b\[31m"/);
      return true;
    },
  );
  assert.throws(
    () => parseLimits({ maxFiles: "x".repeat(5000) }),
    (error) => error.message.length < 300,
  );
});

// --- Choosing the files ------------------------------------------------------

test("takes every file when the limits are not reached", () => {
  const diffs = [diffOf("a.js"), diffOf("b.js", 3), diffOf("c.js", 2)];

  const { selected, overLimit, usedChars } = applyLimits(diffs, LIMITS);

  assert.deepEqual(
    selected.map((diff) => diff.path),
    ["a.js", "b.js", "c.js"],
  );
  assert.deepEqual(overLimit, []);
  assert.equal(
    usedChars,
    diffs.reduce((sum, diff) => sum + sizeOf(diff), 0),
  );
});

test("keeps the annotated diff with each selected file", () => {
  const diffs = [diffOf("a.js", 2, "alpha"), diffOf("b.js", 1, "beta")];

  const { selected } = applyLimits(diffs, LIMITS);

  assert.equal(selected[0].annotated, annotateDiff(diffs[0].hunks));
  assert.equal(selected[1].annotated, annotateDiff(diffs[1].hunks));
  // The other fields of the file stay.
  assert.deepEqual(selected[0].commentableLines, [1, 2]);
  assert.equal(selected[0].hunks, diffs[0].hunks);
});

test("measures the text that goes to the model", () => {
  // "@@" and a line break, then "   1 | +x": four digits, " | ", the marker.
  assert.equal(sizeOf(diffOf("a.js")), "@@\n   1 | +x".length);
  assert.equal(sizeOf(diffOf("a.js")), 12);

  const { usedChars } = applyLimits([diffOf("a.js")], LIMITS);

  assert.equal(usedChars, 12);
});

test("stops at max-files and names the reason", () => {
  const diffs = ["a", "b", "c", "d", "e"].map((name) => diffOf(`${name}.js`));

  const { selected, overLimit } = applyLimits(diffs, {
    maxFiles: 3,
    maxDiffChars: 200000,
  });

  assert.deepEqual(
    selected.map((diff) => diff.path),
    ["a.js", "b.js", "c.js"],
  );
  assert.deepEqual(overLimit, [
    { path: "d.js", reason: "over the limit of 3 files (max-files)" },
    { path: "e.js", reason: "over the limit of 3 files (max-files)" },
  ]);
});

test("takes exactly max-files files without leaving one out", () => {
  const diffs = [diffOf("a.js"), diffOf("b.js")];

  const { selected, overLimit } = applyLimits(diffs, {
    maxFiles: 2,
    maxDiffChars: 200000,
  });

  assert.equal(selected.length, 2);
  assert.deepEqual(overLimit, []);
});

test("leaves out a file that does not fit and still takes later, smaller ones", () => {
  const small = (path) => diffOf(path, 1);
  const huge = diffOf("huge.js", 40);
  const diffs = [small("a.js"), huge, small("c.js"), small("d.js")];
  const budget = sizeOf(small("a.js")) * 3;

  const { selected, overLimit, usedChars } = applyLimits(diffs, {
    maxFiles: 50,
    maxDiffChars: budget,
  });

  assert.deepEqual(
    selected.map((diff) => diff.path),
    ["a.js", "c.js", "d.js"],
  );
  assert.deepEqual(overLimit, [
    {
      path: "huge.js",
      reason: `does not fit into the budget of ${budget} characters (max-diff-chars)`,
    },
  ]);
  assert.equal(usedChars, budget);
});

test("takes a file that fills the budget exactly, not one that exceeds it", () => {
  const first = diffOf("a.js", 2);
  const second = diffOf("b.js", 3);
  const exact = sizeOf(first) + sizeOf(second);

  const fits = applyLimits([first, second], {
    maxFiles: 50,
    maxDiffChars: exact,
  });
  const tooSmall = applyLimits([first, second], {
    maxFiles: 50,
    maxDiffChars: exact - 1,
  });

  assert.equal(fits.selected.length, 2);
  assert.equal(fits.usedChars, exact);
  assert.deepEqual(
    tooSmall.selected.map((diff) => diff.path),
    ["a.js"],
  );
  assert.deepEqual(
    tooSmall.overLimit.map((entry) => entry.path),
    ["b.js"],
  );
});

test("selects nothing when the only file is larger than the budget", () => {
  const { selected, overLimit, usedChars } = applyLimits(
    [diffOf("huge.js", 100)],
    { maxFiles: 50, maxDiffChars: 100 },
  );

  assert.deepEqual(selected, []);
  assert.equal(overLimit.length, 1);
  assert.equal(usedChars, 0);
});

test("names the file limit for files after it, even if they are also too large", () => {
  const diffs = [diffOf("a.js"), diffOf("huge.js", 100)];

  const { overLimit } = applyLimits(diffs, { maxFiles: 1, maxDiffChars: 50 });

  assert.deepEqual(overLimit, [
    { path: "huge.js", reason: "over the limit of 1 files (max-files)" },
  ]);
});

test("does not look at files after max-files", () => {
  // A file after the limit is not annotated: for a pull request with
  // thousands of files this saves the work.
  const untouched = {
    path: "late.js",
    get hunks() {
      throw new Error("a file over the limit was annotated");
    },
  };

  const { selected, overLimit } = applyLimits(
    [diffOf("a.js"), untouched, untouched],
    { maxFiles: 1, maxDiffChars: 200000 },
  );

  assert.equal(selected.length, 1);
  assert.equal(overLimit.length, 2);
});

test("keeps the order in which the files were listed", () => {
  const names = ["Z.js", "a.js", "m.js", "B.js"];

  const { selected } = applyLimits(
    names.map((name) => diffOf(name)),
    LIMITS,
  );

  assert.deepEqual(
    selected.map((diff) => diff.path),
    names,
  );
});

test("handles a pull request without files", () => {
  assert.deepEqual(applyLimits([], LIMITS), {
    selected: [],
    overLimit: [],
    usedChars: 0,
  });
});

test("handles a pull request with 3000 files quickly", () => {
  const diffs = Array.from({ length: 3000 }, (_, index) =>
    diffOf(`src/file-${index}.js`, 20),
  );

  const started = performance.now();
  const { selected, overLimit } = applyLimits(diffs, LIMITS);
  const elapsed = performance.now() - started;

  assert.equal(selected.length, 50);
  assert.equal(overLimit.length, 2950);
  assert.ok(elapsed < 1000, `selecting took ${Math.round(elapsed)} ms`);
});

test("handles a file with 300000 added lines", () => {
  const huge = diffOf("huge.js", 300000);

  const started = performance.now();
  const { selected, overLimit } = applyLimits([huge], LIMITS);
  const elapsed = performance.now() - started;

  assert.deepEqual(selected, []);
  assert.equal(overLimit.length, 1);
  assert.ok(elapsed < 2000, `selecting took ${Math.round(elapsed)} ms`);
});

// --- A pure function ---------------------------------------------------------

test("does not change what it is given and repeats its result", () => {
  const diffs = [diffOf("a.js"), diffOf("huge.js", 50), diffOf("c.js")];
  const limits = { maxFiles: 2, maxDiffChars: 100 };
  const before = JSON.stringify({ diffs, limits });

  const first = applyLimits(diffs, limits);
  const second = applyLimits(diffs, limits);

  assert.equal(JSON.stringify({ diffs, limits }), before);
  assert.equal(Object.isFrozen(limits), false);
  assert.deepEqual(first, second);
  assert.notEqual(first.selected, second.selected);
  assert.equal("annotated" in diffs[0], false);
});

test("exposes the reasons as fixed texts", () => {
  assert.ok(Object.isFrozen(OVER_LIMIT_REASONS));
  assert.equal(
    OVER_LIMIT_REASONS.files(7),
    "over the limit of 7 files (max-files)",
  );
});

test("depends only on the annotation and on printable()", () => {
  const source = readFileSync(fromRoot("src/limits.js"), "utf8");

  const imports = [...source.matchAll(/^import .* from "(.*)";$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports.sort(), ["./diff/annotate.js", "./printable.js"]);
  assert.doesNotMatch(source, /\b(process|globalThis|fetch|Date|require)\b/);
});
