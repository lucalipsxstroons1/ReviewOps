import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { TEXT_LIMITS } from "../src/ai/answer-limits.js";
import { SENSITIVE_FILES } from "../src/exclude.js";
import { fromRoot } from "./helpers/run-action.js";

const doc = readFileSync(fromRoot("SECURITY.md"), "utf8");
const workflow = parse(
  readFileSync(fromRoot(".github/workflows/reviewops.yml"), "utf8"),
);

// --- The page says what the code does ----------------------------------------

test("names every file of the list that is never sent", () => {
  assert.ok(SENSITIVE_FILES.length > 10);
  for (const pattern of SENSITIVE_FILES) {
    assert.ok(doc.includes(`\`${pattern}\``), `${pattern} is not named`);
  }
});

test("names exactly the permissions of the workflow", () => {
  const { permissions } = workflow;
  assert.ok(Object.keys(permissions).length > 0);

  for (const [scope, level] of Object.entries(permissions)) {
    assert.ok(
      doc.includes(`\`${scope}: ${level}\``),
      `${scope}: ${level} is not named`,
    );
  }
  // A permission the workflow does not have must not be claimed.
  const named = [...doc.matchAll(/`([a-z-]+): (read|write)`/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(named)].sort(), Object.keys(permissions).sort());
});

test("names the limits for the texts of the answer", () => {
  assert.match(
    doc,
    new RegExp(`title is cut at ${TEXT_LIMITS.title} characters`),
  );
  assert.match(
    doc,
    new RegExp(
      `at ${TEXT_LIMITS.comment}, a summary at ${TEXT_LIMITS.summary}`,
    ),
  );
  assert.equal(TEXT_LIMITS.comment, TEXT_LIMITS.suggestion);
});

test("names the kinds of secret that are replaced", () => {
  for (const kind of [
    "GitHub tokens",
    "OpenAI keys",
    "AWS access key IDs",
    "Slack tokens",
    "Stripe live keys",
    "Google API keys",
    "private key blocks",
  ]) {
    assert.ok(doc.includes(kind), `${kind} is not named`);
  }
  assert.ok(doc.includes("[REDACTED SECRET]"));
});

/** The text of one `## ` section of SECURITY.md, without its heading. */
function sectionOf(heading) {
  const start = doc.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `${heading} is missing`);
  const end = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

const report = JSON.parse(
  readFileSync(fromRoot("test/fixtures/insights-review-v1.json"), "utf8"),
);

test("names every field of the report that goes to Insights", () => {
  const section = sectionOf("What is sent to ReviewOps Insights");
  const fields = [
    ...Object.keys(report),
    ...Object.keys(report.tokens),
    ...Object.keys(report.findings[0]),
  ];

  assert.ok(fields.length >= 20);
  for (const field of new Set(fields)) {
    assert.ok(section.includes(`\`${field}\``), `${field} is not named`);
  }
});

test("names no field that the report does not have", () => {
  const whole = sectionOf("What is sent to ReviewOps Insights");
  // The status report has its own list and its own test below.
  const section = whole.slice(0, whole.indexOf("### The status report"));
  const known = new Set([
    ...Object.keys(report),
    ...Object.keys(report.tokens),
    ...Object.keys(report.findings[0]),
  ]);
  // The first three list items name the fields, in backticks.
  const listed = section
    .split("\n")
    .filter((line) => line.startsWith("- the "))
    .flatMap((line) => [...line.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]));
  const fieldLike = listed.filter((name) => /^[a-z][A-Za-z]*$/.test(name));

  assert.ok(fieldLike.length >= 20);
  for (const name of fieldLike) {
    // `owner/name` is a value, `insights-url` an input: neither matches.
    assert.ok(known.has(name), `${name} is no field of the report`);
  }
});

test("says what is never sent to Insights, and that a bad address is checked", () => {
  const section = sectionOf("What is sent to ReviewOps Insights");

  assert.match(section, /Only if the workflow sets the input `insights-url`/);
  assert.match(
    section,
    /What is \*\*never\*\* sent: code, the diff, any text of the model/,
  );
  assert.match(
    section,
    /`https` only \(`http` only for `localhost` and `127\.0\.0\.1`/,
  );
  assert.match(section, /A redirect is never followed and never repeated/);
  assert.match(section, /HMAC-SHA256/);
  assert.match(section, /`X-ReviewOps-Signature`/);
  assert.match(section, /at most three attempts of ten seconds/);
  assert.match(section, /`src\/insights\/send\.js`/);
});

test("says that the address of the API cannot be changed", () => {
  assert.match(doc, /`https:\/\/api\.openai\.com\/v1` and nowhere else/);
  assert.match(doc, /`OPENAI_BASE_URL`/);
});

// --- What the page has to say about forks and events -------------------------

test("says that a green run for a fork is no review", () => {
  assert.match(
    doc,
    /A green run does not mean that the pull request was reviewed/,
  );
  assert.match(doc, /Dependabot/);
  assert.match(doc, /pull_request_target/);
  assert.match(doc, /fork/i);
});

test("describes the posted review and how the texts of the model are shown", () => {
  // The review is posted since #17. Its type and the way the model's text is
  // made safe for Markdown belong on the page.
  assert.doesNotMatch(doc, /posts nothing yet/);
  assert.match(doc, /one review of the type `COMMENT` per run/);
  assert.match(doc, /no link, image or HTML from the model, notifies nobody/);
  assert.match(doc, /`<!-- reviewops -->`/);
});

// --- Reporting and what must not be on the page -----------------------------

test("names the private way to report a vulnerability and no address", () => {
  assert.match(doc, /Report a vulnerability/);
  assert.match(doc, /Do not open a public issue/);
  assert.doesNotMatch(doc, /[\w.+-]+@[\w-]+\.[\w.-]+/, "an e-mail address");
});

test("contains no credential", () => {
  assert.doesNotMatch(
    doc,
    /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY/,
  );
});

test("is a page that a reader can follow", () => {
  const headings = doc.match(/^#{1,3} .+$/gm);

  assert.equal(headings[0], "# Security");
  for (const section of [
    "## Reporting a vulnerability",
    "## What is sent to OpenAI",
    "## What is sent to ReviewOps Insights",
    "## Rights of the workflow",
    "## Events, forks and Dependabot",
    "## What happens with the answer of the model",
    "## What is not in the log",
  ]) {
    assert.ok(headings.includes(section), `${section} is missing`);
  }
});

// --- Nothing from the answer is run or loaded --------------------------------

/** All JavaScript files below a directory, relative to the repository. */
function sourcesIn(directory) {
  return readdirSync(fromRoot(directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourcesIn(path);
      return entry.name.endsWith(".js") ? [path] : [];
    },
  );
}

/** The code of a file without its comments. */
const codeOf = (file) =>
  readFileSync(fromRoot(file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

// The only packages the action loads. A new one is a decision for the
// maintainer: it can make network requests of its own.
const ALLOWED_PACKAGES = [
  "@actions/core",
  "@actions/github",
  "openai",
  "picomatch",
];

// Modules of Node.js itself that have no access to the network. Each one is
// named here on purpose: the fingerprint of a line is a SHA-256 hash.
const ALLOWED_BUILTINS = ["node:crypto"];

const FORBIDDEN = [
  [/\beval\s*\(/, "eval"],
  [/\bnew\s+Function\b|\bFunction\s*\(/, "Function"],
  [/\bnode:vm\b|from\s+["']vm["']/, "vm"],
  [/child_process/, "child_process"],
  [
    /\bnode:(https?|http2|net|tls|dgram|dns|worker_threads|cluster)\b/,
    "a network module",
  ],
  [/\bfetch\s*\(/, "fetch"],
  [/\bXMLHttpRequest\b|\bWebSocket\b/, "a web request"],
  [/\brequire\s*\(/, "require"],
  [/\bprocess\.binding\b|\bprocess\.dlopen\b/, "native code"],
];

// The one file that makes a request of its own: it sends the report to
// ReviewOps Insights, and only if the workflow sets `insights-url` (#76).
const SENDER = "src/insights/send.js";

const isSender = (file) => file.replaceAll("\\", "/") === SENDER;

test("no source file runs anything from the answer or loads anything", () => {
  const files = sourcesIn("src");
  assert.ok(files.length > 10);

  for (const file of files) {
    const code = codeOf(file);
    for (const [pattern, name] of FORBIDDEN) {
      if (name === "fetch" && isSender(file)) continue;
      assert.doesNotMatch(code, pattern, `${file} uses ${name}`);
    }
  }
});

test("only the sender of the report makes a request of its own", () => {
  const callers = sourcesIn("src")
    .filter((file) => /\bfetch\s*\(/.test(codeOf(file)))
    .map((file) => file.replaceAll("\\", "/"));

  assert.deepEqual(callers, [SENDER]);
});

test("the sender takes its address from its caller and builds none", () => {
  const code = codeOf(SENDER);

  // No address in the code, not even the one of Insights itself.
  assert.doesNotMatch(code, /https?:\/\//);
  assert.match(code, /fetch\(url,/);
});

test("no source file imports a package that is not on the list", () => {
  const used = new Set();
  for (const file of sourcesIn("src")) {
    for (const match of codeOf(file).matchAll(/\bfrom\s+"([^"]+)"/g)) {
      if (!match[1].startsWith(".")) used.add(match[1]);
    }
  }

  assert.deepEqual(
    [...used].sort(),
    [...ALLOWED_PACKAGES, ...ALLOWED_BUILTINS].sort(),
  );
});

test("the only dynamic import loads the action itself", () => {
  const found = [];
  for (const file of sourcesIn("src")) {
    for (const match of codeOf(file).matchAll(/\bimport\s*\(([^)]*)\)/g)) {
      // The separator of paths depends on the system the test runs on.
      found.push(`${file.replaceAll("\\", "/")}: ${match[1].trim()}`);
    }
  }

  assert.deepEqual(found, ['src/index.js: "./main.js"']);
});

// --- The status report (#77) ------------------------------------------------

const statusReport = JSON.parse(
  readFileSync(fromRoot("test/fixtures/insights-status-v1.json"), "utf8"),
);

test("names every field of the status report that goes to Insights", () => {
  const section = sectionOf("What is sent to ReviewOps Insights");
  const fields = [
    ...Object.keys(statusReport),
    ...Object.keys(statusReport.findings[0]),
  ];

  assert.ok(fields.length >= 10);
  for (const field of new Set(fields)) {
    assert.ok(section.includes(`\`${field}\``), `${field} is not named`);
  }
});

test("names no field of the status report that it does not have", () => {
  const section = sectionOf("What is sent to ReviewOps Insights");
  const status = section.slice(section.indexOf("### The status report"));
  const known = new Set([
    ...Object.keys(statusReport),
    ...Object.keys(statusReport.findings[0]),
  ]);
  const listed = status
    .split("\n")
    .filter((line) => line.startsWith("- the "))
    .flatMap((line) => [...line.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]));
  const fieldLike = listed.filter((name) => /^[a-z][A-Za-z]*$/.test(name));

  assert.ok(fieldLike.length >= 6);
  for (const name of fieldLike) {
    // The values of `pullRequestState` are values, not fields.
    const values = ["open", "merged", "closed"];
    assert.ok(known.has(name) || values.includes(name), `${name} is no field`);
  }
});

test("says how the status report is addressed, when it is sent and what it never holds", () => {
  const section = sectionOf("What is sent to ReviewOps Insights");

  assert.match(section, /### The status report/);
  assert.match(section, /a path that ends on `\/review` becomes `\/status`/);
  assert.match(section, /at most 1000/);
  assert.match(section, /never a count and never a name/);
  assert.match(section, /who resolved a thread or set a thumbs down/);
  assert.match(section, /the workflow must run on the `closed` event/);
  assert.match(section, /makes no request to GitHub/);
  assert.match(section, /no additional request to GitHub/);
  assert.match(section, /every GitHub user/);
});
