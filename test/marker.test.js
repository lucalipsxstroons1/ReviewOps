import assert from "node:assert/strict";
import { test } from "node:test";
import { SEVERITIES } from "../src/ai/schema.js";
import {
  INCOMPLETE_LINE,
  REVIEW_MARKER,
  commentHead,
  fingerprintLine,
  readHead,
  reviewHead,
  startsWithMarker,
} from "../src/github/marker.js";

// The hidden lines by which the action recognises its own work (#111): the
// marker, the line for an incomplete review and the fingerprint line. What the
// writer writes, the reader must read back, for every kind of line, and
// nothing that the writer never writes.

const hex = (digit) => digit.repeat(16);
const ENDS = { LF: "\n", CRLF: "\r\n" };
const TEXT_BELOW = "The text of the model.\n\n---\n<sub>AI-generated</sub>";

/** A body as the action posts it: the head, an empty line, the text. */
const bodyOf = (head, end = "\n") =>
  `${head.replaceAll("\n", end)}${end}${end}${TEXT_BELOW}`;

const empty = { fingerprints: [], incomplete: false };

// --- The marker ----------------------------------------------------------------

test("the marker counts only at the very start of a body", () => {
  assert.equal(startsWithMarker(`${REVIEW_MARKER}\ntext`), true);
  assert.equal(startsWithMarker(REVIEW_MARKER), true);
  for (const body of [
    ` ${REVIEW_MARKER}`,
    `\n${REVIEW_MARKER}`,
    `text ${REVIEW_MARKER}`,
    "<!-- reviewops",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(startsWithMarker(body), false, String(body));
  }
});

// --- The inline comment: the head and what is read from it -----------------------

for (const [name, end] of Object.entries(ENDS)) {
  for (const severity of [...SEVERITIES, null]) {
    for (const text of [hex("d"), null]) {
      // The text fingerprint only ever follows a severity.
      const read = {
        fingerprint: hex("a"),
        severity,
        text: severity ? text : null,
      };
      test(`reads an inline comment back: severity ${severity}, text ${Boolean(text)}, ${name}`, () => {
        const head = commentHead({ fingerprint: hex("a"), severity, text });

        assert.deepEqual(readHead(bodyOf(head, end)), {
          fingerprints: [read],
          incomplete: false,
        });
      });
    }
  }
}

test("a comment without a fingerprint has the marker and nothing else in its head", () => {
  assert.equal(commentHead({ fingerprint: null }), REVIEW_MARKER);
  assert.deepEqual(readHead(bodyOf(commentHead({ fingerprint: null }))), empty);
});

test("the lines are written the way the comments on GitHub show them", () => {
  assert.equal(REVIEW_MARKER, "<!-- reviewops -->");
  assert.equal(INCOMPLETE_LINE, "<!-- reviewops-incomplete -->");
  assert.equal(
    fingerprintLine(hex("a")),
    `<!-- reviewops-fingerprint: ${hex("a")} -->`,
  );
  assert.equal(
    fingerprintLine(hex("a"), "major"),
    `<!-- reviewops-fingerprint: ${hex("a")} severity: major -->`,
  );
  assert.equal(
    fingerprintLine(hex("a"), "major", hex("b")),
    `<!-- reviewops-fingerprint: ${hex("a")} severity: major text: ${hex("b")} -->`,
  );
  // Not a severity: the field is left out, and so is the text after it.
  assert.equal(
    fingerprintLine(hex("a"), "blocker", hex("b")),
    `<!-- reviewops-fingerprint: ${hex("a")} -->`,
  );
  assert.equal(
    fingerprintLine(hex("a"), null, hex("b")),
    `<!-- reviewops-fingerprint: ${hex("a")} -->`,
  );
});

// --- The review text: the head and what is read from it ---------------------------

for (const [name, end] of Object.entries(ENDS)) {
  for (const incomplete of [false, true]) {
    for (const count of [0, 1, 3, 39, 40, 60, 500]) {
      test(`reads ${count} fingerprints back, incomplete ${incomplete}, ${name}`, () => {
        const fingerprints = Array.from({ length: count }, (_, index) =>
          index.toString(16).padStart(16, "0"),
        );
        const head = reviewHead({ incomplete, fingerprints });

        assert.deepEqual(readHead(bodyOf(head, end)), {
          fingerprints: fingerprints.map((fingerprint) => ({
            fingerprint,
            severity: null,
            text: null,
          })),
          incomplete,
        });
      });
    }
  }
}

test("the head of a review text leaves out a finding without a fingerprint", () => {
  assert.equal(
    reviewHead({
      incomplete: false,
      fingerprints: [hex("a"), null, "", hex("b")],
    }),
    [REVIEW_MARKER, fingerprintLine(hex("a")), fingerprintLine(hex("b"))].join(
      "\n",
    ),
  );
});

test("the line for an incomplete review stands right below the marker", () => {
  assert.equal(
    reviewHead({ incomplete: true, fingerprints: [hex("a")] }),
    [REVIEW_MARKER, INCOMPLETE_LINE, fingerprintLine(hex("a"))].join("\n"),
  );
});

test("reads the lines in any order, as long as they follow each other", () => {
  const body = [
    REVIEW_MARKER,
    fingerprintLine(hex("a")),
    INCOMPLETE_LINE,
    fingerprintLine(hex("b")),
    "",
    TEXT_BELOW,
  ].join("\n");

  const head = readHead(body);

  assert.equal(head.incomplete, true);
  assert.deepEqual(
    head.fingerprints.map((print) => print.fingerprint),
    [hex("a"), hex("b")],
  );
});

// --- What is never read -----------------------------------------------------------

test("stops at the first line that is not a line of the head", () => {
  const body = [
    REVIEW_MARKER,
    fingerprintLine(hex("a")),
    "### ReviewOps",
    fingerprintLine(hex("b")),
    INCOMPLETE_LINE,
  ].join("\n");

  assert.deepEqual(readHead(body), {
    fingerprints: [{ fingerprint: hex("a"), severity: null, text: null }],
    incomplete: false,
  });
});

test("never reads a line of the text of the model that looks like a line of the head", () => {
  const head = commentHead({
    fingerprint: hex("a"),
    severity: "major",
    text: hex("b"),
  });
  const body = `${bodyOf(head)}\n${fingerprintLine(hex("c"))}\n${INCOMPLETE_LINE}\n${REVIEW_MARKER}`;

  assert.deepEqual(readHead(body), {
    fingerprints: [
      { fingerprint: hex("a"), severity: "major", text: hex("b") },
    ],
    incomplete: false,
  });
});

const NEVER_WRITTEN = [
  ["a text fingerprint without a severity", `text: ${hex("b")}`],
  ["a severity that is not known", "severity: blocker"],
  ["a severity in capitals", "severity: Major"],
  ["a text fingerprint that is too short", "severity: major text: abc"],
  ["a text fingerprint that is too long", `severity: major text: ${hex("b")}0`],
  ["a text fingerprint in capitals", `severity: major text: ${hex("B")}`],
  ["a field in the wrong order", `text: ${hex("b")} severity: major`],
  ["a field that does not exist", "severity: major extra: 1"],
];
for (const [name, fields] of NEVER_WRITTEN) {
  test(`does not read ${name}`, () => {
    const line = `<!-- reviewops-fingerprint: ${hex("a")} ${fields} -->`;

    assert.deepEqual(readHead(`${REVIEW_MARKER}\n${line}\n\ntext`), empty);
  });
}

const BAD_LINES = [
  ["a fingerprint that is too short", "<!-- reviewops-fingerprint: abc -->"],
  [
    "a fingerprint that is too long",
    `<!-- reviewops-fingerprint: ${hex("a")}0 -->`,
  ],
  ["a fingerprint in capitals", `<!-- reviewops-fingerprint: ${hex("A")} -->`],
  ["a space at the end", `<!-- reviewops-fingerprint: ${hex("a")} --> `],
  ["a space at the start", ` <!-- reviewops-fingerprint: ${hex("a")} -->`],
  ["a second space", `<!-- reviewops-fingerprint:  ${hex("a")} -->`],
  ["text before the comment", `x <!-- reviewops-fingerprint: ${hex("a")} -->`],
  ["no fingerprint", "<!-- reviewops-fingerprint: -->"],
  ["an incomplete line in capitals", "<!-- REVIEWOPS-INCOMPLETE -->"],
  ["an incomplete line with a space", `${INCOMPLETE_LINE} `],
];
for (const [name, line] of BAD_LINES) {
  test(`does not read ${name}`, () => {
    assert.deepEqual(readHead(`${REVIEW_MARKER}\n${line}\n\ntext`), empty);
  });
}

test("reads no line above the marker and none of a body that has no head", () => {
  assert.deepEqual(readHead(REVIEW_MARKER), empty);
  assert.deepEqual(readHead(""), empty);
  // The first line is skipped whatever it says: the head starts below it.
  assert.deepEqual(readHead(`${fingerprintLine(hex("a"))}\ntext`), empty);
});

test("reads a long text without a head quickly", () => {
  const body = `${REVIEW_MARKER}\n${"x\n".repeat(30000)}`;
  const start = performance.now();

  assert.deepEqual(readHead(body), empty);
  assert.ok(performance.now() - start < 500);
});

test("reads a very long head quickly and completely", () => {
  const fingerprints = Array.from({ length: 3000 }, (_, index) =>
    index.toString(16).padStart(16, "0"),
  );
  const start = performance.now();

  const head = readHead(
    bodyOf(reviewHead({ incomplete: false, fingerprints })),
  );

  assert.equal(head.fingerprints.length, 3000);
  assert.ok(performance.now() - start < 500);
});
