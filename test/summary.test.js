import assert from "node:assert/strict";
import { test } from "node:test";
import MarkdownIt from "markdown-it";
import {
  MAX_SUMMARY_FILES,
  NO_FINDINGS,
  buildSummary,
} from "../src/summary.js";

// A renderer close to GitHub's, as in markdown.test.js.
const markdown = new MarkdownIt({ html: true, linkify: true, breaks: true });
markdown.linkify.set({ fuzzyLink: false });

const URL_OF_REVIEW =
  "https://github.com/octo-org/demo/pull/42#pullrequestreview-1001";

const ALLOWED_TAGS = new Set([
  "h2",
  "h3",
  "h4",
  "p",
  "br",
  "code",
  "strong",
  "ul",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
]);

/** Asserts that the summary renders to text, code, tables and the review link only. */
function assertSafe(text) {
  const html = markdown.render(text);
  for (const [, tag] of html.matchAll(/<\/?([a-z0-9]+)/g)) {
    assert.ok(ALLOWED_TAGS.has(tag), `<${tag}>`);
  }
  assert.doesNotMatch(html, /<!--/);
  const links = [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(
    links.every((link) => link === URL_OF_REVIEW),
    links.join(", "),
  );
  return html;
}

const FINDINGS = {
  bySeverity: { critical: 1, major: 2, minor: 0, info: 1 },
  total: 4,
  earlier: 1,
  resolved: 0,
  overLimit: 0,
  known: 0,
};

const FILES = {
  reviewed: 3,
  skipped: [{ path: "package-lock.json", reason: "excluded by default" }],
  alreadyReviewed: 0,
};

const USAGE = {
  inputTokens: 1200,
  outputTokens: 300,
  totalTokens: 1500,
  withoutCount: 0,
  requests: 2,
};

test("shows files, findings by severity and the tokens of a review", () => {
  const text = buildSummary({
    status: "Posted a review with 3 inline comments.",
    files: FILES,
    findings: FINDINGS,
    usage: USAGE,
    reviewUrl: URL_OF_REVIEW,
  });

  assertSafe(text);
  assert.match(text, /^## ReviewOps$/m);
  assert.match(text, /\| Reviewed \| 3 \|/);
  assert.match(text, /\| Skipped \| 1 \|/);
  assert.match(text, /- `package-lock.json`: excluded by default/);
  assert.match(text, /\| 🔴 Critical \| 1 \|/);
  assert.match(text, /\| 🟠 Major \| 2 \|/);
  assert.match(text, /\| 🟡 Minor \| 0 \|/);
  assert.match(text, /\| 🔵 Info \| 1 \|/);
  assert.match(text, /\| \*\*Total\*\* \| \*\*4\*\* \|/);
  assert.match(text, /3 found in this run, 1 from earlier comments/);
  assert.match(text, /\| 1200 \| 300 \| 1500 \| 2 \|/);
  assert.match(text, /\[Open the review\]\(https:\/\/github\.com\//);
  assert.doesNotMatch(text, new RegExp(NO_FINDINGS));
});

test("says No findings when nothing is open", () => {
  const text = buildSummary({
    status: "No findings, so no review was posted.",
    files: FILES,
    findings: {
      ...FINDINGS,
      bySeverity: { critical: 0, major: 0, minor: 0, info: 0 },
      total: 0,
      earlier: 0,
    },
    usage: USAGE,
  });

  assertSafe(text);
  assert.match(text, /^No findings\.$/m);
  assert.doesNotMatch(text, /\| Severity \|/);
  assert.doesNotMatch(text, /Open the review/);
});

test("names the findings that are counted but not shown", () => {
  const text = buildSummary({
    status: "s",
    findings: { ...FINDINGS, resolved: 2, overLimit: 3, known: 4 },
  });

  assert.match(
    text,
    /2 earlier findings are left out: their thread is resolved\./,
  );
  assert.match(text, /4 findings of this run were commented before/);
  assert.match(text, /3 findings are counted, but not shown in the review/);
});

test("shows the files without a new line after an earlier review", () => {
  const text = buildSummary({
    status: "s",
    files: { ...FILES, alreadyReviewed: 5 },
    since: "a".repeat(40),
  });

  assert.match(text, /\| No new line since `aaaaaaa` \| 5 \|/);
});

test("leaves out the row of files without a new line on a full review", () => {
  const text = buildSummary({ status: "s", files: FILES });
  assert.doesNotMatch(text, /No new line since/);
});

test("lists at most 50 skipped files and counts the rest", () => {
  const skipped = Array.from({ length: 60 }, (_, index) => ({
    path: `gen/file-${index}.js`,
    reason: "over the limit of 50 files (max-files)",
  }));
  const text = buildSummary({ status: "s", files: { ...FILES, skipped } });

  assert.equal(
    [...text.matchAll(/^- `gen\/file-\d+\.js`/gm)].length,
    MAX_SUMMARY_FILES,
  );
  assert.match(text, /^- and 10 more files$/m);
});

test("shows a hostile file name as code, without a link, image or HTML", () => {
  const names = [
    "[click](https://evil.example).js",
    "![x](https://evil.example/p.png).js",
    "<img src=x onerror=alert(1)>.js",
    "<!-- reviewops -->.js",
    "a`b``c.js",
    "@octocat #12 https://evil.example/x.js",
    "a|b|c.js",
    `rlo${String.fromCodePoint(0x202e)}sj.exe`,
  ];
  const text = buildSummary({
    status: "s",
    files: {
      ...FILES,
      skipped: names.map((path) => ({ path, reason: "excluded" })),
    },
  });

  const html = assertSafe(text);
  assert.ok(!html.includes(String.fromCodePoint(0x202e)));
});

test("cuts a long file name", () => {
  const text = buildSummary({
    status: "s",
    files: { ...FILES, skipped: [{ path: "a".repeat(500), reason: "r" }] },
  });
  assert.match(text, new RegExp(`\`${"a".repeat(200)}…\``));
});

test("shows the error of a failed run as plain text", () => {
  const text = buildSummary({
    status: "ReviewOps failed.",
    error:
      'Input `fail-on` must be one of none, critical, major, but is "[x](https://evil.example)".',
  });

  const html = assertSafe(text);
  assert.match(html, /Error:/);
  assert.doesNotMatch(html, /href="https:\/\/evil/);
});

test("names the requests without a token count", () => {
  const text = buildSummary({
    status: "s",
    usage: { ...USAGE, withoutCount: 1 },
  });
  assert.match(text, /1 requests answered without a token count/);
});

test("says whether fail-on is reached", () => {
  const reached = buildSummary({
    status: "s",
    threshold: { failOn: "critical", reached: 2 },
  });
  const notReached = buildSummary({
    status: "s",
    threshold: { failOn: "major", reached: 0 },
  });
  const none = buildSummary({
    status: "s",
    threshold: { failOn: "none", reached: 0 },
  });

  assert.match(
    reached,
    /fail-on: critical\*\* — 2 open findings reach the threshold/,
  );
  assert.match(notReached, /fail-on: major\*\* — no open finding reaches/);
  assert.doesNotMatch(none, /fail-on/);
});

test("shows only the status for a run that ended early", () => {
  const text = buildSummary({
    status:
      "ReviewOps runs only on the pull_request event. This run was skipped.",
  });

  assertSafe(text);
  assert.doesNotMatch(text, /### /);
});

test("stays below the size limit", () => {
  const skipped = Array.from({ length: 50 }, (_, index) => ({
    path: `${"d/".repeat(90)}${index}`,
    reason: "r".repeat(2000),
  }));
  const text = buildSummary({ status: "s", files: { ...FILES, skipped } });
  assert.ok(text.length <= 60000);
});

test("names the requests that failed and says their tokens are missing", () => {
  const text = buildSummary({
    status: "s",
    usage: { ...USAGE, requests: 3, failed: 1 },
  });
  assert.match(text, /\| Requests sent \|/);
  assert.match(text, /\| 1200 \| 300 \| 1500 \| 3 \|/);
  assert.match(
    text,
    /1 requests failed; the tokens they used are not part of the numbers above\./,
  );
});

test("says nothing about failed requests when all were answered", () => {
  const text = buildSummary({ status: "s", usage: USAGE });
  assert.doesNotMatch(text, /requests failed/);
});
