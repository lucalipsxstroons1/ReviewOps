import assert from "node:assert/strict";
import { test } from "node:test";
import { selectFindings } from "../src/findings.js";

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/** A finding as `parseReview()` returns it. */
const finding = (path, line, severity = "major", title = `At ${line}`) => ({
  path,
  line,
  severity,
  category: "code-quality",
  title,
  comment: "What is wrong.",
  suggestion: "What to change.",
});

/** One request with files whose added lines are 1 to 5. */
const reviewOf = (paths, findings) => ({
  files: paths.map((path) => ({ path, commentableLines: [1, 2, 3, 4, 5] })),
  summary: "summary",
  findings,
});

const select = (reviews, maxComments = 10) =>
  selectFindings({ reviews, maxComments });

const NOTHING_DROPPED = {
  empty: 0,
  unknownPath: 0,
  duplicate: 0,
  overLimit: 0,
};

// --- Empty answers -----------------------------------------------------------

test("returns nothing for an empty list of findings", () => {
  assert.deepEqual(select([reviewOf(["a.js"], [])]), {
    inline: [],
    unplaced: [],
    dropped: NOTHING_DROPPED,
  });
});

test("returns nothing when no request worked", () => {
  assert.deepEqual(select([]), {
    inline: [],
    unplaced: [],
    dropped: NOTHING_DROPPED,
  });
});

// --- Path and line -----------------------------------------------------------

test("makes a finding at an added line an inline comment", () => {
  const item = finding("a.js", 3);

  const result = select([reviewOf(["a.js"], [item])]);

  assert.deepEqual(result.inline, [item]);
  assert.deepEqual(result.unplaced, []);
  assert.deepEqual(result.dropped, NOTHING_DROPPED);
});

test("never makes a finding at a line outside the diff an inline comment", () => {
  // 0, a context line, a removed line and a line after the end: none of them
  // is an added line of the file.
  const outside = [0, 6, 42, -1].map((line) => finding("a.js", line));

  const result = select([reviewOf(["a.js"], outside)]);

  assert.deepEqual(result.inline, []);
  assert.deepEqual(result.unplaced, outside);
});

test("checks the line against its own file, not against another one", () => {
  const review = {
    files: [
      { path: "a.js", commentableLines: [1] },
      { path: "b.js", commentableLines: [7] },
    ],
    summary: "s",
    findings: [finding("a.js", 7), finding("b.js", 7)],
  };

  const result = select([review]);

  assert.deepEqual(
    result.inline.map((item) => item.path),
    ["b.js"],
  );
  assert.deepEqual(
    result.unplaced.map((item) => item.path),
    ["a.js"],
  );
});

test("drops a finding with an unknown path, also from the text of the review", () => {
  const result = select([
    reviewOf(["a.js"], [finding("src/invented.js", 1), finding("a.js", 1)]),
  ]);

  assert.deepEqual(
    result.inline.map((item) => item.path),
    ["a.js"],
  );
  assert.deepEqual(result.unplaced, []);
  assert.equal(result.dropped.unknownPath, 1);
});

test("drops a finding for a file of another request", () => {
  // The model of the first request never saw b.js.
  const result = select([
    reviewOf(["a.js"], [finding("b.js", 1)]),
    reviewOf(["b.js"], []),
  ]);

  assert.deepEqual(result.inline, []);
  assert.deepEqual(result.unplaced, []);
  assert.equal(result.dropped.unknownPath, 1);
});

test("takes the path only exactly as it was sent", () => {
  const near = ["./a.js", "/a.js", "A.js", "a.js ", "src/../a.js", ""].map(
    (path) => finding(path, 1),
  );

  const result = select([reviewOf(["a.js"], near)]);

  assert.deepEqual(result.inline, []);
  assert.deepEqual(result.unplaced, []);
  assert.equal(result.dropped.unknownPath, near.length);
});

// --- Empty texts -------------------------------------------------------------

for (const field of ["title", "comment", "suggestion"]) {
  test(`drops a finding with an empty ${field}`, () => {
    const blanks = [
      "",
      "   ",
      "\n\t",
      ZERO_WIDTH_SPACE,
      ` ${ZERO_WIDTH_SPACE} `,
    ];
    const findings = blanks.map((text) => ({
      ...finding("a.js", 1),
      [field]: text,
    }));

    const result = select([reviewOf(["a.js"], findings)]);

    assert.deepEqual(result.inline, []);
    assert.deepEqual(result.unplaced, []);
    assert.equal(result.dropped.empty, blanks.length);
  });
}

test("keeps a finding whose texts are short but not empty", () => {
  const item = { ...finding("a.js", 1), title: "x", suggestion: " y " };

  assert.deepEqual(select([reviewOf(["a.js"], [item])]).inline, [item]);
});

// --- Duplicates --------------------------------------------------------------

test("keeps one of two findings with the same path, line and title", () => {
  const first = finding("a.js", 2, "major", "Missing check");
  const second = {
    ...finding("a.js", 2, "major", "  missing   CHECK\n"),
    comment: "Said in other words.",
  };

  const result = select([reviewOf(["a.js"], [first, second])]);

  assert.deepEqual(result.inline, [first]);
  assert.equal(result.dropped.duplicate, 1);
});

test("keeps the more serious of two duplicates", () => {
  const minor = finding("a.js", 2, "minor", "Missing check");
  const critical = finding("a.js", 2, "critical", "Missing check");
  const info = finding("a.js", 2, "info", "Missing check");

  const result = select([reviewOf(["a.js"], [minor, critical, info])]);

  assert.deepEqual(result.inline, [critical]);
  assert.equal(result.dropped.duplicate, 2);
});

test("keeps findings that differ in path, line or title", () => {
  const findings = [
    finding("a.js", 2, "major", "Missing check"),
    finding("b.js", 2, "major", "Missing check"),
    finding("a.js", 3, "major", "Missing check"),
    finding("a.js", 2, "major", "Unused variable"),
  ];

  const result = select([reviewOf(["a.js", "b.js"], findings)]);

  assert.deepEqual(result.inline, findings);
  assert.equal(result.dropped.duplicate, 0);
});

test("removes duplicates also at a line outside the diff", () => {
  const result = select([
    reviewOf(["a.js"], [finding("a.js", 9), finding("a.js", 9)]),
  ]);

  assert.equal(result.unplaced.length, 1);
  assert.equal(result.dropped.duplicate, 1);
});

// --- Order and limit ---------------------------------------------------------

test("sorts by severity and keeps the order of equal severities", () => {
  const findings = [
    finding("a.js", 1, "info"),
    finding("a.js", 2, "major"),
    finding("a.js", 3, "critical"),
    finding("a.js", 4, "major"),
    finding("a.js", 5, "minor"),
  ];

  const result = select([reviewOf(["a.js"], findings)]);

  assert.deepEqual(
    result.inline.map((item) => [item.severity, item.line]),
    [
      ["critical", 3],
      ["major", 2],
      ["major", 4],
      ["minor", 5],
      ["info", 1],
    ],
  );
});

test("keeps the order of the requests for equal severities", () => {
  const result = select([
    reviewOf(["a.js"], [finding("a.js", 1)]),
    reviewOf(["b.js"], [finding("b.js", 1)]),
    reviewOf(["c.js"], [finding("c.js", 1)]),
  ]);

  assert.deepEqual(
    result.inline.map((item) => item.path),
    ["a.js", "b.js", "c.js"],
  );
});

test("shows at most maxComments findings, the most serious first", () => {
  const severities = ["info", "minor", "critical", "major", "minor", "major"];
  const findings = severities.map((severity, index) =>
    finding("a.js", (index % 5) + 1, severity, `Problem ${index}`),
  );

  const result = select([reviewOf(["a.js"], findings)], 3);

  assert.deepEqual(
    result.inline.map((item) => item.severity),
    ["critical", "major", "major"],
  );
  assert.equal(result.dropped.overLimit, 3);
});

test("counts the findings in the text of the review against the limit", () => {
  // A critical finding at a line outside the diff takes the only place.
  const findings = [
    finding("a.js", 1, "minor"),
    finding("a.js", 9, "critical"),
  ];

  const result = select([reviewOf(["a.js"], findings)], 1);

  assert.deepEqual(result.inline, []);
  assert.deepEqual(result.unplaced, [findings[1]]);
  assert.equal(result.dropped.overLimit, 1);
});

test("never has more inline comments than maxComments", () => {
  const findings = Array.from({ length: 40 }, (_, index) =>
    finding("a.js", (index % 5) + 1, "major", `Problem ${index}`),
  );

  for (const maxComments of [1, 2, 10, 39, 40, 41]) {
    const result = select([reviewOf(["a.js"], findings)], maxComments);

    assert.equal(result.inline.length, Math.min(maxComments, 40));
    assert.equal(result.dropped.overLimit, Math.max(0, 40 - maxComments));
  }
});

test("drops in the order: empty, unknown path, duplicate, over the limit", () => {
  const findings = [
    { ...finding("x.js", 1), title: "" },
    finding("x.js", 1),
    finding("a.js", 1, "minor"),
    finding("a.js", 1, "minor"),
    finding("a.js", 2, "info"),
    finding("a.js", 3, "major"),
  ];

  const result = select([reviewOf(["a.js"], findings)], 2);

  assert.deepEqual(result.dropped, {
    empty: 1,
    unknownPath: 1,
    duplicate: 1,
    overLimit: 1,
  });
  assert.deepEqual(
    result.inline.map((item) => item.line),
    [3, 1],
  );
});

test("does not change its arguments", () => {
  const reviews = [
    reviewOf(
      ["a.js"],
      [finding("a.js", 1, "info"), finding("a.js", 2, "critical")],
    ),
  ];
  const copy = structuredClone(reviews);
  for (const review of reviews) {
    Object.freeze(review.findings);
    Object.freeze(review.files);
  }

  select(reviews, 1);

  assert.deepEqual(reviews, copy);
});
