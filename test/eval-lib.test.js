import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNS_PER_CASE,
  judgeRun,
  loadCases,
  missingKeyOutcome,
  renderTable,
  runEvaluation,
  tally,
  verdict,
} from "../eval/lib.mjs";
import { AiError } from "../src/ai/error.js";
import { MAX_OUTPUT_TOKENS, REVIEW_FORMAT } from "../src/ai/schema.js";
import { fromRoot } from "./helpers/run-action.js";

const cases = loadCases(fromRoot("eval/cases"));
const faultyCase = cases.find((c) => c.name === "react-missing-dependency");
const cleanCase = cases.find((c) => c.name === "clean-react");

const finding = (testCase, overrides = {}) => ({
  path: testCase.path,
  line: testCase.commentableLines[0],
  severity: "major",
  category: "code-quality",
  title: "A title",
  comment: "A comment",
  suggestion: "A suggestion",
  ...overrides,
});
const hit = (testCase, overrides = {}) =>
  finding(testCase, {
    line: testCase.expect.lines[0],
    category: testCase.expect.category,
    ...overrides,
  });
const review = (...findings) => ({ summary: "s", findings });

// --- judgeRun() --------------------------------------------------------------

test("takes a finding with the right path, line, category and severity as found", () => {
  assert.deepEqual(judgeRun(faultyCase, review(hit(faultyCase))), {
    ok: true,
    invalid: 0,
  });
});

test("takes every line of the expected set and a higher severity as found", () => {
  for (const line of faultyCase.expect.lines) {
    assert.equal(
      judgeRun(faultyCase, review(hit(faultyCase, { line }))).ok,
      true,
    );
  }
  assert.equal(
    judgeRun(faultyCase, review(hit(faultyCase, { severity: "critical" }))).ok,
    true,
  );
});

for (const [name, overrides] of [
  ["another path", { path: "src/other.jsx" }],
  [
    "a line outside of the expected set",
    { line: faultyCase.commentableLines.at(-1) + 50 },
  ],
  ["another category", { category: "security" }],
  ["a severity below the minimum", { severity: "minor" }],
  ["the lowest severity", { severity: "info" }],
]) {
  test(`does not take a finding with ${name} as found`, () => {
    assert.equal(
      judgeRun(faultyCase, review(hit(faultyCase, overrides))).ok,
      false,
    );
  });
}

test("does not take an answer without findings as found", () => {
  assert.equal(judgeRun(faultyCase, review()).ok, false);
});

test("finds the defect among other findings", () => {
  const result = judgeRun(
    faultyCase,
    review(finding(faultyCase, { severity: "info" }), hit(faultyCase)),
  );

  assert.equal(result.ok, true);
});

test("counts findings that cannot become a comment as invalid", () => {
  const notAdded = Math.max(...faultyCase.commentableLines) + 100;
  const result = judgeRun(
    faultyCase,
    review(
      hit(faultyCase),
      hit(faultyCase, { path: "src/other.jsx" }),
      hit(faultyCase, { line: notAdded }),
      hit(faultyCase, { suggestion: "" }),
      hit(faultyCase, { suggestion: "  \n " }),
    ),
  );

  assert.deepEqual(result, { ok: true, invalid: 4 });
});

test("takes a clean diff without findings, or with small ones, as clean", () => {
  assert.equal(judgeRun(cleanCase, review()).ok, true);
  assert.equal(
    judgeRun(
      cleanCase,
      review(
        finding(cleanCase, { severity: "minor" }),
        finding(cleanCase, { severity: "info" }),
      ),
    ).ok,
    true,
  );
});

test("does not take a clean diff with a major or critical finding as clean", () => {
  for (const severity of ["major", "critical"]) {
    assert.equal(
      judgeRun(cleanCase, review(finding(cleanCase, { severity }))).ok,
      false,
    );
  }
});

test("also counts invalid findings on a clean diff", () => {
  const result = judgeRun(
    cleanCase,
    review(finding(cleanCase, { severity: "info", path: "elsewhere.js" })),
  );

  assert.deepEqual(result, { ok: true, invalid: 1 });
});

// --- tally() and verdict() ---------------------------------------------------

test("counts passed runs, invalid findings and errors, and never takes an error as a pass", () => {
  assert.deepEqual(
    tally([
      { ok: true, invalid: 0 },
      { ok: false, invalid: 2 },
      { error: "server" },
    ]),
    { passed: 1, runs: 3, invalid: 2, errors: ["server"] },
  );
});

const row = (overrides = {}) => ({
  name: "case",
  clean: false,
  passed: 3,
  runs: 3,
  invalid: 0,
  errors: [],
  ...overrides,
});

test("meets the thresholds when every case passes 3 of 3 and nothing is invalid", () => {
  const result = verdict([row(), row({ clean: true })]);

  assert.deepEqual(result, { ok: true, problems: [] });
});

test("names every missed threshold", () => {
  const result = verdict([
    row({ name: "a", passed: 2 }),
    row({
      name: "b",
      clean: true,
      passed: 0,
      errors: ["server", "server", "server"],
    }),
    row({ name: "c", invalid: 1 }),
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "a: found in 2 of 3 runs",
    "b: clean in 0 of 3 runs",
    "c: 1 invalid findings",
  ]);
});

test("renders the result as a table with the version and the model", () => {
  const rows = [row({ name: "a" }), row({ name: "b", clean: true, passed: 2 })];
  const result = verdict(rows);

  const table = renderTable({
    model: "gpt-4o-mini",
    promptVersion: 7,
    rows,
    result,
  });

  assert.match(
    table,
    /^## Prompt evaluation \(prompt version 7, model gpt-4o-mini\)/,
  );
  assert.match(
    table,
    /\| a \| finding of the expected kind \| 3\/3 \| 0 \| 0 \|/,
  );
  assert.match(
    table,
    /\| b \| no finding of major or higher \| 2\/3 \| 0 \| 0 \|/,
  );
  assert.doesNotMatch(table, /German/);
  assert.match(table, /Result: thresholds missed\./);
  assert.match(table, /- b: clean in 2 of 3 runs/);
});

// --- runEvaluation() ---------------------------------------------------------

const byPath = (user) =>
  cases.find((c) => user.startsWith(`File: ${c.path}\n`));

/** A model that finds every defect and is silent on clean code. */
function goodModel(calls) {
  return {
    async complete(request) {
      calls.push(request);
      const testCase = byPath(request.user);
      const text = "This is not good.";
      const findings = testCase.clean
        ? []
        : [hit(testCase, { comment: text, title: text, suggestion: text })];
      return {
        content: JSON.stringify({ summary: text, findings }),
        finishReason: "stop",
      };
    },
  };
}

test("runs every case three times", async () => {
  const calls = [];

  const { rows, failures } = await runEvaluation({
    cases,
    ai: goodModel(calls),
  });

  assert.equal(calls.length, cases.length * RUNS_PER_CASE);
  assert.equal(rows.length, 6);
  for (const entry of rows) {
    assert.deepEqual(
      [entry.passed, entry.runs, entry.invalid],
      [3, 3, 0],
      entry.name,
    );
  }
  assert.deepEqual(failures, []);
  assert.equal(verdict(rows).ok, true);
});

test("sends the schema, the output limit and the English prompt", async () => {
  const calls = [];

  await runEvaluation({ cases, ai: goodModel(calls) });

  for (const call of calls) {
    assert.equal(call.responseFormat, REVIEW_FORMAT);
    assert.equal(call.maxOutputTokens, MAX_OUTPUT_TOKENS);
  }
  for (const call of calls) {
    assert.match(call.system, /in English\. Do not write any of them/);
  }
});

test("never takes an error as a pass, also not on a clean diff", async () => {
  const ai = {
    async complete(request) {
      if (byPath(request.user) === cleanCase)
        throw new AiError("server", "down");
      return goodModel([]).complete(request);
    },
  };

  const { rows } = await runEvaluation({ cases, ai });

  const entry = rows.find((r) => r.name === cleanCase.name);
  assert.deepEqual(
    [entry.passed, entry.errors],
    [0, ["server", "server", "server"]],
  );
  assert.equal(verdict(rows).ok, false);
});

test("takes a cut-off answer as an error of the run, not as no findings", async () => {
  const ai = {
    async complete() {
      return { content: '{"summary": "s", "find', finishReason: "length" };
    },
  };

  const { rows } = await runEvaluation({ cases: [cleanCase], ai });

  assert.deepEqual(
    [rows[0].passed, rows[0].errors],
    [0, ["truncated", "truncated", "truncated"]],
  );
});

test("stops after an error that repeats for every request", async () => {
  let calls = 0;
  const ai = {
    async complete() {
      calls += 1;
      throw new AiError("auth", "rejected");
    },
  };

  const { rows } = await runEvaluation({ cases, ai, concurrency: 1 });

  assert.equal(calls, 1);
  assert.equal(
    rows.every((entry) => entry.passed === 0),
    true,
  );
  assert.equal(
    rows.flatMap((entry) => entry.errors).includes("not started"),
    true,
  );
  assert.equal(verdict(rows).ok, false);
});

test("reports a run that missed its expectation with the findings, not the whole answer", async () => {
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      const findings =
        testCase === faultyCase
          ? [finding(testCase, { severity: "minor", title: "SOME-TITLE" })]
          : [];
      return {
        content: JSON.stringify({ summary: "SUMMARY-TEXT", findings }),
        finishReason: "stop",
      };
    },
  };

  const { rows, failures } = await runEvaluation({ cases: [faultyCase], ai });

  assert.equal(rows[0].passed, 0);
  assert.equal(failures.length, 3);
  assert.match(
    failures[0].lines[0],
    /^src\/components\/Profile\.jsx:\d+ minor code-quality SOME-TITLE$/,
  );
  assert.equal(JSON.stringify(failures).includes("SUMMARY-TEXT"), false);
});

test("passes on an error that is not an error of the client", async () => {
  const ai = {
    async complete() {
      throw new TypeError("a defect");
    },
  };

  await assert.rejects(runEvaluation({ cases: [cleanCase], ai }), TypeError);
});

test("writes path and title of a finding so that a line break cannot start a workflow command", async () => {
  const escape = String.fromCodePoint(0x1b);
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      const bad = finding(testCase, {
        severity: "minor",
        title: `T\n::warning::INJECTED${escape}[31m`,
        path: `${testCase.path}\n::error::INJECTED`,
      });
      return {
        content: JSON.stringify({ summary: "s", findings: [bad] }),
        finishReason: "stop",
      };
    },
  };

  const { failures } = await runEvaluation({ cases: [faultyCase], ai });
  assert.ok(failures.length > 0);
  for (const { lines } of failures) {
    for (const line of lines) {
      assert.equal(line.includes("\n"), false);
      assert.equal(line.includes(escape), false);
      assert.match(line, /\\u000a::warning::INJECTED/);
    }
  }
});

// --- missingKeyOutcome() -----------------------------------------------------

test("skips the evaluation without a key only in a pull request, which a fork gets no secrets for", () => {
  assert.equal(
    missingKeyOutcome({ GITHUB_EVENT_NAME: "pull_request" }),
    "skip",
  );
});

test("fails without a key in a run by hand, on a push and on a machine", () => {
  for (const env of [
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_EVENT_NAME: "" },
    {},
  ]) {
    assert.equal(missingKeyOutcome(env), "fail", JSON.stringify(env));
  }
});

test("counts invalid findings of every run and names them in the verdict", async () => {
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      const findings = [
        hit(testCase),
        hit(testCase, { path: "elsewhere.js" }),
        hit(testCase, { line: 999 }),
        hit(testCase, { suggestion: " " }),
      ];
      return {
        content: JSON.stringify({ summary: "s", findings }),
        finishReason: "stop",
      };
    },
  };

  const { rows } = await runEvaluation({ cases: [faultyCase], ai });

  assert.deepEqual([rows[0].passed, rows[0].invalid], [3, 9]);
  assert.deepEqual(verdict(rows).problems, [
    `${faultyCase.name}: 9 invalid findings`,
  ]);
});
