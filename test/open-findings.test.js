import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatch } from "../src/diff/parse.js";
import { lineFingerprint, textFingerprint } from "../src/fingerprint.js";
import {
  assessComments,
  countOpenFindings,
  currentEarlierFindings,
  openEarlierFindings,
} from "../src/open-findings.js";

const NO_FINDINGS = { critical: 0, major: 0, minor: 0, info: 0 };

/** A parsed file of the pull request. */
const diff = (path, patch) => ({ path, ...parsePatch(patch) });

const APP = diff("src/app.js", "@@ -1,2 +1,3 @@\n a\n-old\n+b\n+c");

// --- currentEarlierFindings() ---------------------------------------------------

test("keeps an earlier finding whose line is still an added line", () => {
  const earlier = [
    {
      id: 1,
      fingerprint: lineFingerprint("src/app.js", "b", "a"),
      severity: "critical",
    },
    {
      id: 2,
      fingerprint: lineFingerprint("src/app.js", "c", "b"),
      severity: "minor",
    },
  ];
  assert.deepEqual(currentEarlierFindings(earlier, [APP]), earlier);
});

test("drops an earlier finding whose line changed or is gone", () => {
  const earlier = [
    // The line itself changed.
    {
      id: 1,
      fingerprint: lineFingerprint("src/app.js", "b2", "a"),
      severity: "critical",
    },
    // The line before it changed.
    {
      id: 2,
      fingerprint: lineFingerprint("src/app.js", "c", "x"),
      severity: "major",
    },
    // Another file.
    {
      id: 3,
      fingerprint: lineFingerprint("src/other.js", "b", "a"),
      severity: "major",
    },
  ];
  assert.deepEqual(currentEarlierFindings(earlier, [APP]), []);
});

test("drops an earlier finding at a line that is only context now", () => {
  const earlier = [
    {
      id: 1,
      fingerprint: lineFingerprint("src/app.js", "a", ""),
      severity: "critical",
    },
  ];
  assert.deepEqual(currentEarlierFindings(earlier, [APP]), []);
});

test("finds an earlier line that moved", () => {
  const moved = diff("src/app.js", "@@ -1,2 +1,5 @@\n+x\n+y\n a\n-old\n+b\n+c");
  const earlier = [
    {
      id: 1,
      fingerprint: lineFingerprint("src/app.js", "b", "a"),
      severity: "major",
    },
  ];
  assert.deepEqual(currentEarlierFindings(earlier, [moved]), earlier);
});

test("has nothing without earlier findings or without files", () => {
  assert.deepEqual(currentEarlierFindings([], [APP]), []);
  const earlier = [
    {
      id: 1,
      fingerprint: lineFingerprint("src/app.js", "b", "a"),
      severity: "major",
    },
  ];
  assert.deepEqual(currentEarlierFindings(earlier, []), []);
});

// --- countOpenFindings() -------------------------------------------------------

test("counts only the new findings when nothing was found before", () => {
  const counts = countOpenFindings({
    newCounts: { critical: 1, major: 2, minor: 0, info: 3 },
    earlier: [],
    resolved: new Set(),
  });
  assert.deepEqual(counts, {
    total: 6,
    bySeverity: { critical: 1, major: 2, minor: 0, info: 3 },
    earlier: 0,
    resolved: 0,
  });
});

test("adds the open earlier findings to the new ones", () => {
  const counts = countOpenFindings({
    newCounts: { ...NO_FINDINGS, minor: 1 },
    earlier: [
      { id: 1, fingerprint: "a".repeat(16), severity: "critical" },
      { id: 2, fingerprint: "b".repeat(16), severity: "major" },
    ],
    resolved: new Set(),
  });
  assert.deepEqual(counts.bySeverity, {
    critical: 1,
    major: 1,
    minor: 1,
    info: 0,
  });
  assert.equal(counts.total, 3);
  assert.equal(counts.earlier, 2);
});

test("leaves out an earlier finding whose thread is resolved", () => {
  const counts = countOpenFindings({
    newCounts: NO_FINDINGS,
    earlier: [
      { id: 1, fingerprint: "a".repeat(16), severity: "critical" },
      { id: 2, fingerprint: "b".repeat(16), severity: "major" },
    ],
    resolved: new Set([1]),
  });
  assert.equal(counts.bySeverity.critical, 0);
  assert.equal(counts.bySeverity.major, 1);
  assert.equal(counts.total, 1);
  assert.equal(counts.resolved, 1);
});

test("counts a fingerprint once, with the most serious open comment", () => {
  const print = "a".repeat(16);
  const counts = countOpenFindings({
    newCounts: NO_FINDINGS,
    earlier: [
      { id: 1, fingerprint: print, severity: "minor" },
      { id: 2, fingerprint: print, severity: "critical" },
      { id: 3, fingerprint: print, severity: "major" },
    ],
    resolved: new Set(),
  });
  assert.deepEqual(counts.bySeverity, { ...NO_FINDINGS, critical: 1 });
  assert.equal(counts.total, 1);
});

test("keeps a fingerprint open while one of its comments is not resolved", () => {
  const print = "a".repeat(16);
  const counts = countOpenFindings({
    newCounts: NO_FINDINGS,
    earlier: [
      { id: 1, fingerprint: print, severity: "critical" },
      { id: 2, fingerprint: print, severity: "minor" },
    ],
    resolved: new Set([1]),
  });
  assert.deepEqual(counts.bySeverity, { ...NO_FINDINGS, minor: 1 });
  assert.equal(counts.resolved, 0);
});

test("does not change its arguments", () => {
  const newCounts = { ...NO_FINDINGS, major: 1 };
  const earlier = [
    { id: 1, fingerprint: "a".repeat(16), severity: "critical" },
  ];
  const resolved = new Set([5]);
  countOpenFindings({ newCounts, earlier, resolved });
  assert.deepEqual(newCounts, { ...NO_FINDINGS, major: 1 });
  assert.equal(earlier.length, 1);
  assert.deepEqual([...resolved], [5]);
});

// --- The rule for "is the earlier finding still current" (#107) --------------

/**
 * An earlier inline comment as `readHistory()` lists it, for a line of a
 * file: the fingerprint of the line, the text fingerprint, the severity.
 */
const earlierAt = (
  id,
  path,
  content,
  previous,
  severity = "critical",
  fields = {},
) => ({
  id,
  path,
  fingerprint: lineFingerprint(path, content, previous),
  severity,
  textFingerprint: textFingerprint(content),
  ...fields,
});

/** A new file that adds the given lines. */
const addedFile = (path, ...lines) =>
  diff(
    path,
    `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`,
  );

const openOf = (earlier, diffs, options) =>
  openEarlierFindings(earlier, diffs, options);

test("a commit that changes another file keeps the finding open", () => {
  const earlier = [earlierAt(1, "src/app.js", "b", "a")];
  const diffs = [
    addedFile("src/app.js", "a", "b", "c"),
    addedFile("src/other.js", "x"),
  ];
  const { open } = openOf(earlier, diffs);
  assert.deepEqual(open, earlier);
});

test("a pure rename keeps the finding open, counted at the line of the new file", () => {
  const earlier = [earlierAt(1, "src/old.js", "b", "a")];
  const diffs = [addedFile("src/new.js", "a", "b", "c")];

  const { open, commented, unknown } = openOf(earlier, diffs);

  assert.equal(open.length, 1);
  assert.equal(open[0].id, 1);
  // The key is the fingerprint of the line as it is now.
  assert.equal(open[0].fingerprint, lineFingerprint("src/new.js", "b", "a"));
  assert.deepEqual([...commented], [open[0].fingerprint]);
  assert.equal(unknown, 0);
});

test("a changed line above keeps the finding open", () => {
  const earlier = [earlierAt(1, "src/app.js", "b", "a")];
  const diffs = [addedFile("src/app.js", "a2", "b", "c")];

  const { open, commented } = openOf(earlier, diffs);

  assert.equal(open.length, 1);
  assert.equal(open[0].fingerprint, lineFingerprint("src/app.js", "b", "a2"));
  assert.deepEqual([...commented], [open[0].fingerprint]);
});

test("a changed line above and a new name together keep it open as well", () => {
  const earlier = [earlierAt(1, "src/old.js", "b", "a")];
  const diffs = [addedFile("src/new.js", "a2", "b")];
  assert.equal(openOf(earlier, diffs).open.length, 1);
});

test("a finding stays open when its line only moved", () => {
  const earlier = [earlierAt(1, "src/app.js", "b", "a")];
  const diffs = [addedFile("src/app.js", "x", "y", "a", "b")];
  const { open, commented } = openOf(earlier, diffs);
  // The fingerprint is the same: the rule of before applies, nothing is added.
  assert.deepEqual(open, earlier);
  assert.equal(commented.size, 0);
});

test("a changed line itself ends the finding", () => {
  const earlier = [earlierAt(1, "src/app.js", "b", "a")];
  const diffs = [addedFile("src/app.js", "a", "b2", "c")];
  const result = openOf(earlier, diffs);
  assert.deepEqual(result.open, []);
  assert.equal(result.commented.size, 0);
});

test("the text counts without regard to white space", () => {
  const earlier = [earlierAt(1, "src/old.js", "let  b = 1;", "a")];
  const diffs = [addedFile("src/new.js", "a2", "let b =   1;")];
  assert.equal(openOf(earlier, diffs).open.length, 1);
});

test("a line that is only context now ends the finding", () => {
  const earlier = [earlierAt(1, "src/app.js", "a", "")];
  const context = diff("src/app.js", "@@ -1,2 +1,3 @@\n a\n-old\n+b\n+c");
  assert.deepEqual(openOf(earlier, [context]).open, []);
});

test("the text is searched in the own file first, not in other files", () => {
  const earlier = [earlierAt(1, "src/app.js", "b", "a")];
  const diffs = [
    addedFile("src/app.js", "a", "b2"),
    addedFile("src/other.js", "b"),
  ];
  assert.deepEqual(openOf(earlier, diffs).open, []);
});

test("two equal lines make the text ambiguous: open, but the line is not named", () => {
  const earlier = [earlierAt(1, "src/old.js", "retry();", "a")];
  const diffs = [addedFile("src/new.js", "x", "retry();", "y", "retry();")];

  const { open, commented } = openOf(earlier, diffs);

  assert.deepEqual(open, earlier);
  assert.equal(commented.size, 0);
});

test("a deleted file ends the finding, a line with the same text elsewhere does not", () => {
  const earlier = [earlierAt(1, "src/gone.js", "b", "a")];
  assert.deepEqual(openOf(earlier, [addedFile("src/other.js", "x")]).open, []);
  assert.equal(
    openOf(earlier, [addedFile("src/other.js", "x", "b")]).open.length,
    1,
  );
});

test("a comment without a text fingerprint follows the old rule", () => {
  const old = earlierAt(1, "src/app.js", "b", "a", "critical", {
    textFingerprint: null,
  });
  // The line above changed: gone, as before.
  assert.deepEqual(
    openOf([old], [addedFile("src/app.js", "a2", "b")]).open,
    [],
  );
  // The line is the same: still current.
  assert.deepEqual(openOf([old], [addedFile("src/app.js", "a", "b")]).open, [
    old,
  ]);
});

test("a line without a letter or a digit follows the old rule", () => {
  const brace = earlierAt(1, "src/app.js", "}", "a");
  assert.equal(brace.textFingerprint, null);
  const diffs = [addedFile("src/app.js", "a2", "}", "x", "}")];
  assert.deepEqual(openOf([brace], diffs).open, []);
});

test("a finding without a path is judged by its fingerprint alone", () => {
  const nameless = earlierAt(1, null, "b", "a", "major", {
    fingerprint: lineFingerprint("src/app.js", "b", "a"),
  });
  const diffs = [addedFile("src/app.js", "a", "b")];
  assert.deepEqual(openOf([nameless], diffs).open, [nameless]);
  assert.deepEqual(
    openOf([nameless], [addedFile("src/app.js", "a2", "b")]).open,
    [{ ...nameless, fingerprint: lineFingerprint("src/app.js", "b", "a2") }],
  );
});

test("a file whose diff is not available keeps the finding open", () => {
  const earlier = [earlierAt(1, "src/big.js", "b", "a")];
  const result = openOf(earlier, [addedFile("src/app.js", "x")], {
    unknownPaths: new Set(["src/big.js"]),
  });
  assert.deepEqual(result.open, earlier);
  assert.equal(result.unknown, 1);
  assert.equal(result.commented.size, 0);
});

test("a cut list of files keeps the finding of a file that was not parsed open", () => {
  const earlier = [
    earlierAt(1, "src/lost.js", "b", "a"),
    earlierAt(2, "src/app.js", "x", "w"),
  ];
  const result = openOf(earlier, [addedFile("src/app.js", "w", "x2")], {
    listingTruncated: true,
  });
  assert.deepEqual(
    result.open.map(({ id }) => id),
    [1],
  );
  assert.equal(result.unknown, 1);
});

test("the unavailable diff goes before everything else", () => {
  const earlier = [earlierAt(1, "src/app.js", "b", "a")];
  // The fingerprint is among the added lines, but the diff of the file is
  // said to be unavailable: unknown, not unchanged.
  const result = openOf(earlier, [addedFile("src/app.js", "a", "b")], {
    unknownPaths: new Set(["src/app.js"]),
  });
  assert.equal(result.unknown, 1);
});

test("two comments at one line count once, with the most serious severity", () => {
  const earlier = [
    // An older comment from before the line above changed, and a newer one.
    earlierAt(1, "src/app.js", "b", "a", "minor"),
    earlierAt(2, "src/app.js", "b", "a2", "critical"),
  ];
  const { open } = openOf(earlier, [addedFile("src/app.js", "a2", "b")]);

  const count = countOpenFindings({
    newCounts: NO_FINDINGS,
    earlier: open,
    resolved: new Set(),
  });

  assert.equal(count.earlier, 1);
  assert.equal(count.bySeverity.critical, 1);
  assert.equal(count.bySeverity.minor, 0);
});

test("a resolved thread still takes the finding out of the count after a rename", () => {
  const earlier = [earlierAt(1, "src/old.js", "b", "a")];
  const { open } = openOf(earlier, [addedFile("src/new.js", "a", "b")]);

  const count = countOpenFindings({
    newCounts: NO_FINDINGS,
    earlier: open,
    resolved: new Set([1]),
  });

  assert.equal(count.total, 0);
  assert.equal(count.resolved, 1);
});

test("currentEarlierFindings() returns what openEarlierFindings() calls open", () => {
  const earlier = [earlierAt(1, "src/old.js", "b", "a")];
  const diffs = [addedFile("src/new.js", "a", "b")];
  assert.deepEqual(
    currentEarlierFindings(earlier, diffs),
    openEarlierFindings(earlier, diffs).open,
  );
});

test("assessComments() tells unchanged, changed and unknown apart", () => {
  const comments = [
    earlierAt(1, "src/app.js", "a", ""),
    earlierAt(2, "src/app.js", "gone", "a"),
    earlierAt(3, "src/big.js", "z", ""),
  ];
  const states = assessComments(comments, [addedFile("src/app.js", "a", "b")], {
    unknownPaths: new Set(["src/big.js"]),
  }).map(({ state }) => state);
  assert.deepEqual(states, ["unchanged", "changed", "unknown"]);
});
