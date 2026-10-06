import assert from "node:assert/strict";
import { test } from "node:test";
import { lineFingerprint } from "../src/fingerprint.js";
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
  notNew: 0,
  known: 0,
  overLimit: 0,
};

const NO_COUNTS = { critical: 0, major: 0, minor: 0, info: 0 };

// --- Empty answers -----------------------------------------------------------

test("returns nothing for an empty list of findings", () => {
  assert.deepEqual(select([reviewOf(["a.js"], [])]), {
    inline: [],
    fingerprints: [],
    unplaced: [],
    unplacedFingerprints: [],
    dropped: NOTHING_DROPPED,
    counts: NO_COUNTS,
  });
});

test("returns nothing when no request worked", () => {
  assert.deepEqual(select([]), {
    inline: [],
    fingerprints: [],
    unplaced: [],
    unplacedFingerprints: [],
    dropped: NOTHING_DROPPED,
    counts: NO_COUNTS,
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
    notNew: 0,
    known: 0,
    overLimit: 1,
  });
  assert.deepEqual(
    result.inline.map((item) => item.line),
    [3, 1],
  );
});

// --- Earlier reviews ---------------------------------------------------------

/** A request whose file has the text "code <n>" at every added line 1 to 5. */
const textReviewOf = (path, findings) => ({
  files: [
    {
      path,
      commentableLines: [1, 2, 3, 4, 5],
      hunks: [
        {
          section: "",
          lines: [1, 2, 3, 4, 5].map((line) => ({
            type: "added",
            line,
            content: `code ${line}`,
          })),
        },
      ],
    },
  ],
  summary: "summary",
  findings,
});

const fingerprintAt = (path, line) =>
  lineFingerprint(path, `code ${line}`, line === 1 ? "" : `code ${line - 1}`);

test("gives every inline comment the fingerprint of its line", () => {
  const result = select([
    textReviewOf("a.js", [finding("a.js", 4), finding("a.js", 2)]),
  ]);

  assert.deepEqual(result.fingerprints, [
    fingerprintAt("a.js", 4),
    fingerprintAt("a.js", 2),
  ]);
});

test("has no fingerprint for a file without the text of its lines", () => {
  const result = select([reviewOf(["a.js"], [finding("a.js", 2)])]);

  assert.deepEqual(result.fingerprints, [null]);
});

test("keeps the fingerprints in the order of the sorted inline comments", () => {
  const result = select([
    textReviewOf("a.js", [
      finding("a.js", 1, "info"),
      finding("a.js", 2, "critical"),
    ]),
  ]);

  assert.deepEqual(
    result.inline.map((item) => item.line),
    [2, 1],
  );
  assert.deepEqual(result.fingerprints, [
    fingerprintAt("a.js", 2),
    fingerprintAt("a.js", 1),
  ]);
});

test("drops a finding at a line that an earlier comment is at", () => {
  const known = new Set([fingerprintAt("a.js", 2)]);

  const result = selectFindings({
    reviews: [textReviewOf("a.js", [finding("a.js", 2), finding("a.js", 3)])],
    maxComments: 10,
    known,
  });

  assert.deepEqual(
    result.inline.map((item) => item.line),
    [3],
  );
  assert.equal(result.dropped.known, 1);
});

test("does not mix up the same text in another file", () => {
  const known = new Set([fingerprintAt("a.js", 2)]);

  const result = selectFindings({
    reviews: [textReviewOf("b.js", [finding("b.js", 2)])],
    maxComments: 10,
    known,
  });

  assert.equal(result.inline.length, 1);
  assert.equal(result.dropped.known, 0);
});

test("keeps a finding in the text of the review although a fingerprint is known", () => {
  // Only a line with an inline comment has a fingerprint.
  const result = selectFindings({
    reviews: [textReviewOf("a.js", [finding("a.js", 9)])],
    maxComments: 10,
    known: new Set([fingerprintAt("a.js", 2)]),
  });

  assert.equal(result.unplaced.length, 1);
});

test("drops a finding that is not at a new line, also one in the text of the review", () => {
  const newLines = new Map([["a.js", new Set([4])]]);

  const result = selectFindings({
    reviews: [
      textReviewOf("a.js", [
        finding("a.js", 2),
        finding("a.js", 4),
        finding("a.js", 9),
      ]),
    ],
    maxComments: 10,
    newLines,
  });

  assert.deepEqual(
    result.inline.map((item) => item.line),
    [4],
  );
  assert.deepEqual(result.unplaced, []);
  assert.equal(result.dropped.notNew, 2);
});

test("drops a finding in a file without new lines", () => {
  const result = selectFindings({
    reviews: [textReviewOf("a.js", [finding("a.js", 2)])],
    maxComments: 10,
    newLines: new Map(),
  });

  assert.equal(result.dropped.notNew, 1);
  assert.deepEqual(result.inline, []);
});

test("shows everything without a range", () => {
  const result = selectFindings({
    reviews: [textReviewOf("a.js", [finding("a.js", 2), finding("a.js", 9)])],
    maxComments: 10,
    newLines: null,
  });

  assert.equal(result.inline.length, 1);
  assert.equal(result.unplaced.length, 1);
  assert.equal(result.dropped.notNew, 0);
});

test("drops findings of earlier work before the limit, so they use no place", () => {
  const known = new Set([fingerprintAt("a.js", 1)]);

  const result = selectFindings({
    reviews: [
      textReviewOf("a.js", [
        finding("a.js", 1, "critical"),
        finding("a.js", 2, "minor"),
      ]),
    ],
    maxComments: 1,
    known,
  });

  assert.deepEqual(
    result.inline.map((item) => item.line),
    [2],
  );
  assert.equal(result.dropped.overLimit, 0);
  assert.equal(result.dropped.known, 1);
});

test("counts the range before the known lines", () => {
  const result = selectFindings({
    reviews: [textReviewOf("a.js", [finding("a.js", 1)])],
    maxComments: 10,
    newLines: new Map(),
    known: new Set([fingerprintAt("a.js", 1)]),
  });

  assert.equal(result.dropped.notNew, 1);
  assert.equal(result.dropped.known, 0);
});

test("does not change its arguments", () => {
  const newLines = new Map([["a.js", new Set([2])]]);
  const known = new Set([fingerprintAt("a.js", 3)]);

  selectFindings({
    reviews: [textReviewOf("a.js", [finding("a.js", 2)])],
    maxComments: 10,
    newLines,
    known,
  });

  assert.deepEqual([...newLines.get("a.js")], [2]);
  assert.deepEqual([...known], [fingerprintAt("a.js", 3)]);
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

// --- Findings in the text of the review ---------------------------------------

/** One file with the added lines 3 and 4 and the context lines 2 and 5. */
const contextReviewOf = (path, findings) => ({
  files: [
    {
      path,
      commentableLines: [3, 4],
      hunks: [
        {
          section: "",
          lines: [
            { type: "context", line: 2, content: "before" },
            { type: "added", line: 3, content: "new one" },
            { type: "added", line: 4, content: "new two" },
            { type: "context", line: 5, content: "after" },
          ],
        },
      ],
    },
  ],
  summary: "summary",
  findings,
});

test("gives a finding at a context line the fingerprint of that line", () => {
  const result = select([contextReviewOf("a.js", [finding("a.js", 5)])]);

  assert.equal(result.unplaced.length, 1);
  assert.deepEqual(result.unplacedFingerprints, [
    lineFingerprint("a.js", "after", "new two"),
  ]);
});

test("drops a finding at a context line that an earlier review reported", () => {
  const result = selectFindings({
    reviews: [contextReviewOf("a.js", [finding("a.js", 5)])],
    maxComments: 10,
    known: new Set([lineFingerprint("a.js", "after", "new two")]),
  });

  assert.deepEqual(result.unplaced, []);
  assert.equal(result.dropped.known, 1);
});

test("keeps a finding at a context line of a file with a new line after an earlier review", () => {
  const result = selectFindings({
    reviews: [contextReviewOf("a.js", [finding("a.js", 2)])],
    maxComments: 10,
    newLines: new Map([["a.js", new Set([4])]]),
  });

  assert.equal(result.unplaced.length, 1);
  assert.equal(result.dropped.notNew, 0);
});

test("drops a finding at a context line of a file without a new line", () => {
  const result = selectFindings({
    reviews: [contextReviewOf("a.js", [finding("a.js", 2)])],
    maxComments: 10,
    newLines: new Map([["b.js", new Set([1])]]),
  });

  assert.deepEqual(result.unplaced, []);
  assert.equal(result.dropped.notNew, 1);
});

// --- Counts by severity ------------------------------------------------------

test("counts the kept findings by severity", () => {
  const result = select([
    reviewOf(
      ["a.js"],
      [
        finding("a.js", 1, "critical"),
        finding("a.js", 2, "major"),
        finding("a.js", 3, "major"),
        finding("a.js", 9, "info"),
      ],
    ),
  ]);
  assert.deepEqual(result.counts, {
    critical: 1,
    major: 2,
    minor: 0,
    info: 1,
  });
});

test("counts the findings over max-comments as well", () => {
  const findings = Array.from({ length: 5 }, (_, index) =>
    finding("a.js", index + 1, "critical"),
  );
  const result = select([reviewOf(["a.js"], findings)], 2);

  assert.equal(result.inline.length, 2);
  assert.equal(result.dropped.overLimit, 3);
  assert.equal(result.counts.critical, 5);
});

test("does not count dropped findings", () => {
  const known = lineFingerprint("a.js", "known", "");
  const file = {
    path: "a.js",
    commentableLines: [1, 2],
    hunks: [
      {
        lines: [
          { type: "add", line: 1, content: "known" },
          { type: "add", line: 2, content: "fresh" },
        ],
      },
    ],
  };
  const result = selectFindings({
    reviews: [
      {
        files: [file],
        summary: "",
        findings: [
          // Empty, unknown path, duplicate, known.
          { ...finding("a.js", 2, "critical"), title: " " },
          finding("b.js", 2, "critical"),
          finding("a.js", 2, "minor", "Same"),
          finding("a.js", 2, "minor", "same"),
          finding("a.js", 1, "critical"),
        ],
      },
    ],
    maxComments: 10,
    known: new Set([known]),
  });
  assert.equal(result.dropped.empty, 1);
  assert.equal(result.dropped.unknownPath, 1);
  assert.equal(result.dropped.duplicate, 1);
  assert.equal(result.dropped.known, 1);
  assert.deepEqual(result.counts, { ...NO_COUNTS, minor: 1 });
});

test("does not count findings outside of the new lines", () => {
  const result = selectFindings({
    reviews: [
      reviewOf(
        ["a.js"],
        [finding("a.js", 1, "critical"), finding("a.js", 2, "major")],
      ),
    ],
    maxComments: 10,
    newLines: new Map([["a.js", new Set([2])]]),
  });
  assert.deepEqual(result.counts, { ...NO_COUNTS, major: 1 });
});
