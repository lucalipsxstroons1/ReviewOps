import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNS_PER_CASE,
  judgeRun,
  loadCases,
  looksGerman,
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

// --- looksGerman() -----------------------------------------------------------

const german = {
  summary:
    "Der Effekt wird nicht neu ausgeführt, wenn sich die Nutzer-ID ändert.",
  findings: [
    {
      title: "Abhängigkeit fehlt",
      comment: "Die ID wird im Effekt gelesen, steht aber nicht im Array.",
      suggestion: "Füge userId zum Array hinzu.",
    },
  ],
};

test("recognises German text", () => {
  assert.equal(looksGerman(german), true);
});

test("does not take English text, code or an empty review for German", () => {
  assert.equal(
    looksGerman({
      summary: "The effect is not run again when the user changes.",
      findings: [
        {
          title: "Missing dependency",
          comment: "The id is read inside the effect but is not in the array.",
          suggestion: "Add userId to the array so that it runs again.",
        },
      ],
    }),
    false,
  );
  assert.equal(
    looksGerman({
      summary: "",
      findings: [
        { title: "x", comment: "useEffect(() => {}, [])", suggestion: "" },
      ],
    }),
    false,
  );
  assert.equal(looksGerman({ summary: "", findings: [] }), false);
});

test("needs three different German words, not one word three times", () => {
  assert.equal(
    looksGerman({ summary: "und und und und", findings: [] }),
    false,
  );
  assert.equal(looksGerman({ summary: "und nicht wird", findings: [] }), true);
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
  const result = verdict(
    [row(), row({ clean: true })],
    [{ name: "case", german: true }],
  );

  assert.deepEqual(result, { ok: true, problems: [] });
});

test("names every missed threshold", () => {
  const result = verdict(
    [
      row({ name: "a", passed: 2 }),
      row({
        name: "b",
        clean: true,
        passed: 0,
        errors: ["server", "server", "server"],
      }),
      row({ name: "c", invalid: 1 }),
    ],
    [{ name: "a", german: false }],
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "a: found in 2 of 3 runs",
    "b: clean in 0 of 3 runs",
    "c: 1 invalid findings",
    "a: feedback is not German",
  ]);
});

test("renders the result as a table with the version and the model", () => {
  const rows = [row({ name: "a" }), row({ name: "b", clean: true, passed: 2 })];
  const germanRows = [{ name: "a", german: true }];
  const result = verdict(rows, germanRows);

  const table = renderTable({
    model: "gpt-4o-mini",
    promptVersion: 7,
    rows,
    german: germanRows,
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
  assert.match(table, /\| a \| yes \|/);
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
      const text = request.system.includes("in German")
        ? "Das ist nicht gut, und es wird nicht lange halten."
        : "This is not good.";
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

test("runs every case three times and the cases with a defect once more in German", async () => {
  const calls = [];

  const { rows, german, failures } = await runEvaluation({
    cases,
    ai: goodModel(calls),
  });

  assert.equal(calls.length, cases.length * RUNS_PER_CASE + 4);
  assert.equal(rows.length, 6);
  for (const entry of rows) {
    assert.deepEqual(
      [entry.passed, entry.runs, entry.invalid],
      [3, 3, 0],
      entry.name,
    );
  }
  assert.equal(german.length, 4);
  assert.ok(german.every((entry) => entry.german));
  assert.deepEqual(failures, []);
  assert.equal(verdict(rows, german).ok, true);
});

test("sends the schema, the output limit and the prompt in the language of the run", async () => {
  const calls = [];

  await runEvaluation({ cases, ai: goodModel(calls) });

  for (const call of calls) {
    assert.equal(call.responseFormat, REVIEW_FORMAT);
    assert.equal(call.maxOutputTokens, MAX_OUTPUT_TOKENS);
  }
  const german = calls.filter((call) => call.system.includes("in German"));
  assert.equal(german.length, 4);
  assert.ok(german.every((call) => !byPath(call.user).clean));
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
  assert.equal(verdict(rows, []).ok, false);
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
  assert.equal(verdict(rows, []).ok, false);
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
  const english = failures.filter(
    (entry) => !entry.name.endsWith("(German run)"),
  );

  assert.equal(rows[0].passed, 0);
  assert.equal(english.length, 3);
  assert.match(
    english[0].lines[0],
    /^src\/components\/Profile\.jsx:\d+ minor code-quality SOME-TITLE$/,
  );
  assert.equal(JSON.stringify(english).includes("SUMMARY-TEXT"), false);
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
  const english = failures.filter(
    (entry) => !entry.name.endsWith("(German run)"),
  );

  assert.ok(english.length > 0);
  for (const { lines } of english) {
    for (const line of lines) {
      assert.equal(line.includes("\n"), false);
      assert.equal(line.includes(escape), false);
      assert.match(line, /\\u000a::warning::INJECTED/);
    }
  }
});

test("counts invalid findings of the German run as well", async () => {
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      const isGerman = request.system.includes("in German");
      const good = hit(testCase);
      // Only the German run answers with findings that cannot be comments.
      const findings = isGerman
        ? [
            good,
            hit(testCase, { path: "elsewhere.js" }),
            hit(testCase, { line: 999 }),
            hit(testCase, { suggestion: " " }),
          ]
        : [good];
      const summary = isGerman
        ? "Das ist nicht gut und wird nicht halten."
        : "s";
      return {
        content: JSON.stringify({ summary, findings }),
        finishReason: "stop",
      };
    },
  };

  const { rows, german } = await runEvaluation({ cases: [faultyCase], ai });

  assert.deepEqual([rows[0].passed, rows[0].runs, rows[0].invalid], [3, 3, 3]);
  assert.equal(german[0].german, true);
  assert.deepEqual(verdict(rows, german).problems, [
    `${faultyCase.name}: 3 invalid findings`,
  ]);
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

test("shows the summary and the findings of a German run that is not German, to see why", async () => {
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      const isGerman = request.system.includes("in German");
      return {
        content: JSON.stringify({
          summary: isGerman ? "ENGLISH-SUMMARY-OF-THE-GERMAN-RUN" : "s",
          findings: [hit(testCase, { title: isGerman ? "A-TITLE" : "t" })],
        }),
        finishReason: "stop",
      };
    },
  };

  const { german, failures } = await runEvaluation({ cases: [faultyCase], ai });

  assert.equal(german[0].german, false);
  assert.deepEqual(
    failures.map((entry) => entry.name),
    [`${faultyCase.name} (German run)`],
  );
  assert.equal(
    failures[0].lines[0],
    "summary: ENGLISH-SUMMARY-OF-THE-GERMAN-RUN",
  );
  assert.match(
    failures[0].lines[1],
    /^src\/components\/Profile\.jsx:\d+ major react A-TITLE$/,
  );
});

test("does not show the text of a German run that is German", async () => {
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      const isGerman = request.system.includes("in German");
      return {
        content: JSON.stringify({
          summary: isGerman ? "Das ist nicht gut und wird nicht halten." : "s",
          findings: [hit(testCase)],
        }),
        finishReason: "stop",
      };
    },
  };

  const { failures } = await runEvaluation({ cases: [faultyCase], ai });

  assert.deepEqual(failures, []);
});

test("writes the summary of a German run so that a line break cannot start a workflow command", async () => {
  const ai = {
    async complete(request) {
      const testCase = byPath(request.user);
      const isGerman = request.system.includes("in German");
      return {
        content: JSON.stringify({
          summary: isGerman ? "x\n::error::INJECTED" : "s",
          findings: [hit(testCase)],
        }),
        finishReason: "stop",
      };
    },
  };

  const { failures } = await runEvaluation({ cases: [faultyCase], ai });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].lines[0].includes("\n"), false);
  assert.match(failures[0].lines[0], /\\u000a::error::INJECTED/);
});
