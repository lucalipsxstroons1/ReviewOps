import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatch } from "../src/diff/parse.js";
import { lineFingerprint } from "../src/fingerprint.js";
import {
  countOpenFindings,
  currentEarlierFindings,
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
